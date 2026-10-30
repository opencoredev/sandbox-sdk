/** Parsers for the JSON the process shim keeps in the guest and hands back to callers. */
import { invalid } from "../errors.js";
import type { StartOptions } from "../processes.js";
import { isJsonObject, type JsonValue } from "../shared/json.js";
import { isNumber, isString } from "../shared/narrow.js";

/** The fields of spec.json the core reads back. */
export interface ProcessRecord {
  command: string;
  startedAt: number;
  port: number | undefined;
}

/** What restart.json holds: the original command and its start options. */
export interface RestartRecord {
  command: string | undefined;
  options: StartOptions;
}

/** Where a lines() cursor resumes: a log offset plus each stream's unfinished line. */
export interface LinePosition {
  offset: string | undefined;
  pending: { stdout: string; stderr: string };
}

export function parseProcessRecord(text: string): ProcessRecord {
  const raw: JsonValue = JSON.parse(text);

  if (!isJsonObject(raw)) invalid("Invalid process record");
  const { command, startedAt, port } = raw;

  if (!isString(command) || !isNumber(startedAt)) invalid("Invalid process record");

  return { command, startedAt, port: isNumber(port) ? port : undefined };
}

/** Fields of the wrong type are dropped, so a record from an older SDK still restarts. */
export function parseRestartRecord(text: string, name: string): RestartRecord {
  const raw: JsonValue = JSON.parse(text);

  if (!isJsonObject(raw)) invalid("Invalid process restart record");
  const { command, cwd, env, readyTimeoutMs, readiness } = raw;
  const options: StartOptions = { name };

  if (isString(cwd)) options.cwd = cwd;

  if (isJsonObject(env)) {
    options.env = {};

    for (const [key, value] of Object.entries(env)) if (isString(value)) options.env[key] = value;
  }

  if (isNumber(readyTimeoutMs)) options.readyTimeoutMs = readyTimeoutMs;

  // A log pattern is stored as its source and flags.
  if (isJsonObject(readiness)) {
    const { log, flags, port, http } = readiness;

    if (isString(log)) options.ready = { log: new RegExp(log, isString(flags) ? flags : "") };
    else if (isNumber(port)) options.ready = { port };
    else if (isJsonObject(http) && isNumber(http.port))
      options.ready = {
        http: { port: http.port, path: isString(http.path) ? http.path : undefined },
      };
  }

  return { command: isString(command) ? command : undefined, options };
}

/** A cursor is a bare log offset, or JSON that also carries each stream's partial line. */
export function parseLineCursor(after: string | undefined): LinePosition {
  const empty = { stdout: "", stderr: "" };

  if (after === undefined || /^\d+$/.test(after)) return { offset: after, pending: empty };

  if (Buffer.byteLength(after) > 1_048_576) invalid("Invalid line cursor");
  let raw: JsonValue;

  try {
    raw = JSON.parse(after);
  } catch {
    invalid("Invalid line cursor");
  }

  if (!isJsonObject(raw)) invalid("Invalid line cursor");
  const { v, offset, stdout, stderr } = raw;

  if (
    v !== 1 ||
    !isString(offset) ||
    !/^\d+$/.test(offset) ||
    !Number.isSafeInteger(Number(offset)) ||
    !isString(stdout) ||
    !isString(stderr) ||
    Buffer.byteLength(stdout) > 65_536 ||
    Buffer.byteLength(stderr) > 65_536
  )
    invalid("Invalid line cursor");

  return { offset, pending: { stdout, stderr } };
}
