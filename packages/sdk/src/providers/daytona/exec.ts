import type { Sandbox } from "@daytonaio/sdk";
import type { ExecInput, ExecResult, NativeProcess } from "../../provider.js";
import { daytonaError } from "./errors.js";
import { SandboxError } from "../../errors.js";

export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Each call has a new session and process group. Stdin comes from a private file
 * because session input has no documented EOF operation. Native process hooks
 * run core's durable wrapper unchanged, so logs survive client detachment.
 */
export async function sessionProcess(box: Sandbox, input: Omit<ExecInput, "timeoutMs">, timeoutMs?: number): Promise<NativeProcess & { detach(): void }> {
  const session = `sdk-${crypto.randomUUID()}`;
  const dir = `/tmp/.sandbox-sdk/exec/${session}`;
  const pidPath = `${dir}/pid`;
  let cancelled = input.signal?.aborted ?? false;
  let pid: number | undefined;
  let commandId: string | undefined;
  let created = false;
  let finished = false; let detached = false;
  const persistent = timeoutMs === undefined;
  const abort = () => { cancelled = true; };
  const timer = timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
  input.signal?.addEventListener("abort", abort, { once: true });
  async function signal(kind: "TERM" | "KILL") {
    if (pid === undefined) return;
    const result = await box.process.executeCommand(`/bin/kill -${kind} -- -${pid} 2>/dev/null || ! /bin/kill -0 -- -${pid} 2>/dev/null`, "/", undefined, 10);
    if (result.exitCode !== 0) throw new SandboxError("Remote process group could not be killed. Cancellation is unconfirmed. Destroy the sandbox before retrying.", { code: "outcome_unknown", provider: "daytona", sandboxId: box.id });
  }
  async function cleanup() {
    clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
    if (created) { try { await box.process.deleteSession(session); } catch (error) { if (daytonaError(error).code !== "not_found") throw error; } }
    try { await box.fs.deleteFile(dir, true); } catch (error) { if (daytonaError(error, box.id, true).code !== "file_not_found") throw error; }
  }
  try {
    await box.fs.createFolder(dir, "700");
    await box.fs.uploadFile(Buffer.from(input.stdin ?? ""), `${dir}/stdin`);
    if (cancelled) { await cleanup(); return { pid: 0, wait: async () => ({ exitCode: null, signal: "SIGKILL" }), stop: async () => {}, detach() {} }; }
    await box.process.createSession(session); created = true;
    const env = Object.entries(input.env).map(([key, value]) => quote(`${key}=${value}`)).join(" ");
    const script = `umask 077; echo $$ > ${quote(`${pidPath}.tmp`)}; mv ${quote(`${pidPath}.tmp`)} ${quote(pidPath)}; cd ${quote(input.cwd)} || exit 1; exec env ${env} sh -c ${quote(input.command)} < ${quote(`${dir}/stdin`)}`;
    const response = await box.process.executeSessionCommand(session, { command: `setsid --wait sh -c ${quote(script)}`, runAsync: true, suppressInputEcho: true });
    commandId = response.cmdId;
    if (!commandId) throw new SandboxError("Session command has no ID. Daytona did not confirm launch. Inspect or destroy the sandbox.", { code: "outcome_unknown", provider: "daytona", sandboxId: box.id });
    // Observe both promises immediately: stream failures must not become unhandled.
    const logs = persistent ? Promise.resolve() : box.process.getSessionCommandLogs(session, commandId, text => { if (!finished) input.onChunk({ stream: "stdout", text }); }, text => { if (!finished) input.onChunk({ stream: "stderr", text }); });
    let logsFinished = false; let logsError: unknown;
    void logs.then(() => { logsFinished = true; }, error => { logsError = error; logsFinished = true; });
    const started = Date.now();
    while (pid === undefined) {
      try {
        const value = Number((await box.fs.downloadFile(pidPath)).toString());
        if (!Number.isSafeInteger(value) || value <= 1) throw new SandboxError("Invalid process group ID. Remote launch was not confirmed. Destroy the sandbox.", { code: "outcome_unknown", provider: "daytona", sandboxId: box.id });
        pid = value;
      } catch (error) {
        if (error instanceof SandboxError) throw error;
        const status = await box.process.getSessionCommand(session, commandId);
        if (status.exitCode !== undefined) { pid = 0; break; }
        if (Date.now() - started > 10_000) throw new SandboxError("Process launch was not confirmed. No PID arrived in ten seconds. Destroy the sandbox.", { code: "outcome_unknown", provider: "daytona", sandboxId: box.id });
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
          try { status = await box.process.getSessionCommand(session, id); }
          catch (error) {
            if (!persistent || cancelled) throw error;
            if (daytonaError(error).code === "not_found") return { exitCode: 137, signal: "SIGKILL" };
            await sleep(1000); continue;
          }
          if (status.exitCode !== undefined) {
            if (cancelled) cancelDrainStarted ??= Date.now();
            if (logsFinished || (cancelDrainStarted !== undefined && Date.now() - cancelDrainStarted >= 1000)) {
              return { exitCode: cancelled ? null : status.exitCode, signal: cancelled ? "SIGKILL" : null };
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
    return { pid, wait: () => wait, detach() { detached = true; }, async stop({ graceMs }) {
      if (stopped) return;
      if (pid) await signal("TERM");
      await sleep(graceMs);
      // The leader may exit before TERM-ignoring children. Always kill the group.
      if (pid) await signal("KILL");
      await wait; stopped = true;
    } };
  } catch (error) {
    // Without a confirmed PID, deleting a session alone cannot prove all children
    // died. Stop the sandbox to fail closed on ambiguous launch failures.
    try { if (pid) await signal("KILL"); else if (created) await box.stop(); } finally { await cleanup(); }
    throw error;
  }
}

export async function execute(box: Sandbox, input: ExecInput): Promise<ExecResult> {
  const process = await sessionProcess(box, input, input.timeoutMs);
  const result = await process.wait();
  return { exitCode: result.exitCode, timedOut: result.signal === "SIGKILL" };
}
