import type { BoatApi } from "@boatdev/sdk";
import type { ExecInput, ExecResult } from "../../provider.js";
import { defaults } from "../../run.js";
import { errors } from "./errors.js";
export const workspace = `flock -x /tmp/.sandbox-sdk-workspace-ready.lock sh -c 'if [ ! -f /tmp/.sandbox-sdk/prepared-workspace ]; then sudo mkdir -p /workspace && sudo chown "$(id -u):$(id -g)" /workspace && command -v node git tar setsid nohup mkfifo sed base64 >/dev/null && mkdir -p /tmp/.sandbox-sdk && touch /tmp/.sandbox-sdk/prepared-workspace || exit 1; fi' || exit 1`;
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Detached commands have no 600-second limit. Boat's stopCommand kills the
 * command and all descendants. Aborting a stream alone does not stop remote work.
 */
export async function execute(api: BoatApi, id: string, input: ExecInput, sandboxEnv: Record<string, string> = {}, environmentFiles = new Map<string, Promise<string>>(), diagnostics = errors()): Promise<ExecResult> {
  const { boatError, failure } = diagnostics;
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
  let envDir: string | undefined;
  const setupError = `/tmp/.sandbox-sdk-setup-${crypto.randomUUID()}`;
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
    // Boat has no per-command env field. Transfer values through its files API,
    // inside a private directory, never through recorded command text or argv.
    let overrides = Object.entries(input.env).filter(([key, value]) =>
      !Object.entries(defaults).some(([name, setting]) => key === name && value === setting) && sandboxEnv[key] !== value);
    const fixed = Object.entries(defaults).filter(([key, value]) => input.env[key] === value);
    let environment = fixed.map(([key, value]) => `export ${quote(`${key}=${value}`)}`).join("; ");
    if (environment) environment += "; ";
    // Only the core's fixed, non-secret index path may bypass private env-file
    // transport. Arbitrary user values may be secrets, regardless of their size.
    const indexPath = "/tmp/.sandbox-sdk/changes.git/sdk.index";
    const inline = overrides.filter(([key, value]) => key === "GIT_INDEX_FILE" && value === indexPath);
    overrides = overrides.filter(([key, value]) => key !== "GIT_INDEX_FILE" || value !== indexPath);
    for (const [key, value] of inline) environment += `export ${quote(`${key}=${value}`)}; `;
    if (overrides.length) {
      const key = JSON.stringify(overrides);
      const cached = input.envMode === "sandbox" ? environmentFiles.get(key) : undefined;
      if (cached) {
        environment += `. ${quote(await cached)} || exit 1; `;
      } else {
        envDir = `/tmp/.sandbox-sdk/env-${crypto.randomUUID()}`;
        const envPath = `${envDir}/env`;
        const directory = envDir;
        const prepare = async () => {
          const script = "const f=require('fs');f.mkdirSync('/tmp/.sandbox-sdk',{recursive:true});f.mkdirSync(process.argv[1],{mode:0o700});f.writeFileSync(process.argv[1]+'/env','',{flag:'wx',mode:0o600})";
          const result = await api.command({ sandboxId: id, commandRequest: {
            command: `node -e ${quote(script)} ${quote(directory)}`, timeoutSeconds: 60,
          } });
          if (!("exitCode" in result) || result.exitCode !== 0)
            throw failure("Boat could not prepare command environment", "provider", id);
          await api.writeFile({ sandboxId: id, fileWriteRequest: {
            path: envPath, content: overrides.map(([key, value]) => `export ${quote(`${key}=${value}`)}`).join("\n") + "\n", encoding: "utf8",
          } });
          return envPath;
        };
        const prepared = prepare();
        if (input.envMode === "sandbox") environmentFiles.set(key, prepared);
        try { await prepared; }
        catch (error) { if (input.envMode === "sandbox") environmentFiles.delete(key); throw error; }
        if (input.envMode === "sandbox") {
          // Retain the private file for this sandbox's stable handle env. Only
          // explicit per-run overrides need another upload and eager deletion.
          envDir = undefined;
          environment += `. ${quote(envPath)} || exit 1; `;
        } else {
          environment += `chmod 600 ${quote(envPath)} && . ${quote(envPath)} && /bin/rm -f -- ${quote(envPath)} && /bin/rmdir -- ${quote(directory)} || exit 1; `;
        }
      }
    }
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
    const command = `(${workspace}) || { echo setup-failed > ${quote(setupError)}; exit 125; }; ${source}(${environment}cd ${quote(input.cwd)} && exec sh -c ${quote(input.command)})${redirect}`;
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
    if (!result.timedOut && result.exitCode === 125) {
      const status = await api.command({ sandboxId: id, commandRequest: {
        command: `if [ -f ${quote(setupError)} ]; then cat ${quote(setupError)}; rm -f -- ${quote(setupError)}; fi`, timeoutSeconds: 10,
      } });
      if (!("stdout" in status) || status.exitCode !== 0) throw failure("Boat could not confirm command initialization", "outcome_unknown", id);
      if (status.stdout.trim() === "setup-failed") throw failure("Boat workspace initialization failed; the requested command did not run", "provider", id);
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
    if (envDir)
      await api
        .command({
          sandboxId: id,
          commandRequest: { command: `rm -rf -- ${quote(envDir)}`, timeoutSeconds: 10 },
        })
        .catch(() => {});
    if (stdinPath)
      await api
        .command({
          sandboxId: id,
          commandRequest: { command: `rm -f -- ${quote(stdinPath)}`, timeoutSeconds: 10 },
        })
        .catch(() => {});
  }
}
