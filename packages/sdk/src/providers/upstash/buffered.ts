import { guestProcess } from "../../shared/guest.js";
import type { Box } from "@upstash/box";
import type { ExecInput, ExecResult } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { defaults } from "../../run.js";
import { quote } from "../../shared/shell.js";

// Runs argv[1] in argv[3] with a deadline, printing hex output frames and an R: summary.
const bridge = `import os,select,_signal as signal,sys,time,fcntl
${guestProcess}
command,directory,cwd,limit=sys.argv[1:]
os.makedirs(directory,mode=0o700,exist_ok=True)
cancel=directory+"/cancel"
with open(directory+"/lock","w") as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 if os.path.exists(cancel):
  print("R:0:1:1")
  sys.exit(0)
 try:
  with stdin_file() as f: p=Process(dict(command=command,cwd=cwd),dict(os.environ,PWD=cwd),f,True)
 except OSError as error:
  print("E:"+str(error).encode().hex())
  print("R:2:0:0")
  os.unlink(directory+"/lock"); os.rmdir(directory)
  sys.exit(0)
 with open(directory+"/pid","w") as f: f.write(str(p.pid))
streams={p.stdout.fileno():"O",p.stderr.fileno():"E"}
deadline=time.monotonic()+float(limit)
timedout=False
size=0
spill=None
try:
 while streams or p.poll() is None:
  if not timedout and (time.monotonic()>=deadline or os.path.exists(cancel)):
   timedout=True
   try: os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError: pass
  for fd in select.select(list(streams),[],[],0.02)[0]:
   data=os.read(fd,4096)
   if not data: del streams[fd]; continue
   frame=streams[fd]+":"+data.hex()+"\\n"
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
 if spill is not None: spill.close()
 else:
  for name in ('pid','lock','cancel'):
   try: os.unlink(directory+'/'+name)
   except FileNotFoundError: pass
  os.rmdir(directory)
`;

// Marks run directory argv[1] cancelled and kills its process group, waiting up to 2 s.
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

export async function bufferedExecute(
  box: Box,
  input: ExecInput,
  prepare?: string,
): Promise<ExecResult | undefined> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const dir = `/tmp/.sandbox-sdk/exec/sdk-${crypto.randomUUID()}`;

  const env = Object.entries(defaults)
    .filter(([key]) => key in input.env)
    .map(([key, value]) => quote(`${key}=${value}`))
    .join(" ");

  const command = `${prepare ? `${prepare} && ` : ""}env ${env} python3 -S -u -c ${quote(bridge)} ${quote(input.command)} ${quote(dir)} ${quote(input.cwd)} ${quote(String(input.timeoutMs / 1000))}`;

  if (Buffer.byteLength(command) >= 96 * 1024) return undefined;
  const deadline = Date.now() + input.timeoutMs;

  let cancelled = false,
    confirmed = false,
    cleanupNeeded = false;

  let wake = () => {};

  const stopped = new Promise<undefined>((resolve) => {
    wake = () => resolve(undefined);
  });

  let cancellation: Promise<unknown> | undefined;
  let cancellationError: unknown;

  const malformed = () =>
    new SandboxError(
      "Command output is incomplete. Upstash did not confirm exact output and exit. Inspect the box before retrying.",
      { code: "outcome_unknown", provider: "upstash", sandboxId: box.id },
    );

  const abort = () => {
    cancelled = true;
    wake();

    if (confirmed) return;
    cancellation ??= box.exec
      .command(`python3 -c ${quote(cancelBridge)} ${quote(dir)}`)
      .then((r) => {
        if (r.exitCode !== 0) throw malformed();
      })
      .catch((error) => {
        cancellationError = error;
      });
  };

  const decoders = {
    stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
    stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
  };

  const accept = (line: string) => {
    const frame = /^(O|E):([0-9a-f]*)$/.exec(line);

    if (
      !frame ||
      line.length > 8194 ||
      Buffer.from(frame[2] ?? "", "hex").toString("hex") !== frame[2]
    )
      throw malformed();
    const stream = frame[1] === "O" ? "stdout" : "stderr";
    const text = decoders[stream].decode(Buffer.from(frame[2] ?? "", "hex"), { stream: true });

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
      let offset = 0,
        pending = "";

      while (!cancelled) {
        const data = await Promise.race([
          box.files.read(`${dir}/output`, { offset, length: 65536, encoding: "base64" }),
          stopped,
        ]);

        if (data === undefined) break;
        const bytes = Buffer.from(data, "base64");

        if (cancelled) break;
        offset += bytes.length;
        pending += bytes.toString("ascii");
        let newline: number;

        while ((newline = pending.indexOf("\n")) >= 0) {
          accept(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }

        if (pending.length > 8194) throw malformed();

        if (bytes.length < 65536) {
          if (pending) throw malformed();
          break;
        }
      }
    }

    for (const stream of ["stdout", "stderr"] as const) {
      const text = decoders[stream].decode();

      if (text) input.onChunk({ stream, text });
    }

    await cancellation;

    if (cancellationError !== undefined) throw malformed();
    const timedOut = summary[2] === "1" || cancelled;

    return { exitCode: timedOut ? null : Number(summary[1]), timedOut };
  } catch (error) {
    if (!confirmed) {
      abort();
      await cancellation;

      // Retain the locked cancellation tombstone on a lost response. A delayed
      // launch must consume it before spawning; unrelated work stays alive.
      if (cancellationError !== undefined) throw malformed();
    }

    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    await cancellation;

    if (confirmed && (cancellation || cleanupNeeded))
      // Best effort: the result is already confirmed; a leftover directory is harmless.
      await box.files.remove(dir, { recursive: true }).catch(() => {});
  }
}
