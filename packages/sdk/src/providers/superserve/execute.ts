import { guestSpec } from "../freestyle/wire.js";
import type { ExecInput, ExecResult } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { guestProcess, python, quote } from "../boxd/guest.js";
import { failure } from "./errors.js";
export const supervisorPath = "/var/lib/sandbox-sdk-exec-v2.py";
// The one-shot launcher travels in the native exec request. Small results
// return inline; large output uses bounded native ranged reads.
export const supervisor = `import os,sys,marshal,_signal as signal,select,time,fcntl
${guestProcess}
root=sys.argv[1]
v=marshal.loads(bytes.fromhex(sys.argv[2])) if len(sys.argv)>2 else marshal.loads(bytes.fromhex(sys.stdin.read()))
if 'envKeys' in v: v['env']={k:os.environ[k] for k in v['envKeys']}
os.makedirs(root,mode=0o700,exist_ok=True)
# Keep small completed responses until their request deadline has passed.
# Sweep expired responses inline, so no ack RPC or background daemon is needed.
for entry in os.scandir(os.path.dirname(root)):
 if not entry.name.startswith('run-') or entry.path==root: continue
 try:
  with open(entry.path+'/expires') as f: expired=time.time()>float(f.read())
  if expired:
   import shutil
   shutil.rmtree(entry.path,ignore_errors=True)
 except (FileNotFoundError,NotADirectoryError): pass
a=v.get('activityPath')
timed=False
code=127
try:
 if a:
  os.makedirs(os.path.dirname(a),exist_ok=True)
  with open(a,'w') as f: f.write('1')
 try:
  with open('/var/lib/sandbox-sdk-env.json') as f:
   import json
   saved=json.load(f)
 except FileNotFoundError: saved={}
 if os.environ.get('SANDBOX_SDK_BOOTSTRAP') not in (None,'{}'):
  bootstrap=os.environ.pop('SANDBOX_SDK_BOOTSTRAP')
  if bootstrap=='{"env":{}}': initial={}
  else:
   import json
   initial=json.loads(bootstrap).get('env')
  if initial is not None: saved=initial
  if initial is not None and (initial or os.path.exists('/var/lib/sandbox-sdk-env.json')):
   import json
   os.makedirs(os.path.dirname('/var/lib/sandbox-sdk-env.json'),exist_ok=True)
   tmp='/var/lib/sandbox-sdk-env.json.'+str(os.getpid())
   fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'w') as f: json.dump(saved,f)
   os.replace(tmp,'/var/lib/sandbox-sdk-env.json')
 env={**os.environ,**saved,**v['env']}
 with stdin_file() as f, open(root+'/out','wb',buffering=0) as out:
  f.write(v.get('stdin','').encode()); f.seek(0)
  with open(root+'/lock','w') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   if os.path.exists(root+'/cancelled'): timed=True; p=None
   else:
    try: p=Process(v,env,f,True)
    except OSError as e:
     out.write(('["stderr","'+str(e).encode().hex()+'"]\\n').encode()); p=None
   if p:
    with open(root+'/pid','w') as m: m.write(str(p.pid))
  if p:
   stdout=p.stdout.fileno(); streams={stdout:'stdout',p.stderr.fileno():'stderr'}
   end=time.monotonic()+v['timeoutMs']/1000
   while streams or p.poll() is None:
    if not timed and time.monotonic()>=end:
     timed=True
     try: os.killpg(p.pid,signal.SIGKILL)
     except ProcessLookupError: pass
    for fd in select.select(list(streams),[],[],.01)[0]:
     data=os.read(fd,8192)
     if data: out.write(('["'+streams[fd]+'","'+data.hex()+'"]\\n').encode())
     else: del streams[fd]; (p.stdout if fd==stdout else p.stderr).close()
   code=p.wait()
  timed=timed or os.path.exists(root+'/cancelled')
 result='{"exitCode":%s,"timedOut":%s}'%('null' if timed else str(code if code>=0 else 128-code),str(timed).lower())
 with open(root+'/exit','w') as f: f.write(result)
 size=os.path.getsize(root+'/out')
 with open(root+'/out','rb') as f:
  chunks=[line.decode().strip() for _,line in zip(range(3),f)]
  offset=f.tell()
 if offset==size and not timed:
  with open(root+'/expires','w') as f: f.write(str(time.time()+v['timeoutMs']/1000+5))
 if timed and not p:
  import shutil
  shutil.rmtree(root)
 print('{"result":%s,"chunks":[%s],"offset":%d,"size":%d}'%(result,','.join(chunks),offset,size))
finally:
 if a:
  try: os.unlink(a)
  except FileNotFoundError: pass
`;
export interface ExecutionGuest {
  exec(command: string, stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
  run?(command: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<string>;
  raw(command: string): Promise<string>;
  read(
    path: string,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}
export async function execute(g: ExecutionGuest, input: ExecInput): Promise<ExecResult> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const root = `/tmp/.sandbox-sdk/run-${crypto.randomUUID()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  let delivered = 0;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  async function cancel() {
    // The lock makes cancellation safe even if the exec has not started yet.
    // No PID means no process to kill, not permission to delete the whole VM.
    const text = await g.raw(
      python(
        `import os,sys,fcntl,signal,shutil,time,json
root=sys.argv[1]
os.makedirs(root,mode=0o700,exist_ok=True)
with open(root+'/lock','w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 with open(root+'/cancelled','w') as f: f.write('1')
 try:
  with open(root+'/pid') as f: pid=int(f.read())
 except FileNotFoundError: pid=None
 if pid and not os.path.exists(root+'/exit'):
  try: os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError: pass
# Wait for reaping and pipe drainage before recovering the bounded output tail.
end=time.monotonic()+2
while pid and not os.path.exists(root+'/exit') and time.monotonic()<end: time.sleep(.01)
if pid and not os.path.exists(root+'/exit'): sys.exit(1)
chunks=[]
start=int(sys.argv[2])
try:
 with open(root+'/out','rb') as f:
  size=os.fstat(f.fileno()).st_size
  delivered=int(sys.argv[2])
  start=max(delivered,size-65536); f.seek(start)
  if start>delivered: f.readline(); start=f.tell()
  chunks=[json.loads(line) for line in f]
except FileNotFoundError: pass
print(json.dumps(dict(chunks=chunks,offset=start)))
# Retain a tombstone if a delayed supervisor can still arrive.
if pid: shutil.rmtree(root,ignore_errors=True)`,
        root,
        String(delivered),
      ),
    );
    const recovery: unknown = JSON.parse(text);
    if (
      !recovery ||
      typeof recovery !== "object" ||
      !("chunks" in recovery) ||
      !Array.isArray(recovery.chunks) ||
      recovery.chunks.length > 65536 ||
      !("offset" in recovery) ||
      typeof recovery.offset !== "number" ||
      !Number.isSafeInteger(recovery.offset) ||
      recovery.offset < delivered
    )
      throw failure("Invalid cancellation output");
    // A contiguous recovery must retain partial UTF-8 bytes. If the bounded
    // tail skipped records, flush them before starting a new decoding segment.
    if (recovery.offset !== delivered) flush(decoders, input);
    for (const chunk of recovery.chunks) emitRecord(chunk, decoders, input);
    flush(decoders, input);
  }

  let paged = false;
  async function recoverCancellation(): Promise<ExecResult> {
    try {
      await cancel();
    } catch {
      throw failure("Process cancellation could not be confirmed", "outcome_unknown");
    }
    paged = false;
    return { exitCode: null, timedOut: true };
  }
  try {
    let text: string;
    try {
      const spec = {
        command: input.command, cwd: input.cwd, timeoutMs: input.timeoutMs,
        activityPath: input.activityPath,
      };
      const oneShot = guestSpec({ ...spec, envKeys: Object.keys(input.env) }).toString("hex");
      const command = `python3 -S -c ${quote(supervisor)} ${quote(root)} ${quote(oneShot)}`;
      if (g.run && input.stdin === undefined && Buffer.byteLength(command) < 96 * 1024)
        text = await g.run(command, input.env, input.timeoutMs + 5000, signal);
      else
        text = await g.exec(
          `python3 -S -c ${quote(supervisor)} ${quote(root)}`,
          guestSpec({ ...spec, env: input.env, stdin: input.stdin ?? "" }).toString("hex"),
          input.timeoutMs + 5000, signal,
        );
    } catch (error) {
      // A rejected bootstrap (such as a template without Python) runs nothing,
      // so there is no process to cancel and the actionable error must surface.
      if (error instanceof SandboxError && error.code === "unsupported") throw error;
      try {
        await cancel();
      } catch {
        throw failure("Process cancellation could not be confirmed", "outcome_unknown");
      }
      if (signal.aborted) return { exitCode: null, timedOut: true };
      throw error;
    }
    const page: unknown = JSON.parse(text);
    if (
      !page ||
      typeof page !== "object" ||
      !("result" in page) ||
      !page.result ||
      typeof page.result !== "object" ||
      !("exitCode" in page.result) ||
      (page.result.exitCode !== null && typeof page.result.exitCode !== "number") ||
      !("timedOut" in page.result) ||
      typeof page.result.timedOut !== "boolean" ||
      !("chunks" in page) ||
      !Array.isArray(page.chunks) ||
      page.chunks.length > 3 ||
      !("offset" in page) ||
      typeof page.offset !== "number" ||
      !Number.isSafeInteger(page.offset) ||
      page.offset < 0 ||
      !("size" in page) ||
      typeof page.size !== "number" ||
      !Number.isSafeInteger(page.size) ||
      page.size < page.offset
    )
      throw failure("Invalid command response");
    const emit = (value: unknown) => emitRecord(value, decoders, input);
    paged = page.offset < page.size || page.result.timedOut;
    if (signal.aborted) return await recoverCancellation();
    page.chunks.forEach(emit);
    delivered = page.offset;
    let offset = page.offset;
    let pending = "";
    while (offset < page.size) {
      if (signal.aborted) return await recoverCancellation();
      let data: Uint8Array;
      try {
        data = await g.read(
          root + "/out",
          { offset, length: Math.min(65536, page.size - offset) },
          signal,
        );
      } catch (error) {
        if (signal.aborted) return await recoverCancellation();
        throw error;
      }
      if (signal.aborted) return await recoverCancellation();
      if (!data.length) throw failure("Incomplete output read");
      offset += data.length;
      pending += new TextDecoder().decode(data);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach((line) => {
        emit(JSON.parse(line));
        delivered += Buffer.byteLength(line) + 1;
      });
    }
    if (pending) throw failure("Incomplete output record");
    flush(decoders, input);
    return { exitCode: page.result.exitCode, timedOut: page.result.timedOut };
  } finally {
    clearTimeout(timer);
    if (paged) await g.raw(`rm -rf -- ${quote(root)}`).catch(() => {});
  }
}

function emitRecord(
  value: unknown,
  decoders: { stdout: TextDecoder; stderr: TextDecoder },
  input: ExecInput,
) {
  if (
    !Array.isArray(value) ||
    (value[0] !== "stdout" && value[0] !== "stderr") ||
    typeof value[1] !== "string" ||
    value[1].length > 21848
  )
    throw failure("Invalid output record");
  const stream = value[0] === "stdout" ? "stdout" : "stderr";
  const text = decoders[stream].decode(Buffer.from(value[1], "hex"), { stream: true });
  if (text) input.onChunk({ stream, text });
}

function flush(decoders: { stdout: TextDecoder; stderr: TextDecoder }, input: ExecInput) {
  for (const stream of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) {
    const text = decoders[stream].decode();
    if (text) input.onChunk({ stream, text });
  }
}
