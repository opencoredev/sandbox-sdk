/** Parsers for Instabox's REST answers: each turns parsed JSON into the shape the adapter uses. */
import { posix } from "node:path";
import type { FileInfo, Labels, SandboxInfo } from "../../provider.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { fail, parseErrorBody } from "./errors.js";

/** The label that carries the SDK's sandbox key in a machine's metadata. */
export const keyLabel = "sandbox-sdk-key";

const pausedStates = new Set(["suspended", "suspending"]);
const runningStates = new Set(["running", "creating", "starting", "resuming"]);

/** A member of a JSON object, or undefined. */
export const field = (raw: JsonValue | undefined, key: string): JsonValue | undefined =>
  isJsonObject(raw) ? raw[key] : undefined;

export interface Machine {
  id: string;
  name: string;
  state: string;
  metadata: Labels;
  createdAt: number;
}

function labelsOf(raw: JsonValue | undefined): Labels {
  const labels: Labels = {};

  if (isJsonObject(raw))
    for (const [key, value] of Object.entries(raw)) if (isString(value)) labels[key] = value;

  return labels;
}

export function parseMachine(raw: JsonValue | undefined): Machine {
  const id = field(raw, "id");
  const name = field(raw, "name");
  const state = field(raw, "state");
  const created = field(raw, "createdAt");

  if (!isString(id) || !isString(name) || !isString(state) || !isString(created))
    throw fail("unexpected machine object from the API");
  const createdAt = Date.parse(created);

  if (!Number.isFinite(createdAt))
    throw fail("machine has no valid creation time", "provider", { sandboxId: id });

  return { id, name, state, metadata: labelsOf(field(raw, "metadata")), createdAt };
}

export interface Operation {
  id: string;
  machineId: string;
  /** Instabox's state; anything but `succeeded` and `failed` is still in progress. */
  state: string;
  errorCode: string | undefined;
}

export function parseOperation(raw: JsonValue | undefined): Operation {
  const id = field(raw, "id");
  const machineId = field(raw, "machineId");
  const state = field(raw, "state");

  if (!isString(id) || !isString(machineId) || !isString(state))
    throw fail("unexpected operation object from the API");
  const error = field(raw, "error");

  return {
    id,
    machineId,
    state,
    errorCode: error === undefined ? undefined : parseErrorBody({ error })?.code,
  };
}

export function isFinished(op: Operation) {
  return op.state === "succeeded" || op.state === "failed";
}

export interface MachinePage {
  machines: Machine[];
  nextCursor: string | null;
}

export function parseMachinePage(raw: JsonValue | undefined): MachinePage {
  const machines = field(raw, "machines");

  if (!Array.isArray(machines)) throw fail("unexpected machine list from the API");
  const cursor = field(raw, "nextCursor");

  return { machines: machines.map(parseMachine), nextCursor: isString(cursor) ? cursor : null };
}

export interface Snapshot {
  id: string;
  status: string;
}

export function parseSnapshot(raw: JsonValue | undefined): Snapshot {
  const id = field(raw, "id");
  const status = field(raw, "status");

  if (!isString(id) || !isString(status)) throw fail("unexpected snapshot object from the API");

  return { id, status };
}

export type ExecEvent =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "exit"; exitCode: number | null; timedOut: boolean }
  | { kind: "error"; code: string };

/** One server-sent event from `POST /v1/machines/{id}/exec`; unknown events are skipped. */
export function parseExecEvent(event: string, data: string): ExecEvent | undefined {
  let value: JsonValue | undefined;

  try {
    value = JSON.parse(data);
  } catch {
    throw fail(`exec stream sent invalid JSON in a ${event} event`);
  }

  if (!isJsonObject(value)) throw fail(`exec stream sent a non-object ${event} event`);

  switch (event) {
    case "stdout":
    case "stderr": {
      const text = field(value, "data");

      return { kind: event, text: isString(text) ? text : "" };
    }

    case "exit": {
      const exitCode = field(value, "exitCode");
      const timedOut = field(value, "timedOut") === true;

      return {
        kind: "exit",
        exitCode: !timedOut && isNumber(exitCode) ? exitCode : null,
        timedOut,
      };
    }

    case "error":
      // The usual envelope first, then a bare error object.
      return {
        kind: "error",
        code: (parseErrorBody(value) ?? parseErrorBody({ error: value }))?.code ?? "unknown",
      };
    default:
      return undefined;
  }
}

function fileType(value: string): FileInfo["type"] {
  if (value === "dir" || value === "directory") return "directory";

  if (value === "symlink") return "symlink";

  return "file";
}

export function parseEntry(dir: string, raw: JsonValue | undefined): FileInfo {
  const name = field(raw, "name");
  const type = field(raw, "type");

  if (!isString(name) || !isString(type)) throw fail("unexpected directory entry from the API");
  const size = field(raw, "size");
  const modTime = field(raw, "modTime");
  const modifiedAt = isString(modTime) ? Date.parse(modTime) : Number.NaN;

  return {
    path: posix.join(dir, name),
    type: fileType(type),
    size: isNumber(size) ? size : 0,
    modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : 0,
  };
}

/** A machine as the SDK sees it: the key label moves to `key`, the state to running, paused or stopped. */
export function toInfo(machine: Machine): SandboxInfo {
  const { [keyLabel]: key, ...labels } = machine.metadata;

  const state: SandboxInfo["state"] = pausedStates.has(machine.state)
    ? "paused"
    : runningStates.has(machine.state)
      ? "running"
      : "stopped";

  return key === undefined
    ? { id: machine.id, labels, state, createdAt: machine.createdAt }
    : { id: machine.id, key, labels, state, createdAt: machine.createdAt };
}

/** `stat -c '%F|%s|%.3Y'` output as a FileInfo. */
export function statLine(path: string, line: string): FileInfo {
  const [kind = "", size = "0", mtime = "0"] = line.split("|");

  const type: FileInfo["type"] =
    kind === "directory" ? "directory" : kind === "symbolic link" ? "symlink" : "file";

  return { path, type, size: Number(size), modifiedAt: Math.round(Number(mtime) * 1000) };
}

/** `find -printf '%P\0%y\0%s\0%T@\0'` output as FileInfo entries of `path`. */
export function findEntries(path: string, stdout: string): FileInfo[] {
  const fields = stdout.split("\0");
  const entries: FileInfo[] = [];

  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [entry = "", kind = "f", size = "0", mtime = "0"] = fields.slice(index, index + 4);
    entries.push({
      path: posix.join(path, entry),
      type: kind === "d" ? "directory" : kind === "l" ? "symlink" : "file",
      size: Number(size),
      modifiedAt: Math.round(Number(mtime) * 1000),
    });
  }

  return entries;
}
