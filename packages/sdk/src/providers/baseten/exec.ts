/**
 * Commands over the sandbox's process API (`POST /process`). Each command is a named process in its
 * own process group, so `DELETE /process/{name}/kill` ends the whole group. Short buffered commands
 * wait for completion in one request; streamed and long ones follow `GET /process/{name}/logs/stream`
 * as NDJSON, because a blocking request does not outlive the edge's response timeout.
 */
import type { ExecInput, ExecResult } from "../../provider.js";
import type { HttpClient } from "../../http.js";
import { SandboxError } from "../../errors.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { quote } from "../../shared/shell.js";
import { ndjson } from "../../streams.js";
import { failure } from "./errors.js";

export type BasetenPlane = "api" | "sandbox";

/** A blocking request beyond this is cut by the edge (about 120 s); longer commands stream instead. */
const blockingLimitMs = 90_000;
/** The largest buffered response: the process API returns stdout and stderr whole. */

const responseLimit = 64 * 1024 * 1024;
const pollMs = 100;
const maxStreamBreaks = 3;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ProcessState {
  status: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function parseProcess(raw: JsonValue | undefined, id: string): ProcessState {
  if (!isJsonObject(raw) || !isString(raw.status))
    throw failure("Baseten returned a process without a status", "provider", id);

  return {
    status: raw.status,
    exitCode: isNumber(raw.exitCode) ? raw.exitCode : 0,
    stdout: isString(raw.stdout) ? raw.stdout : "",
    stderr: isString(raw.stderr) ? raw.stderr : "",
  };
}

/** A process killed by any other cause reports -1: the signal is unnamed, so report SIGKILL's code. */
const exitOf = (state: ProcessState) => (state.exitCode < 0 ? 137 : state.exitCode);

export async function execute(
  http: HttpClient<BasetenPlane>,
  id: string,
  input: ExecInput,
): Promise<ExecResult> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const name = `sdk-${crypto.randomUUID()}`;
  const sandbox = { plane: "sandbox" as const, sandboxId: id };
  let stdinPath: string | undefined;

  // Stdin travels as a private file, never in the command line, so it stays out of the guest's process list.
  if (input.stdin !== undefined) {
    stdinPath = `/tmp/.sandbox-sdk/stdin-${crypto.randomUUID()}`;
    const form = new FormData();
    form.append("file", new Blob([new TextEncoder().encode(input.stdin)]), "stdin");
    form.append("permissions", "0600");
    await http.request({
      method: "PUT",
      path: "/filesystem/{path}",
      params: { path: stdinPath },
      ...sandbox,
      body: form,
    });
  }

  // A missing cwd fails the command (exit 2), as the shell reports it, not the request.
  const command = [
    stdinPath ? `exec < ${quote(stdinPath)} && rm -f ${quote(stdinPath)} || exit 125` : "",
    `cd ${quote(input.cwd)} || exit 2`,
    input.command,
  ]
    .filter(Boolean)
    .join("\n");

  // Baseten's own deadline is whole seconds; ours kills at the exact time and theirs is the backstop.
  const seconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));
  const started = Date.now();
  let killed = false;
  let settled = false;

  async function kill() {
    if (killed) return;
    killed = true;

    // The kill can reach the sandbox before the launch does: retry until the process exists or settles.
    while (!settled) {
      try {
        await http.cleanup({
          method: "DELETE",
          path: "/process/{name}/kill",
          params: { name },
          ...sandbox,
        });

        return;
      } catch (error) {
        if (!(error instanceof SandboxError) || error.code !== "not_found") return;
        await delay(pollMs);
      }
    }
  }

  const timer = setTimeout(() => void kill(), input.timeoutMs);
  const onAbort = () => void kill();
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const emit = (stream: "stdout" | "stderr", text: string) => {
    if (text) input.onChunk({ stream, text });
  };

  // Killed by our deadline or abort, or by Baseten's whole-second deadline: a timeout. Any other kill is an exit.
  const outcome = (end: ProcessState): ExecResult =>
    end.status === "killed" && (killed || Date.now() - started >= input.timeoutMs)
      ? { exitCode: null, timedOut: true }
      : { exitCode: exitOf(end), timedOut: false };

  const state = async () =>
    parseProcess(
      await http.json({ method: "GET", path: "/process/{name}", params: { name }, ...sandbox }),
      id,
    );

  try {
    if (input.streaming !== true && input.timeoutMs <= blockingLimitMs) {
      let result: ProcessState;

      try {
        result = parseProcess(
          await http.json({
            method: "POST",
            path: "/process",
            ...sandbox,
            body: {
              name,
              command,
              workingDir: "/",
              env: input.env,
              waitForCompletion: true,
              timeout: seconds,
            },
            timeoutMs: input.timeoutMs + 30_000,
            maxBytes: responseLimit,
          }),
          id,
        );
      } catch (error) {
        // Baseten answers 422 when its own deadline killed the process; the partial output is in its logs.
        if (!(error instanceof SandboxError) || error.code !== "invalid_argument") throw error;
        let current: ProcessState;

        try {
          current = await state();
        } catch {
          throw error;
        }

        if (current.status === "running") throw error;
        result = current;
      }

      settled = true;
      emit("stdout", result.stdout);
      emit("stderr", result.stderr);

      return outcome(result);
    }

    await http.json({
      method: "POST",
      path: "/process",
      ...sandbox,
      body: {
        name,
        command,
        workingDir: "/",
        env: input.env,
        waitForCompletion: false,
        timeout: seconds,
      },
    });

    // A log stream that drops (the edge cuts quiet connections) is reopened; its replay is skipped by size.
    const seen = { stdout: 0, stderr: 0 };
    const delivered = { stdout: 0, stderr: 0 };
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

    let breaks = 0;

    for (;;) {
      let broken: unknown;
      const stop = new AbortController();
      const stopOnKill = setInterval(() => killed && stop.abort(), pollMs);

      try {
        const response = await http.stream({
          method: "GET",
          path: "/process/{name}/logs/stream",
          params: { name },
          ...sandbox,
          headers: { accept: "application/x-ndjson" },
          signal: stop.signal,
        });

        if (response.body)
          for await (const value of ndjson(response.body, {
            provider: "baseten",
            sandboxId: id,
            signal: stop.signal,
          })) {
            if (!isJsonObject(value) || (value.type !== "stdout" && value.type !== "stderr"))
              continue;
            const stream = value.type;

            if (!isString(value.data)) continue;

            let bytes: Uint8Array =
              value.encoding === "base64"
                ? Buffer.from(value.data, "base64")
                : new TextEncoder().encode(value.data);

            const skip = Math.min(bytes.length, Math.max(0, seen[stream]));
            seen[stream] -= skip;
            bytes = bytes.subarray(skip);

            if (!bytes.length) continue;
            delivered[stream] += bytes.length;
            emit(stream, decoders[stream].decode(bytes, { stream: true }));
          }
      } catch (error) {
        broken = killed ? undefined : error;
      } finally {
        clearInterval(stopOnKill);
      }

      // A broken stream is read again, replay skipped, even for a finished process: its log is kept.
      if (broken !== undefined) {
        if (++breaks > maxStreamBreaks) throw broken;
        seen.stdout = delivered.stdout;
        seen.stderr = delivered.stderr;
        continue;
      }

      let current = await state();

      while (killed && current.status === "running") {
        await delay(pollMs);
        current = await state();
      }

      if (current.status === "running") {
        seen.stdout = delivered.stdout;
        seen.stderr = delivered.stderr;
        continue;
      }

      settled = true;
      emit("stdout", decoders.stdout.decode());
      emit("stderr", decoders.stderr.decode());

      return outcome(current);
    }
  } finally {
    settled = true;
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
