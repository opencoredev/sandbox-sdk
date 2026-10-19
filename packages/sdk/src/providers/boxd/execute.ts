import type { Boxd, ExecStream } from "@boxd-sh/sdk";
import type { ExecInput, ExecResult, OutputChunk } from "../../provider.js";
import { python, quote } from "./guest.js";

// env in the native boxd ExecParams is prefixed onto command text. Instead,
// deliver the entire spec over bidi stdin, then close it. The child inherits
// the native process group, so cancelling the stream kills all descendants.
const launcher = `import sys,json,os,subprocess,tempfile
v=json.load(sys.stdin)
a=v.get('activityPath')
try:
 if a:
  os.makedirs(os.path.dirname(a),exist_ok=True)
  with open(a,'w') as f: f.write('1')
 with tempfile.TemporaryFile() as f:
  f.write(v.get('stdin','').encode()); f.seek(0)
  try: p=subprocess.Popen(['sh','-c',v['command']],cwd=v['cwd'],env={**os.environ,**v['env']},stdin=f)
  except OSError as e:
   print(str(e),file=sys.stderr); sys.exit(127)
  code=p.wait()
  sys.exit(code if code>=0 else 128-code)
finally:
 if a:
  try: os.unlink(a)
  except FileNotFoundError: pass
`;
export async function execute(client: Boxd, id: string, input: ExecInput): Promise<ExecResult> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const stream = client.machines.streamExec(id, { command: python(launcher) });
  let cancelled = false;
  let interrupted = false;
  let settleCancellation = () => {};
  const stopped = new Promise<ExecResult>((resolve) => {
    settleCancellation = () => resolve({ exitCode: null, timedOut: true });
  });
  const cancel = () => {
    cancelled = true;
    stream.close();
    // 0.2.17 may never settle wait()/queues when cancelled before credentials
    // resolve. Native close still prevents launch; settle independently.
    stream.stdout.close();
    stream.stderr.close();
    settleCancellation();
  };
  const timer = setTimeout(cancel, input.timeoutMs);
  input.signal?.addEventListener("abort", cancel, { once: true });
  try {
    stream.write(
      JSON.stringify({
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        stdin: input.stdin ?? "",
        activityPath: input.activityPath,
      }),
    );
    stream.end();
    return await Promise.race([
      Promise.all([
        stream.wait(),
        drain(stream.stdout, "stdout", input.onChunk),
        drain(stream.stderr, "stderr", input.onChunk),
      ]).then(([exitCode]) => ({ exitCode: cancelled ? null : exitCode, timedOut: cancelled })),
      stopped,
    ]);
  } catch (error) {
    if (cancelled) return { exitCode: null, timedOut: true };
    interrupted = true;
    stream.close();
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    if ((cancelled || interrupted) && input.activityPath)
      await client.machines.exec(id, {
        command: `rm -f -- ${quote(input.activityPath)}`,
        timeout: 5000,
      });
  }
}
async function drain(
  bytes: ExecStream["stdout"],
  stream: OutputChunk["stream"],
  emit: ExecInput["onChunk"],
) {
  const decoder = new TextDecoder();
  for await (const chunk of bytes) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) emit({ stream, text });
  }
  const text = decoder.decode();
  if (text) emit({ stream, text });
}
