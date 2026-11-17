import type { ExecInput, ExecResult } from "../../provider.js";
import { cachedPython, guestProcess, guestPump, python } from "../../shared/guest.js";
import { failure } from "./errors.js";

/** The parts of a Baseten sandbox's process API that exec uses. */
export interface BasetenProcesses {
  execStream(request: {
    command: string;
    workingDir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    callOptions?: { signal?: AbortSignal };
  }): AsyncGenerator<
    | { type: "output"; stream: "stdout" | "stderr"; text: string }
    | { type: "exit"; process: { exitCode: number } },
    void,
    undefined
  >;
  exec(request: {
    command: string;
    waitForCompletion?: boolean;
    timeoutMs?: number;
  }): Promise<{ exitCode: number; stdout: string }>;
}

/** Where the launcher finds its spec: inline in the environment, or in a file uploaded first. */
export type SpecDelivery = { kind: "env"; spec: string } | { kind: "file"; path: string };

// Whether any non-zombie process is in group g. Baseten's PID 1 never reaps orphans,
// so killed descendants stay zombies.
const alive = `def alive(g):
 for name in os.listdir('/proc'):
  if not name.isdigit(): continue
  try:
   with open('/proc/'+name+'/stat') as f: fields=f.read().rsplit(')',1)[1].split()
   if int(fields[2])==g and fields[0]!='Z': return True
  except (FileNotFoundError,ProcessLookupError,IndexError,ValueError): pass
 return False`;

// Baseten replays a process that finished before its stream opened as one event per line,
// without the newline. So the launcher writes its own frames on stdout, each a letter, base64
// and a terminating ".": O stdout bytes, E stderr bytes, T the deadline killed the group,
// X<code> the exit code. Newlines never appear inside a frame, so either delivery parses the same.
// The command runs in its own session (setsid); its group is killed at the deadline, and the pid
// file lets a separate call kill it on abort.
const launcher = `import os,sys,json,fcntl,select,time,base64,_signal as signal
${guestProcess}
${guestPump}
f=os.environ.pop('SANDBOX_SDK_SPEC_FILE',None)
if f:
 with open(f) as h: v=json.load(h)
 os.unlink(f)
else: v=json.loads(os.environ.pop('SANDBOX_SDK_SPEC'))
out=sys.stdout.buffer
${alive}
def sweep(m):
 # Removes records whose group has no live member left, under each record's lock so it never
 # races a launcher spawning or a kill program reading. Runs only when this launcher keeps its
 # own record, so at most one stale record per background-leaving command waits for the next.
 d=os.path.dirname(m)
 for name in os.listdir(d):
  q=os.path.join(d,name)
  if q==m or not name.startswith('exec-') or not name.endswith('.pid'): continue
  try:
   with open(q+'.lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    if not os.path.exists(q):
     os.unlink(q+'.lock'); continue
    with open(q) as h: g=int(h.read())
    if not alive(g):
     for r in [q,q+'.lock']:
      try: os.unlink(r)
      except FileNotFoundError: pass
  except (OSError,ValueError): pass
def emit(s,d):
 out.write(b'O' if s=='stdout' else b'E'); out.write(base64.b64encode(d)); out.write(b'.'); out.flush()
a=v.get('activityPath')
m=v['pidPath']
os.makedirs(os.path.dirname(m),exist_ok=True)
with stdin_file() as i:
 i.write(v.get('stdin','').encode()); i.seek(0)
 with open(m+'.lock','a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  if os.path.exists(m+'.cancel'): out.write(b'T.'); out.flush(); sys.exit(0)
  if a:
   os.makedirs(os.path.dirname(a),exist_ok=True)
   with open(a,'w') as h: h.write('1')
  try: p=Process(v,{**os.environ,**v['env']},i,True)
  except OSError as e:
   if a:
    try: os.unlink(a)
    except FileNotFoundError: pass
   emit('stderr',(str(e)+'\\n').encode()); out.write(b'X127.'); out.flush(); sys.exit(0)
  with open(m,'w') as h: h.write(str(p.pid))
 try:
  timed=pump(p,emit,time.monotonic()+v['timeoutMs']/1000)
  code=p.wait()
 finally:
  # A background child with its output redirected can outlive the shell and its pipes.
  # Keep the pid record while any live member of the group remains, so a later abort
  # still finds and kills it. Baseten's PID 1 never reaps, so zombies do not count.
  g=p.pid
  if alive(g): sweep(m)
  else:
   for q in [m,m+'.lock']:
    try: os.unlink(q)
    except FileNotFoundError: pass
  if a:
   try: os.unlink(a)
   except FileNotFoundError: pass
if timed: out.write(b'T.')
else: out.write(b'X'+str(code if code>=0 else 128-code).encode()+b'.')
out.flush()
`;

const cachedLauncher = python(cachedPython(launcher));

// Marks run argv[1] cancelled, kills its process group and waits up to 2 s for it to exit.
const killProgram = `import os,sys,signal,time,fcntl
p=sys.argv[1]
os.makedirs(os.path.dirname(p),exist_ok=True)
with open(p+'.lock','a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 with open(p+'.cancel','w') as f: f.write('1')
 try:
  with open(p) as f: pgid=int(f.read())
 except FileNotFoundError:
  print('confirmed'); sys.exit(0)
try: os.killpg(pgid,signal.SIGKILL)
except ProcessLookupError: pass
${alive}
end=time.monotonic()+2
while time.monotonic()<end:
 if not alive(pgid):
  for q in [p,p+'.cancel']:
   try: os.unlink(q)
   except FileNotFoundError: pass
  print('confirmed'); sys.exit(0)
 time.sleep(.01)
sys.exit(1)`;

/** The launcher's spec. JSON of strings and numbers. */
interface LauncherSpec {
  pidPath: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
  activityPath?: string;
}

/** Specs above this size go through a file: one environment string is capped at 128 KiB. */
export const inlineSpecLimit = 96 * 1024;

type Frame =
  | { kind: "output"; stream: "stdout" | "stderr"; bytes: Uint8Array }
  | { kind: "timeout" }
  | { kind: "exit"; code: number };

/** Splits launcher stdout into frames, keeping an unfinished frame for the next text. */
export class FrameReader {
  #pending = "";

  push(text: string): Frame[] {
    const frames: Frame[] = [];
    // Baseten may drop newlines between replayed lines; frames never contain one.
    this.#pending += text.replace(/\n/g, "");
    let end = this.#pending.indexOf(".");

    while (end !== -1) {
      const body = this.#pending.slice(0, end);
      this.#pending = this.#pending.slice(end + 1);
      const tag = body[0];
      const rest = body.slice(1);

      if (tag === "O" || tag === "E")
        frames.push({
          kind: "output",
          stream: tag === "O" ? "stdout" : "stderr",
          bytes: Buffer.from(rest, "base64"),
        });
      else if (tag === "T" && rest === "") frames.push({ kind: "timeout" });
      else if (tag === "X" && /^\d{1,3}$/.test(rest))
        frames.push({ kind: "exit", code: Number(rest) });
      else throw failure("Baseten command output was malformed", "provider");
      end = this.#pending.indexOf(".");
    }

    return frames;
  }

  get empty() {
    return this.#pending === "";
  }
}

export interface Execution {
  processes: BasetenProcesses;
  sandboxId: string;
  input: ExecInput;
  /** Uploads a spec too large for the environment, returning its guest path. Stops when `signal` aborts. */
  uploadSpec(spec: string, signal: AbortSignal): Promise<string>;
  /** Removes an uploaded spec that no launcher will read. */
  removeSpec(path: string): Promise<void>;
}

const aborted: ExecResult = { exitCode: null, timedOut: true };

/** Runs one command through the launcher, streaming its output in order. */
export async function execute({
  processes,
  sandboxId,
  input,
  uploadSpec,
  removeSpec,
}: Execution): Promise<ExecResult> {
  if (input.signal?.aborted) return aborted;
  const pidPath = `/tmp/.sandbox-sdk/exec-${crypto.randomUUID()}.pid`;

  // JSON.stringify drops an undefined activityPath.
  const spec = JSON.stringify({
    pidPath,
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    stdin: input.stdin ?? "",
    timeoutMs: input.timeoutMs,
    activityPath: input.activityPath,
  } satisfies LauncherSpec);

  const stream = new AbortController();
  const reader = new FrameReader();
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  let timedOut = false;
  let exitCode: number | undefined;
  let launcherError = false;
  let cancelled = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    cancelled = true;
    stream.abort();
  };

  // Kills the command's group, or keeps a launcher that has not started yet from running it,
  // and confirms that no live member of the group is left.
  const terminate = async () => {
    try {
      const result = await processes.exec({
        command: python(killProgram, pidPath),
        waitForCompletion: true,
        timeoutMs: 10_000,
      });

      return result.exitCode === 0 && result.stdout.trim() === "confirmed";
    } catch {
      return false;
    }
  };

  const unconfirmed = () =>
    failure("Process termination could not be confirmed", "outcome_unknown", sandboxId);

  input.signal?.addEventListener("abort", cancel, { once: true });

  try {
    let specFile: string | undefined;

    // One environment string is capped in bytes, not characters.
    if (Buffer.byteLength(spec, "utf8") > inlineSpecLimit) {
      // Bounded like the command itself, and stopped by an abort.
      const upload = AbortSignal.any([stream.signal, AbortSignal.timeout(input.timeoutMs + 5000)]);

      try {
        specFile = await uploadSpec(spec, upload);
      } catch (error) {
        if (cancelled) return aborted;

        if (upload.aborted)
          throw failure("Uploading the command's input timed out", "timeout", sandboxId);
        throw error;
      }

      if (cancelled) {
        await removeSpec(specFile).catch(() => {});

        return aborted;
      }
    }

    // Nothing has launched yet.
    if (cancelled) return aborted;

    // The launcher kills the group at the deadline; this is the fallback when its frames never come.
    fallback = setTimeout(cancel, input.timeoutMs + 5000);
    let streamFailed = false;

    try {
      for await (const event of processes.execStream({
        command: cachedLauncher,
        workingDir: "/",
        env:
          specFile === undefined ? { SANDBOX_SDK_SPEC: spec } : { SANDBOX_SDK_SPEC_FILE: specFile },
        timeoutMs: 0,
        callOptions: { signal: stream.signal },
      })) {
        if (event.type === "exit") {
          if (event.process.exitCode !== 0) launcherError = true;
          break;
        }

        if (event.stream === "stderr") {
          // Only the launcher itself writes raw stderr: a missing python3 or a crash.
          launcherError = true;
          continue;
        }

        for (const frame of reader.push(event.text)) {
          if (frame.kind === "output") {
            const text = decoders[frame.stream].decode(frame.bytes, { stream: true });

            if (text) input.onChunk({ stream: frame.stream, text });
          } else if (frame.kind === "timeout") timedOut = true;
          else exitCode = frame.code;
        }
      }
    } catch {
      // Baseten leaves a process running when its stream ends, so a broken stream must not
      // settle until the command is stopped.
      if (!cancelled) streamFailed = true;
    }

    // The launcher deletes an uploaded input once it reads it; if it may never have started,
    // delete it here, after the command is known stopped. Already gone is fine.
    const dropSpec = async () => {
      if (specFile !== undefined) await removeSpec(specFile).catch(() => {});
    };

    if (cancelled || streamFailed) {
      if (!(await terminate())) throw unconfirmed();
      await dropSpec();

      if (streamFailed)
        throw failure(
          "Baseten command stream broke; the command was stopped and its outcome is unknown",
          "outcome_unknown",
          sandboxId,
        );

      return aborted;
    }

    for (const name of ["stdout", "stderr"] as const) {
      const text = decoders[name].decode();

      if (text) input.onChunk({ stream: name, text });
    }

    if (timedOut) return aborted;

    if (exitCode === undefined || launcherError || !reader.empty) {
      if (!(await terminate())) throw unconfirmed();
      await dropSpec();
      throw failure(
        "Baseten command launcher failed; the sandbox needs python3",
        "provider",
        sandboxId,
      );
    }

    return { exitCode, timedOut: false };
  } finally {
    clearTimeout(fallback);
    input.signal?.removeEventListener("abort", cancel);
  }
}
