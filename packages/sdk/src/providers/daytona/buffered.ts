import type { Readable } from "node:stream";
import type { DaytonaBox } from "./native.js";
import type { ExecInput, ExecResult } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { quote } from "../../shared/shell.js";
import { workspaceCommand } from "./exec.js";
import { downloadStream as openDownload } from "./transfer.js";

// A single native command returns at most 64 KiB of frames. Larger output is
// spooled in the guest and downloaded as a stream, never buffered by the SDK.
// The child owns a separate process group, including inherited output pipes.
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

const cancelBridge = `import os,signal,sys,fcntl
p=sys.argv[1]
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
`;

export async function bufferedExecute(
  box: DaytonaBox,
  input: ExecInput,
  prepare = workspaceCommand,
  prepared?: () => void,
): Promise<ExecResult> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const deadline = Date.now() + input.timeoutMs;
  const transferController = new AbortController();
  let downloadStream: Readable | undefined;
  let cancelled = false;
  let wakeTransfer = () => {};

  const transferCancelled = new Promise<void>((resolve) => {
    wakeTransfer = resolve;
  });

  const dir = `/tmp/.sandbox-sdk/exec/sdk-${crypto.randomUUID()}`;
  let cleanupNeeded = true;
  let confirmed = false;
  let cancellation: Promise<unknown> | undefined;
  let cancellationError: unknown;

  const abort = () => {
    cancelled = true;
    wakeTransfer();
    transferController.abort();
    downloadStream?.destroy();

    if (confirmed) return;
    cancellation ??= box.process
      .executeCommand(`python3 -c ${quote(cancelBridge)} ${quote(dir)}`, "/", undefined, 10)
      .then((result) => {
        if (result.exitCode !== 0) throw new Error("Cancellation failed");
      })
      .catch((error) => {
        cancellationError = error;
      });
  };

  const decoders = {
    stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
    stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
  };

  const malformed = () =>
    new SandboxError(
      "Buffered output is incomplete or malformed. Daytona did not confirm exact output and exit. Inspect or destroy the sandbox before retrying.",
      { code: "outcome_unknown", provider: "daytona", sandboxId: box.id },
    );

  const accept = (line: string) => {
    const frame = /^(O|E):([A-Za-z0-9+/]*={0,2})$/.exec(line);

    if (
      !frame ||
      line.length > 5466 ||
      Buffer.from(frame[2] ?? "", "base64").toString("base64") !== frame[2]
    )
      throw malformed();
    const stream = frame[1] === "O" ? "stdout" : "stderr";
    const text = decoders[stream].decode(Buffer.from(frame[2] ?? "", "base64"), { stream: true });

    if (text) input.onChunk({ stream, text });
  };

  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));

  try {
    const result = await box.process.executeCommand(
      `${prepare ? `${prepare} && ` : ""}python3 -u -c ${quote(bridge)} ${quote(input.command)} ${quote(dir)} ${quote(input.cwd)} ${quote(String(input.timeoutMs / 1000))} ${quote(input.activityPath ?? "")}`,
      "/",
      input.env,
      Math.ceil(input.timeoutMs / 1000) + 15,
    );

    const lines = result.result.trimEnd().split("\n");
    const summary = /^R:(\d+):([01]):([01])$/.exec(lines.pop() ?? "");

    if (result.exitCode !== 0 || !summary) throw malformed();
    confirmed = true;
    prepared?.();
    cleanupNeeded = summary[3] === "1";

    for (const line of lines) if (line) accept(line);

    if (summary[3] === "1") {
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) abort();

      if (!cancelled) {
        const drain = async () => {
          const stream = await openDownload(box, `${dir}/output`, {
            signal: transferController.signal,
            timeout: Math.max(1, Math.ceil(remainingMs / 1000)),
          });

          downloadStream = stream;

          // A pending native download can resolve after cancellation won the race.
          if (cancelled) {
            stream.destroy();

            return;
          }

          let pending = "";

          for await (const data of stream) {
            if (cancelled) return;

            if (!(data instanceof Uint8Array)) throw malformed();
            pending += Buffer.from(data).toString("ascii");
            let newline: number;

            while ((newline = pending.indexOf("\n")) >= 0) {
              accept(pending.slice(0, newline));
              pending = pending.slice(newline + 1);
            }

            if (pending.length > 5466) throw malformed();
          }

          if (pending) throw malformed();
        };

        await Promise.race([drain(), transferCancelled]);
      }

      if (cancelled) return { exitCode: null, timedOut: true };
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
    if (confirmed && cancelled) return { exitCode: null, timedOut: true };

    // A lost native response leaves launch/exit ambiguous. The private marker
    // prevents a late launch and the PID kills any already-started group.
    if (!confirmed) {
      abort();
      await cancellation;
      // A transport failure cannot confirm when the cancellation marker was
      // observed. Stopping the sandbox confirms every descendant is dead.
      await box.stop();
    }

    await cancellation;

    if (cancellationError !== undefined) throw malformed();
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    await cancellation;

    // Small successful commands already removed their directory in the guest.
    // Spill files and cancellation markers require one cleanup request, which is
    // best effort: it must not replace the command's result.
    if (cancellation || cleanupNeeded) await box.fs.deleteFile(dir, true).catch(() => {});

    if (input.activityPath && cancellation)
      await box.fs.deleteFile(input.activityPath, true).catch(() => {});
  }
}
