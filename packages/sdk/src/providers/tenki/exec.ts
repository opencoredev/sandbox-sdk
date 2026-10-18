import type { Session } from "@tenkicloud/sandbox";
import type { ExecInput } from "../../provider.js";
import { failure } from "./errors.js";

/** Python is included in Tenki's base image. Privileged run is necessary because
 * the guest file API rejects paths outside /home/tenki, including /workspace.
 * A guest supervisor owns the timeout and process group, even if I/O disconnects.
 */
const supervisor = `import os,sys,json,base64,subprocess,tempfile,signal
v=json.load(sys.stdin)
with tempfile.TemporaryFile() as f:
 f.write(base64.b64decode(v['stdin'])); f.seek(0)
 p=subprocess.Popen(['sh','-c',v['command']],cwd=v['cwd'],env={**os.environ,**v['env']},stdin=f,start_new_session=True)
 with open(v['marker'],'w') as m: m.write(str(p.pid))
 timed=False
 try: code=p.wait(timeout=v['timeoutMs']/1000)
 except subprocess.TimeoutExpired:
  timed=True
  try: os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  p.wait()
 with open(v['marker']+'.exit','w') as m: json.dump({'exitCode':None if timed else (code if code>=0 else 128-code),'timedOut':timed},m)
`;
export async function raw(box: Session, argv: string[], stdin?: Uint8Array) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stdin) controller.enqueue(stdin);
      controller.close();
    },
  });
  const result = await box.run(argv, { privileged: true, stdin: stream, timeoutMs: 30_000 });
  if (result.exitCode !== 0 || result.timedOut)
    throw failure("Guest operation failed", result.timedOut ? "timeout" : "provider");
  return new TextDecoder().decode(result.stdout);
}
export async function execute(box: Session, input: ExecInput) {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const marker = `/home/tenki/.sandbox-sdk-run-${crypto.randomUUID()}`;
  const spec = Buffer.from(
    JSON.stringify({
      // The SDK owns this reserved namespace. Detached log writers must use
      // durable paths directly: /tmp may vanish before resume can repair its link.
      command: input.command.replaceAll("/tmp/.sandbox-sdk/", "/home/tenki/.sandbox-sdk/"),
      cwd: input.cwd,
      env: input.env,
      stdin: Buffer.from(input.stdin ?? "").toString("base64"),
      timeoutMs: input.timeoutMs,
      marker,
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
  const handle = box.run(["python3", "-c", supervisor], { privileged: true, stdin });
  async function drain(stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr") {
    const decoder = new TextDecoder();
    for await (const data of stream) {
      const text = decoder.decode(data, { stream: true });
      if (text) input.onChunk({ stream: kind, text });
    }
    const text = decoder.decode();
    if (text) input.onChunk({ stream: kind, text });
  }
  const completion = Promise.all([
    Promise.resolve(handle),
    drain(handle.stdout, "stdout"),
    drain(handle.stderr, "stderr"),
  ]);
  void completion.catch(() => {});
  async function killGroup() {
    // Poll after launch: cancellation may arrive before the guest publishes its PID.
    await raw(box, [
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
    ]);
  }
  try {
    if (input.signal?.aborted) cancel();
    const result = cancelled ? "cancelled" : await Promise.race([completion, cancellation]);
    if (result === "cancelled") {
      try {
        await killGroup();
      } catch {
        await box.close();
        throw failure(
          "Process cancellation could not be confirmed; the VM was terminated",
          "outcome_unknown",
        );
      }
      await completion;
      return { exitCode: null, timedOut: true };
    }
    const value: unknown = JSON.parse(await raw(box, ["cat", `${marker}.exit`]));
    if (
      !value ||
      typeof value !== "object" ||
      !("exitCode" in value) ||
      !("timedOut" in value) ||
      (value.exitCode !== null && typeof value.exitCode !== "number") ||
      typeof value.timedOut !== "boolean"
    )
      throw failure("Invalid command result");
    return { exitCode: value.exitCode, timedOut: value.timedOut };
  } catch (error) {
    // A failed stream cannot leave user code running after the caller sees failure.
    try {
      await killGroup();
    } catch {
      await box.close();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    await raw(box, ["rm", "-f", marker, `${marker}.exit`]).catch(() => {});
  }
}
