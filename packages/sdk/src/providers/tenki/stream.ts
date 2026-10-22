import type { Session } from "@tenkicloud/sandbox";
import type { ExecInput, ExecResult } from "../../provider.js";
import { deadline } from "./deadline.js";
import { failure, tenkiError } from "./errors.js";
import { raw } from "./exec.js";

// Unlike Session.run(), the public data-plane client does not collect output.
// The supervisor owns the deadline and process group even after an RPC disconnect.
const supervisor = `import os,sys,json,base64,subprocess,tempfile,signal,selectors,time,pwd
v=json.load(sys.stdin)
env={**os.environ,**v['env'],'PWD':v['cwd']}
if os.geteuid()==0 and 'SUDO_UID' not in env:
 try: env['SUDO_UID']=str(pwd.getpwnam('tenki').pw_uid)
 except KeyError: pass
def emit(v): print(json.dumps(v),flush=True)
with tempfile.TemporaryFile() as f:
 f.write(base64.b64decode(v['stdin'])); f.seek(0)
 p=subprocess.Popen(['sh','-c',v['command']],cwd=v['cwd'],env=env,stdin=f,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 try:
  with open(v['marker'],'w') as m: m.write(str(p.pid))
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
    if data: emit([key.data,base64.b64encode(data).decode()])
    else: sel.unregister(key.fileobj); key.fileobj.close()
  code=p.wait()
  emit({'exitCode':None if timed else (code if code>=0 else 128-code),'timedOut':timed})
 except BaseException:
  try: os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  raise
 finally:
  try: os.unlink(v['marker'])
  except FileNotFoundError: pass
`;

export async function executeStream(box: Session, input: ExecInput): Promise<ExecResult> {
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
    }),
  );
  const transport = new AbortController();
  let result: ExecResult | undefined;
  let exited = false;
  let mayHaveLaunched = false;
  const decoders = {
    stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
    stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
  };
  const decoder = new TextDecoder();
  let pending = "";
  function record(line: string) {
    const value: unknown = JSON.parse(line);
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      (value[0] === "stdout" || value[0] === "stderr") &&
      typeof value[1] === "string" &&
      value[1].length <= 21848
    ) {
      const stream = value[0] === "stdout" ? "stdout" : "stderr";
      const text = decoders[stream].decode(Buffer.from(value[1], "base64"), { stream: true });
      if (text) input.onChunk({ stream, text });
    } else if (
      value &&
      typeof value === "object" &&
      "exitCode" in value &&
      (value.exitCode === null ||
        (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) &&
      "timedOut" in value &&
      typeof value.timedOut === "boolean"
    ) {
      result = { exitCode: value.exitCode, timedOut: value.timedOut };
    } else throw failure("Invalid command output record");
  }
  const completion = (async () => {
    type Plane = Awaited<ReturnType<Session["requireDataPlane"]>>;
    type Request = Parameters<Plane["run"]>[0] extends AsyncIterable<infer T> ? T : never;
    for (let attempt = 0; attempt < 2; attempt++) {
      const attemptTransport = new AbortController();
      const signal = AbortSignal.any([transport.signal, attemptTransport.signal]);
      let plane: Plane | undefined;
      let started = () => {};
      const ready = new Promise<void>((resolve) => {
        started = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      async function* requests() {
        signal.throwIfAborted();
        yield {
          frame: {
            payload: {
              case: "start",
              value: {
                sessionId: box.id,
                cmd: ["python3", "-c", supervisor],
                privileged: true,
                streamStdin: true,
              },
            },
          },
        } satisfies Request;
        // The supervisor cannot launch user code without this JSON input.
        // Withhold it until started, making establishment failures safe to retry.
        await ready;
        signal.throwIfAborted();
        mayHaveLaunched = true;
        yield { frame: { payload: { case: "stdin", value: spec } } } satisfies Request;
        yield { frame: { payload: { case: "stdinClose", value: true } } } satisfies Request;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      try {
        signal.throwIfAborted();
        plane = await box.requireDataPlane(false);
        signal.throwIfAborted();
        for await (const response of plane.run(requests(), { signal })) {
          const frame = response.frame?.payload;
          if (!frame) continue;
          if (frame.case === "started") {
            box.markDataPlaneServing(plane);
            started();
          } else if (frame.case === "stdout") {
            pending += decoder.decode(frame.value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n")) !== -1) {
              record(pending.slice(0, end));
              pending = pending.slice(end + 1);
            }
            if (pending.length > 24000) throw failure("Oversized command output record");
          } else if (frame.case === "exit") {
            if (frame.value.exitCode !== 0 || !result || pending)
              throw failure("Command supervisor failed");
            exited = true;
            for (const stream of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) {
              const text = decoders[stream].decode();
              if (text) input.onChunk({ stream, text });
            }
            return result;
          }
        }
        throw failure("Command stream closed before exit");
      } catch (error) {
        attemptTransport.abort();
        if (mayHaveLaunched || transport.signal.aborted) throw error;
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const message = error instanceof Error ? error.message : "";
        const auth = code === 16 || tenkiError(error).code === "auth";
        if (auth) {
          if (attempt === 0 && (await box.reauthOnUnauthenticated(error))) continue;
          throw failure("Command authorization rejected before launch", "auth");
        }
        const provisioning =
          code === 5 &&
          /\bsession not found\b/i.test(message) &&
          plane !== undefined &&
          box.dataPlaneProvisioningPending(plane);
        const transient =
          code === 14 ||
          (code === 12 && /\b404\b/.test(message)) ||
          ((code === 10 || code === 13) &&
            /REFUSED_STREAM|GOAWAY|ECONNRESET|connection reset|socket hang up|unexpected EOF|stream closed before headers/i.test(
              message,
            ));
        if (provisioning || transient) {
          if (attempt === 0) {
            if (provisioning && plane) await box.refreshHintedDataPlane(plane);
            continue;
          }
          throw failure("Command transport rejected before launch", "unavailable");
        }
        throw error;
      } finally {
        attemptTransport.abort();
      }
    }
    throw failure("Command recovery exhausted", "unavailable");
  })();
  void completion.catch(() => {});
  try {
    // Give the guest its full command budget; the outer deadline also bounds transport setup.
    return await deadline(() => completion, input.timeoutMs + 1000, input.signal);
  } catch (error) {
    if (mayHaveLaunched && !exited) {
      try {
        await raw(
          box,
          [
            "python3",
            "-c",
            `import os,sys,time,signal
for _ in range(100):
 try:
  with open(sys.argv[1]) as f: pid=int(f.read())
  os.killpg(pid,signal.SIGKILL)
  break
 except ProcessLookupError: break
 except (FileNotFoundError,ValueError): time.sleep(.01)
else: raise RuntimeError('PID unavailable')`,
            marker,
          ],
          undefined,
          1500,
        );
      } catch {
        // A completed supervisor can remove its PID while cancellation is in flight.
        // Its valid exit record confirms completion even if the kill RPC found no PID.
        if (!exited) {
          await deadline(() => box.close(), 1000).catch(() => {});
          throw failure(
            "Process cancellation could not be confirmed; VM termination was requested",
            "outcome_unknown",
          );
        }
      }
    }
    if (input.signal?.aborted || tenkiError(error).code === "timeout")
      return { exitCode: null, timedOut: true };
    throw error;
  } finally {
    transport.abort();
  }
}
