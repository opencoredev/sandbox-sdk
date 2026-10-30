import { isBoolean, isNumber, isObject, isString } from "../../shared/narrow.js";

/** One encoded output chunk from a Tenki supervisor: base64 when paged, hex when streamed. */
export type Chunk = readonly [stream: "stdout" | "stderr", data: string];

/** A supervisor's exit record. The paged supervisor writes the workspace root as text;
 * the streaming one formats its JSON by hand, so it sends the root hex-encoded.
 * `workspaceStable` is true when no process the command started outlived it.
 */
export interface ExitRecord {
  exitCode: number | null;
  timedOut: boolean;
  workspaceStable?: boolean;
  workspaceRoot?: string;
  workspaceRootHex?: string;
}

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

export function isExitRecord(value: unknown): value is ExitRecord {
  return (
    isObject(value) &&
    "exitCode" in value &&
    (value.exitCode === null || (isNumber(value.exitCode) && Number.isInteger(value.exitCode))) &&
    "timedOut" in value &&
    isBoolean(value.timedOut) &&
    (!("workspaceStable" in value) || isBoolean(value.workspaceStable)) &&
    (!("workspaceRoot" in value) || isString(value.workspaceRoot)) &&
    (!("workspaceRootHex" in value) || isString(value.workspaceRootHex))
  );
}
