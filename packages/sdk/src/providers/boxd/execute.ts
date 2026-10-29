import type { Boxd } from "@boxd-sh/sdk";
import type { ExecInput, ExecResult } from "../../provider.js";
import { guestProcess, python } from "../../shared/guest.js";
import { quote } from "../../shared/shell.js";
import { failure } from "./errors.js";

// env in the native boxd ExecParams is prefixed onto command text. Instead,
// deliver the entire spec over bidi stdin, then close it. The child inherits
// the native process group, so cancelling the stream kills all descendants.
const launcher = `import sys,json,os,fcntl,selectors,signal
${guestProcess}
# Keep the output owner alive through native TERM grace. Caught handlers reset
# to the default disposition when the user shell execs.
signal.signal(signal.SIGTERM,lambda *_:None)
v=json.load(sys.stdin)
if v.get('preparing'): print('SDK_PREPARED:',end='',flush=True)
a=v.get('activityPath')
m=v['pidPath']
try:
 with stdin_file() as f:
  f.write(v.get('stdin','').encode()); f.seek(0)
  with open(m+'.lock','a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   if os.path.exists(m+'.cancel'): sys.exit(137)
   with open(m,'w') as pid: pid.write(str(os.getpgrp()))
   if a:
    os.makedirs(os.path.dirname(a),exist_ok=True)
    with open(a,'w') as activity: activity.write('1')
   try: p=Process(v,{**os.environ,**v['env']},f)
   except OSError as e:
    print(str(e),file=sys.stderr); sys.exit(127)
  # Keep the supervisor and marker until inherited output pipes close, even
  # after the direct shell exits and only background descendants remain.
  sel=selectors.DefaultSelector()
  sel.register(p.stdout,selectors.EVENT_READ,sys.stdout.buffer)
  sel.register(p.stderr,selectors.EVENT_READ,sys.stderr.buffer)
  while sel.get_map():
   for key,_ in sel.select():
    data=os.read(key.fd,16384)
    if data: key.data.write(data); key.data.flush()
    else: sel.unregister(key.fileobj); key.fileobj.close()
  code=p.wait()
  sys.exit(code if code>=0 else 128-code)
finally:
 # The direct shell may exit while a background child still owns the pipes.
 # Keep the group identity until no user descendants remain for cancellation.
 ancestors=set(); parent=os.getpid()
 while parent>1:
  ancestors.add(parent)
  try:
   with open('/proc/'+str(parent)+'/stat') as f: parent=int(f.read().rsplit(')',1)[1].split()[1])
  except (FileNotFoundError,ProcessLookupError): break
 descendants=False
 for name in os.listdir('/proc'):
  if not name.isdigit() or int(name) in ancestors: continue
  try:
   with open('/proc/'+name+'/stat') as f: fields=f.read().rsplit(')',1)[1].split()
   if int(fields[2])==os.getpgrp() and fields[0]!='Z': descendants=True
  except (FileNotFoundError,ProcessLookupError): pass
 if not descendants:
  try: os.unlink(m)
  except FileNotFoundError: pass
  if not os.path.exists(m+'.cancel'):
   try: os.unlink(m+'.lock')
   except FileNotFoundError: pass
 if a:
  try: os.unlink(a)
  except FileNotFoundError: pass
`;

export async function execute(
  client: Boxd,
  id: string,
  input: ExecInput,
  setup = "",
  onPrepared?: () => void,
): Promise<ExecResult> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const pidPath = `/tmp/sandbox-sdk-${crypto.randomUUID()}.pid`;
  const stream = client.machines.streamExec(id, { command: setup + python(launcher) });
  let cancelled = false;
  let interrupted = false;

  const completion = stream.wait().then(
    (exitCode) => ({ kind: "exit", exitCode }) as const,
    (cause: unknown) => ({ kind: "error", cause }) as const,
  );

  // The SDK pushes each wire frame synchronously into one of these public
  // queues. Consume at that boundary rather than scheduling two independent
  // iterators, which loses inter-stream ordering and buffers unbounded output.
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  let prepared = !setup;
  let acknowledgment = "";

  for (const name of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) {
    stream[name].push = (bytes) => {
      let text = decoders[name].decode(bytes, { stream: true });

      if (name === "stdout" && !prepared) {
        acknowledgment += text;

        if ("SDK_PREPARED:".startsWith(acknowledgment) && acknowledgment.length < 13) return;

        if (acknowledgment.startsWith("SDK_PREPARED:")) {
          prepared = true;
          onPrepared?.();
          text = acknowledgment.slice(13);
        } else text = acknowledgment;
        acknowledgment = "";
      }

      if (text) input.onChunk({ stream: name, text });
    };
  }

  let settleCancellation = () => {};

  const stopped = new Promise<void>((resolve) => {
    settleCancellation = resolve;
  });

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    stream.close();
    settleCancellation();
  };

  const timer = setTimeout(cancel, input.timeoutMs);
  input.signal?.addEventListener("abort", cancel, { once: true });

  try {
    stream.write(
      JSON.stringify({
        pidPath,
        preparing: Boolean(setup),
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        stdin: input.stdin ?? "",
        activityPath: input.activityPath,
      }),
    );
    stream.end();

    const outcome = await Promise.race([
      completion,
      stopped.then(() => ({ kind: "cancel" }) as const),
    ]);

    if (cancelled) {
      // close() only requests TERM/KILL. An RPC error is not an exit ack.
      let timer: ReturnType<typeof setTimeout> | undefined;

      const confirmed = await Promise.race([
        completion.then((value) =>
          value.kind === "exit" && value.exitCode >= 0 ? true : new Promise<boolean>(() => {}),
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);

      clearTimeout(timer);

      if (!confirmed) {
        // A transport cancellation error is not a process exit. Escalate only
        // the positively identified group, never delete an unrelated VM.
        const result = await client.machines.exec(id, {
          command: python(
            `import os,sys,signal,time,fcntl
p=sys.argv[1]
with open(p+'.lock','a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 with open(p+'.cancel','w') as f: f.write('1')
 try:
  with open(p) as f: pgid=int(f.read())
 except FileNotFoundError:
  print('confirmed'); sys.exit(0)
try: os.killpg(pgid,signal.SIGKILL)
except ProcessLookupError: pass
end=time.monotonic()+2
while time.monotonic()<end:
 alive=False
 for name in os.listdir('/proc'):
  if not name.isdigit(): continue
  try:
   with open('/proc/'+name+'/stat') as f: fields=f.read().rsplit(')',1)[1].split()
   if int(fields[2])==pgid and fields[0]!='Z': alive=True
  except (FileNotFoundError,ProcessLookupError): pass
 if not alive:
  try: os.unlink(p)
  except FileNotFoundError: pass
  print('confirmed'); sys.exit(0)
 time.sleep(.01)
sys.exit(1)`,
            pidPath,
          ),
          timeout: 5000,
        });

        if (result.exitCode !== 0 || result.stdout.trim() !== "confirmed")
          throw failure("Process termination could not be confirmed", "outcome_unknown", id);
      }
    } else if (outcome.kind === "error") {
      throw outcome.cause;
    }

    for (const name of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) {
      const text = decoders[name].decode();

      if (text) input.onChunk({ stream: name, text });
    }

    return {
      exitCode: cancelled ? null : outcome.kind === "exit" ? outcome.exitCode : null,
      timedOut: cancelled,
    };
  } catch (error) {
    interrupted = true;

    if (cancelled)
      throw failure("Process termination could not be confirmed", "outcome_unknown", id);
    stream.close();
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);

    if ((cancelled || interrupted) && input.activityPath)
      await client.machines
        .exec(id, {
          command: `rm -f -- ${quote(input.activityPath)} ${quote(pidPath)}`,
          timeout: 5000,
        })
        .catch((cause: unknown) => {
          // Preserve the primary execution/termination failure during cleanup.
          if (!interrupted) throw cause;
        });
  }
}
