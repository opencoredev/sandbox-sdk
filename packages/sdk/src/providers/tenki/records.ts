import { isBoolean, isNumber, isObject, isString } from "../../shared/narrow.js";

/** One encoded output chunk from a Tenki supervisor: base64 when paged, hex when streamed. */
export type Chunk = readonly [stream: "stdout" | "stderr", data: string];

/** A supervisor's exit record; the workspace fields are read separately. */
export type RunResult = { exitCode: number | null; timedOut: boolean };

/** At most 16384 bytes of base64, or 8192 of hex, per chunk. */
export function isChunk(value: unknown): value is Chunk {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (value[0] === "stdout" || value[0] === "stderr") &&
    isString(value[1]) &&
    value[1].length <= 21848
  );
}

export function isRunResult(value: unknown): value is RunResult {
  return (
    isObject(value) &&
    "exitCode" in value &&
    (value.exitCode === null || isNumber(value.exitCode)) &&
    "timedOut" in value &&
    isBoolean(value.timedOut)
  );
}
