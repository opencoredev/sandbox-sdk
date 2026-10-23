import { guestProcess } from "../boxd/guest.js";
import type { Session } from "@tenkicloud/sandbox";
import type { ExecInput } from "../../provider.js";
import { deadline } from "./deadline.js";
import { failure } from "./errors.js";
import { executeStream } from "./stream.js";
import { workspaceSetup } from "./ready.js";

/** Python is included in Tenki's base image. Privileged run is necessary because
 * the guest file API rejects paths outside /home/tenki, including /workspace.
 * A guest supervisor owns the timeout and process group, even if I/O disconnects.
 */
// Never send user output through native run(): Tenki 1.4.1 retains every chunk.
// One guest spool preserves stdout/stderr arrival order; each RPC reads <=3 records.
const supervisor = `import os,sys,json,base64,signal,selectors,time,pwd
${guestProcess}
v=json.load(sys.stdin)
${workspaceSetup}
def processes():
 ids=set()
 for e in os.scandir('/proc'):
  if not e.name.isdecimal(): continue
  try: ids.add((e.name,e.inode()))
  except FileNotFoundError: continue
  if len(ids)>4096: return None
 return ids
before=processes()
def stable():
 after=processes()
 return before is not None and after is not None and after.issubset(before)
env={**os.environ,**v['env'],'PWD':v['cwd']}
if os.geteuid()==0 and 'SUDO_UID' not in env:
 try: env['SUDO_UID']=str(pwd.getpwnam('tenki').pw_uid)
 except KeyError: pass
try:
 with stdin_file() as f, open(v['marker']+'.out','wb',buffering=0) as out:
  f.write(base64.b64decode(v['stdin'])); f.seek(0)
  p=Process(v,env,f,True)
  with open(v['marker'],'w') as m: m.write(str(p.pid))
  if v.get('activityPath'):
   os.makedirs(os.path.dirname(v['activityPath']),exist_ok=True)
   with open(v['activityPath'],'w') as a: a.write('1')
  sel=selectors.DefaultSelector()
  sel.register(p.stdout,selectors.EVENT_READ,'stdout'); sel.register(p.stderr,selectors.EVENT_READ,'stderr')
  end=time.monotonic()+v['timeoutMs']/1000
  timed=False
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
  with open(v['marker']+'.exit','w') as m: json.dump({'exitCode':None if timed else (code if code>=0 else 128-code),'timedOut':timed,'workspaceStable':stable(),'workspaceRoot':os.path.realpath(v['workspace'])},m)
finally:
 if v.get('activityPath'):
  try: os.unlink(v['activityPath'])
  except FileNotFoundError: pass
`;
const page = `import sys,json
pos=int(sys.argv[2]); chunks=[]
try:
 with open(sys.argv[1],'rb') as f:
  f.seek(pos)
  for _ in range(3):
   line=f.readline(24000)
   if not line.endswith(b'\\n'): break
   chunks.append(json.loads(line)); pos=f.tell()
except FileNotFoundError: pass
print(json.dumps({'offset':pos,'chunks':chunks}))
`;
export async function raw(
  box: Session,
  argv: string[],
  stdin?: Uint8Array,
  timeoutMs = 30_000,
  signal?: AbortSignal,
) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stdin) controller.enqueue(stdin);
      controller.close();
    },
  });
  const result = await deadline(
    (signal) => box.run(argv, { privileged: true, stdin: stream, timeoutMs, signal }),
    timeoutMs,
    signal,
  );
  if (result.exitCode !== 0 || result.timedOut)
    throw failure("Guest operation failed", result.timedOut ? "timeout" : "provider");
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.stdout);
}
export async function execute(
  box: Session,
  input: ExecInput,
  workspaceRoot?: (root: string, stable: boolean) => void,
) {
  if (typeof box.requireDataPlane === "function") return executeStream(box, input, workspaceRoot);
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const marker = `/home/tenki/.sandbox-sdk-run-${crypto.randomUUID()}`;
  const spec = Buffer.from(
    JSON.stringify({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      stdin: Buffer.from(input.stdin ?? "").toString("base64"),
      timeoutMs: input.timeoutMs,
      marker,
      activityPath: input.activityPath,
      workspace: "/workspace",
    }),
  );
  let cancelled = false;
  let cancel = () => {};
  const cancellation = new Promise<"cancelled">((resolve) => {
    cancel = () => {
      cancelled = true;
      resolve("cancelled");
    };
  });
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, input.timeoutMs);
  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(spec);
      controller.close();
    },
  });
  const transport = new AbortController();
  const handle = box.run(["python3", "-S", "-c", supervisor], {
    privileged: true,
    stdin,
    signal: transport.signal,
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  async function drain(stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr") {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const reader = stream.getReader();
    readers.push(reader);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) input.onChunk({ stream: kind, text });
      }
    } finally {
      reader.releaseLock();
    }
    const text = decoder.decode();
    if (text) input.onChunk({ stream: kind, text });
  }
  let finished = false;
  const outputTransport = new AbortController();
  const native = Promise.resolve(handle).finally(() => {
    finished = true;
  });
  async function output() {
    let offset = 0;
    const decoders = {
      stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
      stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
    };
    while (!outputTransport.signal.aborted) {
      const wasFinished = finished;
      const value: unknown = JSON.parse(
        await raw(
          box,
          ["python3", "-c", page, `${marker}.out`, String(offset)],
          undefined,
          30_000,
          outputTransport.signal,
        ),
      );
      if (
        !value ||
        typeof value !== "object" ||
        !("offset" in value) ||
        typeof value.offset !== "number" ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < offset ||
        !("chunks" in value) ||
        !Array.isArray(value.chunks) ||
        value.chunks.length > 3
      )
        throw failure("Invalid output page");
      const previous = offset;
      offset = value.offset;
      for (const chunk of value.chunks) {
        if (
          !Array.isArray(chunk) ||
          chunk.length !== 2 ||
          (chunk[0] !== "stdout" && chunk[0] !== "stderr") ||
          typeof chunk[1] !== "string" ||
          chunk[1].length > 21848
        )
          throw failure("Invalid output chunk");
        const stream = chunk[0] === "stdout" ? "stdout" : "stderr";
        const text = decoders[stream].decode(Buffer.from(chunk[1], "base64"), { stream: true });
        if (text && !outputTransport.signal.aborted) input.onChunk({ stream, text });
      }
      if (offset === previous) {
        if (wasFinished) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    for (const stream of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) {
      const text = decoders[stream].decode();
      if (text && !outputTransport.signal.aborted) input.onChunk({ stream, text });
    }
  }
  const completion = Promise.all([
    native,
    drain(handle.stdout, "stdout"),
    drain(handle.stderr, "stderr"),
    output(),
  ]).then(async () => {
    const value: unknown = JSON.parse(
      await raw(box, ["cat", `${marker}.exit`], undefined, 30_000, outputTransport.signal),
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("exitCode" in value) ||
      !("timedOut" in value) ||
      (value.exitCode !== null && typeof value.exitCode !== "number") ||
      typeof value.timedOut !== "boolean"
    )
      throw failure("Invalid command result");
    if ("workspaceRoot" in value && typeof value.workspaceRoot === "string")
      workspaceRoot?.(
        value.workspaceRoot,
        "workspaceStable" in value && value.workspaceStable === true,
      );
    return { exitCode: value.exitCode, timedOut: value.timedOut };
  });
  void completion.catch(() => {});
  async function killGroup() {
    // Poll after launch: cancellation may arrive before the guest publishes its PID.
    await raw(
      box,
      [
        "python3",
        "-c",
        `import os,sys,time,signal
p=sys.argv[1]
for _ in range(3000):
 try:
  with open(p) as f: pid=int(f.read())
  break
 except (FileNotFoundError,ValueError): time.sleep(.01)
else: raise RuntimeError('PID unavailable')
try: os.killpg(pid,signal.SIGKILL)
except ProcessLookupError: pass`,
        marker,
      ],
      undefined,
      1000,
    );
  }
  try {
    if (input.signal?.aborted) cancel();
    const result = cancelled ? "cancelled" : await Promise.race([completion, cancellation]);
    if (result === "cancelled") {
      try {
        await killGroup();
      } catch {
        await deadline(() => box.close(), 1000).catch(() => {});
        throw failure(
          "Process cancellation could not be confirmed; VM termination was requested",
          "outcome_unknown",
        );
      }
      await deadline(() => completion, 250).catch(() => {});
      transport.abort();
      for (const reader of readers) void reader.cancel().catch(() => {});
      return { exitCode: null, timedOut: true };
    }
    return result;
  } catch (error) {
    // A failed stream cannot leave user code running after the caller sees failure.
    try {
      await killGroup();
    } catch {
      await deadline(() => box.close(), 1000).catch(() => {});
    }
    throw error;
  } finally {
    outputTransport.abort();
    transport.abort();
    for (const reader of readers) {
      try {
        void reader.cancel().catch(() => {});
      } catch {}
    }
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    await raw(box, ["rm", "-f", marker, `${marker}.exit`, `${marker}.out`], undefined, 250).catch(
      () => {},
    );
  }
}
