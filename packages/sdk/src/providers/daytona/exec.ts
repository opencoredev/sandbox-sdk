import { setTimeout as sleep } from "node:timers/promises";
import type { Sandbox } from "@daytonaio/sdk";
import type { ExecInput, ExecResult, NativeProcess } from "../../provider.js";
import { daytonaError } from "./errors.js";
import { bufferedExecute } from "./buffered.js";
import { download, upload } from "./transfer.js";
import { SandboxError } from "../../errors.js";
import { quote } from "../../shared/shell.js";

// Session logs are line-normalized by the native transport. Encode each pipe
// chunk so terminal newlines and byte boundaries survive that normalization.
const outputBridge = `import base64,os,selectors,subprocess,sys,shutil
a=sys.argv[3]
if a:
 os.makedirs(os.path.dirname(a),exist_ok=True)
 os.mkdir(a,mode=0o700)
p=subprocess.Popen(["sh","-c",sys.argv[1]],stdin=open(sys.argv[2],"rb"),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
s=selectors.DefaultSelector()
s.register(p.stdout,selectors.EVENT_READ,"O")
s.register(p.stderr,selectors.EVENT_READ,"E")
while s.get_map():
 for key,_ in s.select():
  data=os.read(key.fileobj.fileno(),4096)
  if data: print(key.data+":"+base64.b64encode(data).decode(),flush=True)
  else: s.unregister(key.fileobj)
code=p.wait()
if a: shutil.rmtree(a,ignore_errors=True)
print("X:",flush=True)
sys.exit(code if code>=0 else 128-code)
`;

/** Each call has a new session and process group. Stdin comes from a private file
 * because session input has no documented EOF operation. Native process hooks
 * run core's durable wrapper unchanged, so logs survive client detachment.
 */
export const workspaceCommand =
  'if [ ! -w /workspace ]; then sudo -n install -d -o "$(id -u)" -g "$(id -g)" -m 755 /workspace; fi; test -w /workspace';

export async function sessionProcess(
  box: Sandbox,
  input: Omit<ExecInput, "timeoutMs">,
  timeoutMs?: number,
  prepare = workspaceCommand,
): Promise<NativeProcess & { detach(): void }> {
  const session = `sdk-${crypto.randomUUID()}`;
  const dir = `/tmp/.sandbox-sdk/exec/${session}`;
  const pidPath = `${dir}/pid`;
  let cancelled = input.signal?.aborted ?? false;
  let pid: number | undefined;
  let commandId: string | undefined;
  let created = false;
  let finished = false;
  let detached = false;
  let activityFinished = false;
  const persistent = timeoutMs === undefined;

  const abort = () => {
    cancelled = true;
  };

  const timer = timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
  input.signal?.addEventListener("abort", abort, { once: true });

  async function signal(kind: "TERM" | "KILL") {
    if (pid === undefined) return;

    const result = await box.process.executeCommand(
      `/bin/kill -${kind} -- -${pid} 2>/dev/null || ! /bin/kill -0 -- -${pid} 2>/dev/null`,
      "/",
      undefined,
      10,
    );

    if (result.exitCode !== 0)
      throw new SandboxError(
        "Remote process group could not be killed. Cancellation is unconfirmed. Destroy the sandbox before retrying.",
        { code: "outcome_unknown", provider: "daytona", sandboxId: box.id },
      );
  }

  async function cleanup() {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);

    if (input.activityPath && !activityFinished)
      await box.fs.deleteFile(input.activityPath, true).catch(() => {});

    if (created) {
      try {
        await box.process.deleteSession(session);
      } catch (error) {
        if (daytonaError(error).code !== "not_found") throw error;
      }
    }

    try {
      await box.fs.deleteFile(dir, true);
    } catch (error) {
      if (daytonaError(error, box.id, true).code !== "file_not_found") throw error;
    }
  }

  try {
    if (input.stdin !== undefined) {
      await box.fs.createFolder(dir, "700");
      await upload(box, Buffer.from(input.stdin), `${dir}/stdin`);
    }

    if (cancelled) {
      await cleanup();

      return {
        pid: 0,
        wait: async () => ({ exitCode: null, signal: "SIGKILL" }),
        stop: async () => {},
        detach() {},
      };
    }

    await box.process.createSession(session);
    created = true;

    const env = Object.entries(input.env)
      .map(([key, value]) => quote(`${key}=${value}`))
      .join(" ");

    const script = `umask 077; mkdir -p ${quote(dir)} || exit 1; echo $$ > ${quote(`${pidPath}.tmp`)}; mv ${quote(`${pidPath}.tmp`)} ${quote(pidPath)}; cd ${quote(input.cwd)} || exit 1; exec env ${env} python3 -u -c ${quote(outputBridge)} ${quote(input.command)} ${quote(input.stdin === undefined ? "/dev/null" : `${dir}/stdin`)} ${quote(input.activityPath ?? "")}`;

    const response = await box.process.executeSessionCommand(session, {
      command: `${prepare ? `${prepare} && ` : ""}setsid --wait sh -c ${quote(script)}`,
      runAsync: true,
      suppressInputEcho: true,
    });

    commandId = response.cmdId;

    if (!commandId)
      throw new SandboxError(
        "Session command has no ID. Daytona did not confirm launch. Inspect or destroy the sandbox.",
        { code: "outcome_unknown", provider: "daytona", sandboxId: box.id },
      );
    // Observe both promises immediately: stream failures must not become unhandled.
    let pending = "";
    let logsError: unknown;
    let bridgeFinished = false;

    const decoders = {
      stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
      stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
    };

    const readFrames = (text: string) => {
      pending += text;
      let newline: number;

      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);

        if (!line) continue;

        if (bridgeFinished)
          throw new SandboxError(
            "Session output continued after completion. Exact output could not be recovered. Retry the command.",
            { code: "provider", provider: "daytona", sandboxId: box.id },
          );

        if (line === "X:") {
          bridgeFinished = true;
          activityFinished = true;

          for (const stream of ["stdout", "stderr"] as const) {
            const text = decoders[stream].decode();

            if (!finished && text) input.onChunk({ stream, text });
          }

          continue;
        }

        const frame = /^(O|E):([A-Za-z0-9+/]*={0,2})$/.exec(line);

        if (
          !frame ||
          line.length > 5466 ||
          Buffer.from(frame[2] ?? "", "base64").toString("base64") !== frame[2]
        )
          throw new SandboxError(
            "Session output is malformed. Exact output could not be recovered. Retry the command.",
            { code: "provider", provider: "daytona", sandboxId: box.id },
          );
        const stream = frame[1] === "O" ? "stdout" : "stderr";

        const decoded = decoders[stream].decode(Buffer.from(frame[2] ?? "", "base64"), {
          stream: true,
        });

        if (!finished && decoded) input.onChunk({ stream, text: decoded });
      }

      if (bridgeFinished && pending.length)
        throw new SandboxError(
          "Session output continued after completion. Exact output could not be recovered. Retry the command.",
          { code: "provider", provider: "daytona", sandboxId: box.id },
        );

      if (pending.length > 5466)
        throw new SandboxError(
          "Session output frame is too large. Exact output could not be recovered. Retry the command.",
          { code: "provider", provider: "daytona", sandboxId: box.id },
        );
    };

    const acceptFrames = (text: string) => {
      try {
        if (logsError === undefined) readFrames(text);
      } catch (error) {
        logsError = error;
      }
    };

    const logs = persistent
      ? Promise.resolve()
      : box.process
          .getSessionCommandLogs(session, commandId, acceptFrames, (text) => {
            if (!finished) input.onChunk({ stream: "stderr", text });
          })
          .then(() => {
            if (pending.trim())
              throw new SandboxError(
                "Session output is incomplete. Exact output could not be recovered. Retry the command.",
                { code: "provider", provider: "daytona", sandboxId: box.id },
              );

            for (const stream of ["stdout", "stderr"] as const) {
              const text = decoders[stream].decode();

              if (!finished && text) input.onChunk({ stream, text });
            }
          });

    let logsFinished = false;
    void logs.then(
      () => {
        logsFinished = true;
      },
      (error) => {
        logsError = error;
        logsFinished = true;
      },
    );
    const started = Date.now();

    while (pid === undefined) {
      try {
        const value = Number(Buffer.from(await download(box, pidPath)).toString());

        if (!Number.isSafeInteger(value) || value <= 1)
          throw new SandboxError(
            "Invalid process group ID. Remote launch was not confirmed. Destroy the sandbox.",
            { code: "outcome_unknown", provider: "daytona", sandboxId: box.id },
          );
        pid = value;
      } catch (error) {
        if (error instanceof SandboxError && error.code !== "file_not_found") throw error;
        const status = await box.process.getSessionCommand(session, commandId);

        if (status.exitCode !== undefined) {
          pid = 0;
          break;
        }

        if (Date.now() - started > 10_000)
          throw new SandboxError(
            "Process launch was not confirmed. No PID arrived in ten seconds. Destroy the sandbox.",
            { code: "outcome_unknown", provider: "daytona", sandboxId: box.id },
          );
        await sleep(10);
      }
    }

    const id = commandId;

    const wait = (async () => {
      try {
        let cancelDrainStarted: number | undefined;

        while (true) {
          // Detachment leaves the remote session and durable wrapper alive, with
          // no timer or WebSocket keeping the local client attached.
          if (detached) await new Promise<void>(() => {});

          if (logsError !== undefined && !cancelled) throw logsError;

          if (cancelled && pid) await signal("KILL");
          let status: Awaited<ReturnType<Sandbox["process"]["getSessionCommand"]>>;

          try {
            status = await box.process.getSessionCommand(session, id);
          } catch (error) {
            if (!persistent || cancelled) throw error;

            if (daytonaError(error).code === "not_found")
              return { exitCode: 137, signal: "SIGKILL" };
            await sleep(1000);
            continue;
          }

          if (logsError !== undefined && !cancelled) throw logsError;

          if (status.exitCode !== undefined) {
            if (cancelled) cancelDrainStarted ??= Date.now();

            if (
              logsFinished ||
              bridgeFinished ||
              (cancelDrainStarted !== undefined && Date.now() - cancelDrainStarted >= 1000)
            ) {
              return {
                exitCode: cancelled ? null : status.exitCode,
                signal: cancelled ? "SIGKILL" : null,
              };
            }
          }

          await sleep(20);
        }
      } catch (error) {
        if (pid && !persistent) await signal("KILL");
        throw error;
      } finally {
        finished = true;
        // Session/file cleanup is best effort after a confirmed exit. It must
        // never replace the result or corrupt core's durable exit record.
        await cleanup().catch(() => {});
      }
    })();

    // startProcess may be consumed later; attach a rejection observer immediately.
    void wait.catch(() => {});
    let stopped = false;

    return {
      pid,
      wait: () => wait,
      detach() {
        detached = true;
      },
      async stop({ graceMs }) {
        if (stopped) return;

        if (pid) await signal("TERM");
        await sleep(graceMs);

        // The leader may exit before TERM-ignoring children. Always kill the group.
        if (pid) await signal("KILL");
        await wait;
        stopped = true;
      },
    };
  } catch (error) {
    // Without a confirmed PID, deleting a session alone cannot prove all children
    // died. Stop the sandbox to fail closed on ambiguous launch failures.
    try {
      if (pid) await signal("KILL");
      else if (created) await box.stop();
    } finally {
      await cleanup();
    }

    throw error;
  }
}

export async function execute(
  box: Sandbox,
  input: ExecInput & { streaming?: boolean },
  prepare = workspaceCommand,
  prepared?: () => void,
): Promise<ExecResult> {
  // Only explicit live-chunk requests need a session. Core-internal commands
  // (checkpoints, secret probes, process helpers) omit the flag and collect output.
  // Stdin always goes through a session upload: carrying it in the command line
  // would expose it in the guest's process list.
  if (input.streaming !== true && input.stdin === undefined)
    return bufferedExecute(box, input, prepare, prepared);
  const process = await sessionProcess(box, input, input.timeoutMs, prepare);

  if (process.pid > 0) prepared?.();
  const result = await process.wait();

  return { exitCode: result.exitCode, timedOut: result.signal === "SIGKILL" };
}
