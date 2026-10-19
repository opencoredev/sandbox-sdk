import type { ExecInput, ExecResult } from "../../provider.js";
import { python, quote } from "../boxd/guest.js";
import { failure } from "./errors.js";
export const supervisorPath = "/var/lib/sandbox-sdk-exec-v2.py";
// Installed once on create/connect. Each command sends its spec through native
// stdin. Small results return in the same exec; large output stays on guest disk
// and is fetched with native ranged reads, never buffered in an exec response.
export const supervisor = `import os,sys,json,base64,subprocess,signal,selectors,time,tempfile,fcntl,shutil
root=sys.argv[1]
v=json.load(sys.stdin)
os.makedirs(root,mode=0o700,exist_ok=True)
a=v.get('activityPath')
timed=False
code=127
try:
 if a:
  os.makedirs(os.path.dirname(a),exist_ok=True)
  with open(a,'w') as f: f.write('1')
 with open('/var/lib/sandbox-sdk-env.json') as f: env={**os.environ,**json.load(f),**v['env']}
 with tempfile.TemporaryFile() as f, open(root+'/out','wb',buffering=0) as out:
  f.write(v.get('stdin','').encode()); f.seek(0)
  with open(root+'/lock','w') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   if os.path.exists(root+'/cancelled'): timed=True; p=None
   else:
    try: p=subprocess.Popen(['sh','-c',v['command']],cwd=v['cwd'],env=env,stdin=f,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    except OSError as e:
     out.write((json.dumps(['stderr',base64.b64encode(str(e).encode()).decode()])+'\\n').encode()); p=None
   if p:
    with open(root+'/pid','w') as m: m.write(str(p.pid))
  if p:
   sel=selectors.DefaultSelector()
   sel.register(p.stdout,selectors.EVENT_READ,'stdout'); sel.register(p.stderr,selectors.EVENT_READ,'stderr')
   end=time.monotonic()+v['timeoutMs']/1000
   while sel.get_map() or p.poll() is None:
    if not timed and time.monotonic()>=end:
     timed=True
     try: os.killpg(p.pid,signal.SIGKILL)
     except ProcessLookupError: pass
    for key,_ in sel.select(.01):
     data=os.read(key.fd,16384)
     if data: out.write((json.dumps([key.data,base64.b64encode(data).decode()])+'\\n').encode())
     else: sel.unregister(key.fileobj); key.fileobj.close()
   code=p.wait()
  timed=timed or os.path.exists(root+'/cancelled')
 result=dict(exitCode=None if timed else (code if code>=0 else 128-code),timedOut=timed)
 with open(root+'/exit','w') as f: json.dump(result,f)
 size=os.path.getsize(root+'/out')
 with open(root+'/out','rb') as f:
  chunks=[json.loads(line) for _,line in zip(range(3),f)]
  offset=f.tell()
 if offset==size or os.path.exists(root+'/cancelled'): shutil.rmtree(root)
 print(json.dumps(dict(result=result,chunks=chunks,offset=offset,size=size)))
finally:
 if a:
  try: os.unlink(a)
  except FileNotFoundError: pass
`;
export interface ExecutionGuest {
  exec(command: string, stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
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
  async function cancel() {
    // The lock makes cancellation safe even if the exec has not started yet.
    // No PID means no process to kill, not permission to delete the whole VM.
    await g.raw(
      python(
        `import os,sys,fcntl,signal,shutil
root=sys.argv[1]
os.makedirs(root,mode=0o700,exist_ok=True)
with open(root+'/lock','w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 with open(root+'/cancelled','w') as f: f.write('1')
 try:
  with open(root+'/pid') as f: pid=int(f.read())
 except FileNotFoundError: pid=None
 if os.path.exists(root+'/exit'):
  pid=None; shutil.rmtree(root)
 if pid:
  try: os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError: pass`,
        root,
      ),
    );
  }
  let paged = false;
  try {
    let text: string;
    try {
      text = await g.exec(
        `python3 ${quote(supervisorPath)} ${quote(root)}`,
        JSON.stringify({
          command: input.command,
          env: input.env,
          cwd: input.cwd,
          stdin: input.stdin ?? "",
          timeoutMs: input.timeoutMs,
          activityPath: input.activityPath,
        }),
        input.timeoutMs + 5000,
        signal,
      );
    } catch (error) {
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
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    function emit(value: unknown) {
      if (
        !Array.isArray(value) ||
        (value[0] !== "stdout" && value[0] !== "stderr") ||
        typeof value[1] !== "string" ||
        value[1].length > 21848
      )
        throw failure("Invalid output record");
      const stream = value[0] === "stdout" ? "stdout" : "stderr";
      const text = decoders[stream].decode(Buffer.from(value[1], "base64"), { stream: true });
      if (text) input.onChunk({ stream, text });
    }
    paged = page.offset < page.size;
    if (signal.aborted) return { exitCode: null, timedOut: true };
    page.chunks.forEach(emit);
    let offset = page.offset;
    let pending = "";
    while (offset < page.size) {
      if (signal.aborted) return { exitCode: null, timedOut: true };
      let data: Uint8Array;
      try {
        data = await g.read(
          root + "/out",
          { offset, length: Math.min(65536, page.size - offset) },
          signal,
        );
      } catch (error) {
        if (signal.aborted) return { exitCode: null, timedOut: true };
        throw error;
      }
      if (signal.aborted) return { exitCode: null, timedOut: true };
      if (!data.length) throw failure("Incomplete output read");
      offset += data.length;
      pending += new TextDecoder().decode(data);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach((line) => emit(JSON.parse(line)));
    }
    if (pending) throw failure("Incomplete output record");
    for (const stream of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) {
      const text = decoders[stream].decode();
      if (text) input.onChunk({ stream, text });
    }
    return { exitCode: page.result.exitCode, timedOut: page.result.timedOut };
  } finally {
    clearTimeout(timer);
    if (paged) await g.raw(`rm -rf -- ${quote(root)}`).catch(() => {});
  }
}
