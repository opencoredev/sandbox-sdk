import type { Box } from "@upstash/box";
import type { ExecInput, ExecResult } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { defaults, quote } from "../../run.js";

const bridge = `import base64,os,selectors,signal,subprocess,sys,time,shutil,fcntl
command,directory,cwd,limit,activity=sys.argv[1:]
if activity:
 os.makedirs(os.path.dirname(activity),exist_ok=True)
 os.mkdir(activity,mode=0o700)
os.makedirs(directory,mode=0o700,exist_ok=True)
cancel=directory+"/cancel"
with open(directory+"/lock","w") as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 if os.path.exists(cancel):
  print("R:0:1:1")
  sys.exit(0)
 p=subprocess.Popen(["sh","-c",'cd "$1" || exit; exec sh -c "$2"',"sh",cwd,command],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 with open(directory+"/pid","w") as f: f.write(str(p.pid))
s=selectors.DefaultSelector()
s.register(p.stdout,selectors.EVENT_READ,"O")
s.register(p.stderr,selectors.EVENT_READ,"E")
deadline=time.monotonic()+float(limit)
timedout=False
size=0
spill=None
try:
 while s.get_map() or p.poll() is None:
  if not timedout and (time.monotonic()>=deadline or os.path.exists(cancel)):
   timedout=True
   try: os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError: pass
  for key,_ in s.select(0.02):
   data=os.read(key.fileobj.fileno(),4096)
   if not data: s.unregister(key.fileobj); continue
   frame=key.data+":"+base64.b64encode(data).decode()+"\\n"
   size+=len(frame)
   if size>65536:
    if spill is None: spill=open(directory+"/output","w")
    spill.write(frame)
   else: sys.stdout.write(frame)
 code=p.wait()
 print("R:%d:%d:%d"%(code if code>=0 else 128-code,timedout,spill is not None))
except BaseException:
 try: os.killpg(p.pid,signal.SIGKILL)
 except ProcessLookupError: pass
 p.wait()
 raise
finally:
 if activity: shutil.rmtree(activity,ignore_errors=True)
 if spill is not None: spill.close()
 else: shutil.rmtree(directory)
`;

const cancelBridge = `import os,signal,sys,fcntl,time
p=sys.argv[1]
pid=None
for attempt in range(3):
 try:
  os.makedirs(p,mode=0o700,exist_ok=True)
  with open(p+"/lock","w") as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   open(p+"/cancel","w").close()
   try:
    with open(p+"/pid") as f: pid=int(f.read())
    os.killpg(pid,signal.SIGKILL)
   except (FileNotFoundError,ProcessLookupError): pass
  break
 except FileNotFoundError:
  if attempt==2: raise
if pid:
 end=time.monotonic()+2
 while True:
  try: os.killpg(pid,0)
  except ProcessLookupError: break
  if time.monotonic()>=end: sys.exit(1)
  time.sleep(.01)
`;

export async function bufferedExecute(box: Box, input: ExecInput): Promise<ExecResult | undefined> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const dir = `/tmp/.sandbox-sdk/exec/sdk-${crypto.randomUUID()}`;
  const env = Object.entries(defaults).filter(([key]) => key in input.env).map(([key, value]) => quote(`${key}=${value}`)).join(" ");
  const command = `env ${env} python3 -u -c ${quote(bridge)} ${quote(input.command)} ${quote(dir)} ${quote(input.cwd)} ${quote(String(input.timeoutMs / 1000))} ''`;
  if (Buffer.byteLength(command) >= 96 * 1024) return undefined;
  const deadline = Date.now() + input.timeoutMs;
  let cancelled = false, confirmed = false, cleanupNeeded = false;
  let wake = () => {};
  const stopped = new Promise<undefined>(resolve => { wake = () => resolve(undefined); });
  let cancellation: Promise<unknown> | undefined;
  let cancellationError: unknown;
  const malformed = () => new SandboxError("Command output is incomplete. Upstash did not confirm exact output and exit. Inspect the box before retrying.", { code: "outcome_unknown", provider: "upstash", sandboxId: box.id });
  const abort = () => {
    cancelled = true; wake();
    if (confirmed) return;
    cancellation ??= box.exec.command(`python3 -c ${quote(cancelBridge)} ${quote(dir)}`)
      .then(r => { if (r.exitCode !== 0) throw malformed(); })
      .catch(error => { cancellationError = error; });
  };
  const decoders = { stdout: new TextDecoder("utf-8", { ignoreBOM: true }), stderr: new TextDecoder("utf-8", { ignoreBOM: true }) };
  const accept = (line: string) => {
    const frame = /^(O|E):([A-Za-z0-9+/]*={0,2})$/.exec(line);
    if (!frame || line.length > 5466 || Buffer.from(frame[2] ?? "", "base64").toString("base64") !== frame[2]) throw malformed();
    const stream = frame[1] === "O" ? "stdout" : "stderr";
    const text = decoders[stream].decode(Buffer.from(frame[2] ?? "", "base64"), { stream: true });
    if (text) input.onChunk({ stream, text });
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
  try {
    // Only fixed non-interactive defaults enter argv. Sandbox env is native.
    const r = await box.exec.command(command);
    if (r.exitCode === 127 && r.stderr.includes("python3") && !cancelled) return undefined;
    const lines = r.stdout.trimEnd().split("\n");
    const summary = /^R:(\d+):([01]):([01])$/.exec(lines.pop() ?? "");
    if (r.exitCode !== 0 || !summary) throw malformed();
    confirmed = true;
    cleanupNeeded = summary[3] === "1";
    for (const line of lines) if (line) accept(line);
    if (cleanupNeeded && !cancelled) {
      let offset = 0, pending = "";
      while (!cancelled) {
        const data = await Promise.race([box.files.read(`${dir}/output`, { offset, length: 65536, encoding: "base64" }), stopped]);
        if (data === undefined) break;
        const bytes = Buffer.from(data, "base64");
        if (cancelled) break;
        offset += bytes.length;
        pending += bytes.toString("ascii");
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          accept(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        }
        if (pending.length > 5466) throw malformed();
        if (bytes.length < 65536) { if (pending) throw malformed(); break; }
      }
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const text = decoders[stream].decode(); if (text) input.onChunk({ stream, text });
    }
    await cancellation;
    if (cancellationError !== undefined) throw malformed();
    const timedOut = summary[2] === "1" || cancelled;
    return { exitCode: timedOut ? null : Number(summary[1]), timedOut };
  } catch (error) {
    if (!confirmed) {
      abort(); await cancellation;
      // Retain the locked cancellation tombstone on a lost response. A delayed
      // launch must consume it before spawning; unrelated work stays alive.
      if (cancellationError !== undefined) throw malformed();
    }
    throw error;
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
    await cancellation;
    if (confirmed && (cancellation || cleanupNeeded)) await box.files.remove(dir, { recursive: true }).catch(() => {});
  }
}
