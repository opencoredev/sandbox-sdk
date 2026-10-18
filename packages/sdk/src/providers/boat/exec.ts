import type { BoatApi } from "@boatdev/sdk";
import type { ExecInput, ExecResult } from "../../provider.js";
import { boatError, failure } from "./errors.js";
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Detached commands have no 600-second limit. Boat's stopCommand kills the
 * command and all descendants. Aborting a stream alone does not stop remote work.
 */
export async function execute(api: BoatApi, id: string, input: ExecInput): Promise<ExecResult> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const { followCommand } = await import("@boatdev/sdk");
  const stream = new AbortController();
  let cancelled = false;
  let cancel = () => {};
  const cancellation = new Promise<"cancelled">((resolve) => {
    cancel = () => {
      cancelled = true;
      resolve("cancelled");
    };
  });
  const timer = setTimeout(cancel, input.timeoutMs);
  input.signal?.addEventListener("abort", cancel, { once: true });
  let processId: number | undefined;
  let finished = false;
  let launchAttempted = false;
  let stdinPath: string | undefined;
  async function stop() {
    if (processId === undefined) return;
    try {
      const result = await api.stopCommand({ sandboxId: id, processId });
      if (result.running !== false)
        throw failure("Boat did not confirm process-tree cancellation", "outcome_unknown", id);
    } catch {
      throw failure(
        "Remote cancellation could not be confirmed; destroy the sandbox before retrying",
        "outcome_unknown",
        id,
      );
    }
  }
  try {
    const env = Object.entries(input.env)
      .map(([key, value]) => quote(`${key}=${value}`))
      .join(" ");
    // A finite pipe supplies stdin and EOF. Values never become shell syntax.
    const bytes = Buffer.from(input.stdin ?? "");
    let source = `printf %s ${quote(bytes.toString("base64"))} | base64 -d | `;
    let redirect = "";
    if (bytes.length > 16_384) {
      stdinPath = `/tmp/.sandbox-sdk/stdin-${crypto.randomUUID()}`;
      for (let offset = 0; offset < bytes.length; offset += 32_768) {
        if (cancelled) return { exitCode: null, timedOut: true };
        const script =
          "const f=require('fs');f.mkdirSync('/tmp/.sandbox-sdk',{recursive:true});f.writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'),{flag:process.argv[3],mode:0o600})";
        const result = await api.command({
          sandboxId: id,
          commandRequest: {
            command: `umask 077; node -e ${quote(script)} ${quote(stdinPath)} ${quote(bytes.subarray(offset, offset + 32_768).toString("base64"))} ${offset ? "a" : "w"}`,
            timeoutSeconds: 60,
          },
        });
        if (!("exitCode" in result) || result.exitCode !== 0)
          throw failure("Boat could not prepare command stdin", "provider", id);
      }
      source = "";
      redirect = ` < ${quote(stdinPath)}`;
    }
    if (cancelled) return { exitCode: null, timedOut: true };
    const command = `${source}(cd ${quote(input.cwd)} && exec env ${env} sh -c ${quote(input.command)})${redirect}`;
    launchAttempted = true;
    const started = await api.command({
      sandboxId: id,
      commandRequest: { command, detached: true },
    });
    if (
      !("processId" in started) ||
      !Number.isSafeInteger(started.processId) ||
      started.processId < 1
    )
      throw failure("Boat did not confirm a detached process ID", "outcome_unknown", id);
    processId = started.processId;
    if (input.signal?.aborted) cancel();
    const completion = (async (): Promise<ExecResult> => {
      for await (const frame of followCommand(api, id, started.processId, {
        signal: stream.signal,
      })) {
        if (frame.type === "stdout" || frame.type === "stderr") {
          if (typeof frame.data !== "string")
            throw failure("Invalid Boat output frame", "provider", id);
          input.onChunk({ stream: frame.type, text: frame.data });
        } else if (frame.type === "exit") {
          if (typeof frame.exitCode !== "number" && frame.exitCode !== null)
            throw failure("Boat returned no command exit code", "outcome_unknown", id);
          finished = true;
          return { exitCode: frame.exitCode, timedOut: frame.timedOut === true };
        } else if (frame.type === "error")
          throw failure("Boat command stream failed", "provider", id);
      }
      throw failure("Boat stream ended without an exit result", "outcome_unknown", id);
    })();
    void completion.catch(() => {});
    const result = await Promise.race([completion, cancellation]);
    if (result === "cancelled" || cancelled) {
      await stop();
      stream.abort();
      await completion.catch(() => {});
      return { exitCode: null, timedOut: true };
    }
    return result;
  } catch (error) {
    if (processId !== undefined && !finished) await stop();
    if (
      launchAttempted &&
      processId === undefined &&
      !["auth", "quota", "invalid_argument", "not_found"].includes(boatError(error, id).code)
    )
      throw failure(
        "Command launch outcome is unknown; inspect or destroy the sandbox before retrying",
        "outcome_unknown",
        id,
      );
    throw error;
  } finally {
    stream.abort();
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    if (stdinPath)
      await api
        .command({
          sandboxId: id,
          commandRequest: { command: `rm -f -- ${quote(stdinPath)}`, timeoutSeconds: 10 },
        })
        .catch(() => {});
  }
}
