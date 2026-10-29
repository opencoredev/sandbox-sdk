import { guestSpec } from "../freestyle/wire.js";
import { guestProcess } from "../boxd/guest.js";
import type { Session } from "@tenkicloud/sandbox";
import type { ExecInput, ExecResult } from "../../provider.js";
import { deadline } from "./deadline.js";
import { failure, tenkiError } from "./errors.js";
import { raw } from "./exec.js";
import { workspaceSetup } from "./ready.js";

// Unlike Session.run(), the public data-plane client does not collect output.
// The supervisor owns the deadline and process group even after an RPC disconnect.
const supervisor = `import os,sys,marshal,_signal as signal,select,time,pwd
${guestProcess}
v=marshal.loads(bytes.fromhex(sys.stdin.read()))
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
with stdin_file() as f:
 f.write(v['stdin'].encode()); f.seek(0)
 p=Process(v,env,f,True)
 try:
  with open(v['marker'],'w') as m: m.write(str(p.pid))
  if v.get('activityPath'):
   os.makedirs(os.path.dirname(v['activityPath']),exist_ok=True)
   with open(v['activityPath'],'w') as a: a.write('1')
  stdout=p.stdout.fileno(); streams={stdout:'stdout',p.stderr.fileno():'stderr'}
  end=time.monotonic()+v['timeoutMs']/1000
  timed=False
  while streams or p.poll() is None:
   if not timed and time.monotonic()>=end:
    timed=True
    try: os.killpg(p.pid,signal.SIGKILL)
    except ProcessLookupError: pass
   for fd in select.select(list(streams),[],[],.01)[0]:
    data=os.read(fd,8192)
    if data: print('["'+streams[fd]+'","'+data.hex()+'"]',flush=True)
    else: del streams[fd]; (p.stdout if fd==stdout else p.stderr).close()
  code=p.wait()
  print('{"exitCode":%s,"timedOut":%s,"workspaceStable":%s,"workspaceRootHex":"%s"}'%('null' if timed else str(code if code>=0 else 128-code),str(timed).lower(),str(stable()).lower(),os.path.realpath(v['workspace']).encode().hex()),flush=True)
 except BaseException:
  try: os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  raise
 finally:
  for path in [v['marker'],v.get('activityPath')]:
   if path:
    try: os.unlink(path)
    except FileNotFoundError: pass
`;

export async function executeStream(
  box: Session,
  input: ExecInput,
  workspaceRoot?: (root: string, stable: boolean) => void,
): Promise<ExecResult> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const marker = `/home/tenki/.sandbox-sdk-run-${crypto.randomUUID()}`;

  const spec = Buffer.from(
    guestSpec({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      stdin: input.stdin ?? "",
      timeoutMs: input.timeoutMs,
      marker,
      activityPath: input.activityPath,
      workspace: "/workspace",
    }).toString("hex"),
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
      const text = decoders[stream].decode(Buffer.from(value[1], "hex"), { stream: true });

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
      if ("workspaceRootHex" in value && typeof value.workspaceRootHex === "string")
        workspaceRoot?.(
          Buffer.from(value.workspaceRootHex, "hex").toString(),
          "workspaceStable" in value && value.workspaceStable === true,
        );
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
      let receivedResponse = false;

      async function* requests() {
        signal.throwIfAborted();
        yield {
          frame: {
            payload: {
              case: "start",
              value: {
                sessionId: box.id,
                cmd: ["python3", "-S", "-c", supervisor],
                privileged: true,
                streamStdin: true,
              },
            },
          },
        } satisfies Request;
        // Send input immediately: waiting for started adds a network round trip.
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

          if (frame.case !== "keepalive") receivedResponse = true;

          if (frame.case === "started") {
            box.markDataPlaneServing(plane);
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

        if (transport.signal.aborted) throw error;
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const message = error instanceof Error ? error.message : "";
        const auth = code === 16 || tenkiError(error).code === "auth";

        const provisioning =
          code === 5 &&
          /\bsession not found\b/i.test(message) &&
          plane !== undefined &&
          box.dataPlaneProvisioningPending(plane);

        // These statuses reject the RPC before dispatch, even if the transport
        // consumed our request iterator. Generic Unavailable/reset/GOAWAY do not
        // prove that: the peer may have launched the command and lost its reply.
        const rejected =
          auth ||
          provisioning ||
          (code === 12 && /\b404\b/.test(message)) ||
          ((code === 10 || code === 13 || code === 14) && /REFUSED_STREAM/i.test(message));

        if (!receivedResponse && (rejected || !mayHaveLaunched)) {
          mayHaveLaunched = false;

          if (auth) {
            if (attempt === 0 && (await box.reauthOnUnauthenticated(error))) continue;
            throw failure("Command authorization rejected before launch", "auth");
          }

          if (rejected || code === 14) {
            if (attempt === 0) {
              if (provisioning && plane) await box.refreshHintedDataPlane(plane);
              continue;
            }

            throw failure("Command transport rejected before launch", "unavailable");
          }
        }

        if (mayHaveLaunched)
          throw failure(
            "Command stream failed after submission; execution outcome is unknown",
            "outcome_unknown",
          );
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
          throw failure(
            "Process cancellation could not be confirmed; execution outcome is unknown",
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
