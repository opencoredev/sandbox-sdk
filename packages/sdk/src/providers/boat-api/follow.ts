/** Follows a detached command's output: `GET /sandboxes/{sandboxId}/commands/{processId}/stream`, NDJSON.
 *
 * The same contract as @boatdev/sdk 1.9.9 `followCommand`:
 * - Frames: `attached` first, `stdout`/`stderr` chunks with `nextOffset`, `heartbeat` every 15 s, then one
 *   of `exit`, `error` or `reconnect` last. Offsets are bytes, per stream.
 * - The server ends each connection after 10 minutes with `reconnect`; this opens the stream again from
 *   its offsets at once.
 * - 60 s without a line (heartbeats included) is a dead connection.
 * - After the first good connection, a dropped connection, an idle timeout, a 5xx or a body that ends
 *   without a last frame is retried every second for up to 60 s. The first connection is never retried
 *   here, so a missing process fails fast.
 *
 * Output is yielded exactly once: a chunk that ends at or before the current offset (a replay after a
 * reconnect) is dropped, and `heartbeat`, `reconnect` and `exit` offsets only move forward. `attached`
 * says where this connection's output starts: the offset asked for, or 0 when Boat replaced the log.
 * Like the SDK, a lower `attached` offset is taken as is, so a replaced log's output is not dropped.
 */
import { type JsonValue, isJsonObject, type JsonObject } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { SandboxError } from "../../errors.js";
import { createDeadline, sleep } from "../../http.js";
import { ndjson, streamFault } from "../../streams.js";
import type { BoatHttp } from "./transport.js";

export type CommandFrame =
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; exitCode: number | null; timedOut: boolean }
  | { type: "error" };

export interface FollowTiming {
  /** Longest silence, including before the response headers. */
  idleMs: number;
  /** How long failing reconnects are tried. */
  retryWindowMs: number;
  /** Pause between failing reconnects. */
  retryDelayMs: number;
}

export const followTiming: FollowTiming = {
  idleMs: 60_000,
  retryWindowMs: 60_000,
  retryDelayMs: 1_000,
};

/** A wire frame, parsed. Unknown types are skipped for forward compatibility. */
type WireFrame =
  | { type: "stdout" | "stderr"; data: string; nextOffset?: number }
  | { type: "attached" | "heartbeat" | "reconnect"; stdoutOffset?: number; stderrOffset?: number }
  | { type: "exit"; exitCode: number | null; timedOut: boolean }
  | { type: "error" }
  | { type: "other" };

const offset = (value: JsonObject, key: string): number | undefined => {
  const found = value[key];

  return isNumber(found) && Number.isSafeInteger(found) && found >= 0 ? found : undefined;
};

function parseFrame(
  value: JsonValue | undefined,
  malformed: (what: string, code?: "outcome_unknown") => SandboxError,
): WireFrame {
  if (!isJsonObject(value) || !isString(value.type)) throw malformed("a frame has no type");

  switch (value.type) {
    case "stdout":
    case "stderr": {
      if (!("data" in value) || !isString(value.data))
        throw malformed("an output frame has no data");
      const nextOffset = offset(value, "nextOffset");

      return {
        type: value.type,
        data: value.data,
        nextOffset,
      };
    }

    case "attached":
    case "heartbeat":
    case "reconnect": {
      const stdoutOffset = offset(value, "stdoutOffset"),
        stderrOffset = offset(value, "stderrOffset");

      return {
        type: value.type,
        stdoutOffset,
        stderrOffset,
      };
    }

    case "exit": {
      const exitCode: unknown = "exitCode" in value ? value.exitCode : undefined;

      // The command ended, but how is unknown.
      if (exitCode !== null && !isNumber(exitCode))
        throw malformed("the exit frame has no exit code", "outcome_unknown");

      return { type: "exit", exitCode, timedOut: "timedOut" in value && value.timedOut === true };
    }

    case "error":
      return { type: "error" };
    default:
      return { type: "other" };
  }
}

/** Whether a failure after a good connection is worth another attach. */
function resumable(cause: unknown): boolean {
  const fault = streamFault(cause);

  if (fault) return fault === "disconnected" || fault === "truncated";

  return (
    cause instanceof SandboxError && (cause.code === "unavailable" || cause.code === "timeout")
  );
}

export async function* followCommand(
  http: BoatHttp,
  id: string,
  processId: number,
  options: { signal: AbortSignal; timing?: FollowTiming },
): AsyncGenerator<CommandFrame, void, undefined> {
  const { signal } = options;
  const timing = options.timing ?? followTiming;
  const label = http.label;

  const aborted = () =>
    new SandboxError(`${label} command stream aborted. The signal was cancelled.`, {
      code: "aborted",
      provider: http.provider,
      sandboxId: id,
    });

  const malformed = (what: string, code: "provider" | "outcome_unknown" = "provider") =>
    new SandboxError(
      `${label} command stream is invalid: ${what}. Check the ${label} service and retry.`,
      { code, provider: http.provider, sandboxId: id },
    );

  const offsets = { stdout: 0, stderr: 0 };
  let connected = false;
  // Set at the first failure after a good connection; a connection that delivers a frame clears it.
  let failingSince: number | undefined;

  for (;;) {
    if (signal.aborted) throw aborted();

    try {
      const response = await http.stream({
        method: "GET",
        path: "/sandboxes/{sandboxId}/commands/{processId}/stream",
        params: { sandboxId: id, processId },
        sandboxId: id,
        query: { stdoutOffset: offsets.stdout, stderrOffset: offsets.stderr },
        signal,
        startupTimeoutMs: timing.idleMs,
        idleTimeoutMs: timing.idleMs,
      });

      connected = true;

      if (!response.body)
        throw new SandboxError(
          `${label} command stream has no body. The connection will be retried.`,
          { code: "unavailable", provider: http.provider, sandboxId: id, retryable: true },
        );
      let rotated = false;

      for await (const value of ndjson(response.body, {
        provider: http.provider,
        sandboxId: id,
        signal,
      })) {
        failingSince = undefined;
        const frame = parseFrame(value, malformed);

        switch (frame.type) {
          case "stdout":
          case "stderr":
            if (frame.nextOffset !== undefined) {
              // A chunk that ends at or before what was already yielded is a replay.
              if (frame.nextOffset <= offsets[frame.type]) break;
              offsets[frame.type] = frame.nextOffset;
            }

            if (frame.data) yield { type: frame.type, data: frame.data };
            break;
          case "exit":
          case "error":
            yield frame;

            return;
          case "attached":
            offsets.stdout = frame.stdoutOffset ?? offsets.stdout;
            offsets.stderr = frame.stderrOffset ?? offsets.stderr;
            break;
          case "heartbeat":
          case "reconnect":
            offsets.stdout = Math.max(offsets.stdout, frame.stdoutOffset ?? 0);
            offsets.stderr = Math.max(offsets.stderr, frame.stderrOffset ?? 0);
            rotated = frame.type === "reconnect";
            break;
          case "other":
            break;
          default: {
            const _exhaustive: never = frame;

            return _exhaustive;
          }
        }

        if (rotated) break;
      }

      // The scheduled rotation: open the stream again right away.
      if (rotated) continue;
      throw new SandboxError(
        `${label} command stream ended before the command did. The connection will be retried.`,
        { code: "unavailable", provider: http.provider, sandboxId: id, retryable: true },
      );
    } catch (error) {
      if (signal.aborted) throw aborted();
      failingSince ??= Date.now();

      if (!connected || !resumable(error) || Date.now() - failingSince >= timing.retryWindowMs)
        throw error;

      try {
        await sleep(
          timing.retryDelayMs,
          createDeadline(timing.retryWindowMs, signal),
          http.provider,
        );
      } catch {
        throw aborted();
      }
    }
  }
}
