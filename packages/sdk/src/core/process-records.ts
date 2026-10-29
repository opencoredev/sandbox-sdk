/** Parsers for the JSON the process shim keeps in the guest and hands back to callers. */
import { invalid } from "../errors.js";
import type { StartOptions } from "../processes.js";
import { hasNumber, hasString, isObject, isString } from "./guards.js";

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
  const raw: unknown = JSON.parse(text);

  if (!hasString(raw, "command") || !hasNumber(raw, "startedAt")) invalid("Invalid process record");

  return {
    command: raw.command,
    startedAt: raw.startedAt,
    port: hasNumber(raw, "port") ? raw.port : undefined,
  };
}

/** Fields of the wrong type are dropped, so a record from an older SDK still restarts. */
export function parseRestartRecord(text: string, name: string): RestartRecord {
  const raw: unknown = JSON.parse(text);

  if (!isObject(raw)) invalid("Invalid process restart record");
  const options: StartOptions = { name };

  if (hasString(raw, "cwd")) options.cwd = raw.cwd;

  if ("env" in raw && isObject(raw.env)) {
    options.env = {};

    for (const [key, value] of Object.entries(raw.env))
      if (isString(value)) options.env[key] = value;
  }

  if (hasNumber(raw, "readyTimeoutMs")) options.readyTimeoutMs = raw.readyTimeoutMs;

  // A log pattern is stored as its source and flags.
  if ("readiness" in raw && isObject(raw.readiness)) {
    const ready = raw.readiness;

    if (hasString(ready, "log"))
      options.ready = { log: new RegExp(ready.log, hasString(ready, "flags") ? ready.flags : "") };
    else if (hasNumber(ready, "port")) options.ready = { port: ready.port };
    else if ("http" in ready && hasNumber(ready.http, "port"))
      options.ready = {
        http: {
          port: ready.http.port,
          path: hasString(ready.http, "path") ? ready.http.path : undefined,
        },
      };
  }

  return { command: hasString(raw, "command") ? raw.command : undefined, options };
}

/** A cursor is a bare log offset, or JSON that also carries each stream's partial line. */
export function parseLineCursor(after: string | undefined): LinePosition {
  const empty = { stdout: "", stderr: "" };

  if (after === undefined || /^\d+$/.test(after)) return { offset: after, pending: empty };

  if (Buffer.byteLength(after) > 1_048_576) invalid("Invalid line cursor");
  let raw: unknown;

  try {
    raw = JSON.parse(after);
  } catch {
    invalid("Invalid line cursor");
  }

  if (
    !hasNumber(raw, "v") ||
    raw.v !== 1 ||
    !hasString(raw, "offset") ||
    !/^\d+$/.test(raw.offset) ||
    !Number.isSafeInteger(Number(raw.offset)) ||
    !hasString(raw, "stdout") ||
    !hasString(raw, "stderr") ||
    Buffer.byteLength(raw.stdout) > 65_536 ||
    Buffer.byteLength(raw.stderr) > 65_536
  )
    invalid("Invalid line cursor");

  return { offset: raw.offset, pending: { stdout: raw.stdout, stderr: raw.stderr } };
}
