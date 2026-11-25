/**
 * Parsers for Buddy's Sandboxes API answers (https://buddy.works/openapi.json, retrieved 2026-11-24), each
 * checked against live answers the same day. Every parser takes parsed JSON and returns only the fields
 * the adapter uses.
 */
import { createHash } from "node:crypto";
import type { Labels, SandboxInfo } from "../../provider.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../../shared/json.js";
import { isBoolean, isNumber, isString } from "../../shared/narrow.js";
import { fail } from "./errors.js";

/** The tag every SDK sandbox carries. Buddy tags cannot hold `:`, so labels live in the note. */
export const sdkTag = "sandbox-sdk";

/** The SDK's own label, which every SDK sandbox reports. */
export const sdkLabel = "sandbox-sdk";

/** Identifier prefixes: a keyed sandbox's identifier comes from its key, any other's from its create call. */
export const keyedPrefix = "sbx-k-";
export const unkeyedPrefix = "sbx-a-";

/**
 * The identifier of a keyed sandbox. Buddy identifiers are unique across the workspace, so this is what
 * makes one sandbox per key: a second create with the same key is refused. With a project, the project is
 * part of the hash, so the same key in two projects names two sandboxes.
 */
export function keyedIdentifier(key: string, project: string | undefined): string {
  const digest = createHash("sha256")
    .update(`${project ?? ""}\0${key}`)
    .digest("hex");

  return `${keyedPrefix}${digest.slice(0, 24)}`;
}

/** The identifier of an unkeyed sandbox: from the create call's allocation ID. */
export function unkeyedIdentifier(alloc: string): string {
  return `${unkeyedPrefix}${alloc.replace(/-/g, "").slice(0, 24)}`;
}

/** Whether an identifier is one this adapter makes. */
export const isSdkIdentifier = (identifier: string) =>
  identifier.startsWith(keyedPrefix) || identifier.startsWith(unkeyedPrefix);

/**
 * What the SDK keeps in a sandbox's `note`, written at creation with the sandbox itself (also on a
 * restore from a snapshot), so it is never missing from a sandbox another client can find.
 */
export interface OwnerNote {
  /** The `create()` call that made the sandbox. A lost create answer is trusted only when it matches. */
  alloc: string;
  key?: string;
  labels: Labels;
  /** Names of the secrets among the sandbox's variables. */
  secrets: string[];
}

export function noteText(note: OwnerNote): string {
  const body: JsonObject = {
    v: 1,
    [sdkLabel]: "1",
    "sandbox-sdk-alloc": note.alloc,
    labels: note.labels,
    secrets: note.secrets,
  };

  if (note.key !== undefined) body["sandbox-sdk-key"] = note.key;

  return JSON.stringify(body);
}

function labelsOf(raw: JsonValue | undefined): Labels | undefined {
  if (!isJsonObject(raw)) return undefined;
  const labels: Labels = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!isString(value)) return undefined;
    labels[key] = value;
  }

  return labels;
}

/** A note this adapter wrote, or undefined for any other note (or none). */
export function parseNote(raw: JsonValue | undefined): OwnerNote | undefined {
  if (!isString(raw) || !raw.startsWith("{")) return undefined;
  let value: JsonValue;

  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isJsonObject(value) || value.v !== 1 || value[sdkLabel] !== "1") return undefined;
  const alloc = value["sandbox-sdk-alloc"];
  const key = value["sandbox-sdk-key"];
  const labels = labelsOf(value.labels);
  const secrets = value.secrets;

  if (!isString(alloc) || !alloc || labels === undefined) return undefined;

  if (key !== undefined && !isString(key)) return undefined;
  const names = Array.isArray(secrets) ? secrets.filter(isString) : [];

  return key === undefined
    ? { alloc, labels, secrets: names }
    : { alloc, key, labels, secrets: names };
}

export type BuddyStatus = "STARTING" | "STOPPING" | "FAILED" | "RUNNING" | "STOPPED" | "RESTORING";

export type SetupStatus = "INPROGRESS" | "SUCCESS" | "FAILED" | "STALE";

const statuses: ReadonlySet<string> = new Set<BuddyStatus>([
  "STARTING",
  "STOPPING",
  "FAILED",
  "RUNNING",
  "STOPPED",
  "RESTORING",
]);

const setupStatuses: ReadonlySet<string> = new Set<SetupStatus>([
  "INPROGRESS",
  "SUCCESS",
  "FAILED",
  "STALE",
]);

const isStatus = (value: JsonValue | undefined): value is BuddyStatus =>
  isString(value) && statuses.has(value);

const isSetupStatus = (value: JsonValue | undefined): value is SetupStatus =>
  isString(value) && setupStatuses.has(value);

const field = (raw: JsonValue | undefined, key: string): JsonValue | undefined =>
  isJsonObject(raw) ? raw[key] : undefined;

/** One entry of `GET /sandboxes`, which carries no note: whose a sandbox is needs a read of it. */
export interface SandboxSummary {
  id: string;
  identifier: string;
  status: BuddyStatus | undefined;
}

/** `GET /sandboxes/{id}` and a create's answer. */
export interface BuddySandbox extends SandboxSummary {
  setupStatus: SetupStatus | undefined;
  note: OwnerNote | undefined;
  tags: string[];
  createdAt: number;
  /** The tunnel endpoints exactly as Buddy returned them, for a PATCH that keeps them. */
  endpoints: JsonObject[];
}

function parseSummary(raw: JsonValue | undefined): SandboxSummary {
  const id = field(raw, "id");
  const identifier = field(raw, "identifier");
  const status = field(raw, "status");

  if (!isString(id) || !id) throw fail("unexpected sandbox object from the API");

  return {
    id,
    identifier: isString(identifier) ? identifier : "",
    status: isStatus(status) ? status : undefined,
  };
}

export function parseSandbox(raw: JsonValue | undefined): BuddySandbox {
  const summary = parseSummary(raw);
  const setup = field(raw, "setup_status");
  const tags = field(raw, "tags");
  const endpoints = field(raw, "endpoints");
  const created = field(raw, "create_date");
  const createdAt = isString(created) ? Date.parse(created) : Number.NaN;

  return {
    ...summary,
    setupStatus: isSetupStatus(setup) ? setup : undefined,
    note: parseNote(field(raw, "note")),
    tags: Array.isArray(tags) ? tags.filter(isString) : [],
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    endpoints: Array.isArray(endpoints) ? endpoints.filter(isJsonObject) : [],
  };
}

/** `GET /sandboxes`: `{ sandboxes: [...] }`. */
export function parseSummaries(raw: JsonValue | undefined): SandboxSummary[] {
  const list = field(raw, "sandboxes");

  if (list === undefined) return [];

  if (!Array.isArray(list)) throw fail("unexpected sandbox list from the API");

  return list.map(parseSummary);
}

/** The SDK's view of a sandbox: labels and key from the note, and the SDK's label on every SDK sandbox. */
export function toInfo(sandbox: BuddySandbox): SandboxInfo {
  const state: SandboxInfo["state"] =
    sandbox.status === "STOPPED" || sandbox.status === "STOPPING"
      ? "paused"
      : sandbox.status === "FAILED" || sandbox.status === undefined
        ? "stopped"
        : "running";

  const note = sandbox.note;
  const labels: Labels = note ? { ...note.labels, [sdkLabel]: "1" } : {};
  const createdAt = sandbox.createdAt;

  return note?.key === undefined
    ? { id: sandbox.id, labels, state, createdAt }
    : { id: sandbox.id, key: note.key, labels, state, createdAt };
}

/** `ExecView.status`. Anything but `INPROGRESS` is final, statuses added later included. */
export type ExecStatus = "INPROGRESS" | "SUCCESSFUL" | "FAILED" | "CANCELLED" | "OTHER";

/** `ExecView`: `POST /execs`, `GET /execs/{id}` and the entries of `GET /execs`. */
export interface BuddyExec {
  id: string;
  status: ExecStatus;
  /** Buddy's platform reason for a `FAILED` execution (`TIMEOUT` at its 90-minute cap); absent for a user exit. */
  failureReason: string | undefined;
  truncated: boolean;
  /** The command text, as recorded. */
  command: string;
}

function execStatusOf(value: JsonValue | undefined): ExecStatus {
  switch (value) {
    case "INPROGRESS":
    case "SUCCESSFUL":
    case "FAILED":
    case "CANCELLED":
      return value;
    default:
      return "OTHER";
  }
}

export function parseExec(raw: JsonValue | undefined): BuddyExec {
  const id = field(raw, "execution_id");

  if (!isString(id) || !id) throw fail("unexpected execution object from the API");
  const reason = field(raw, "failure_reason");
  const truncated = field(raw, "truncated");
  const command = field(raw, "command");

  return {
    id,
    status: execStatusOf(field(raw, "status")),
    failureReason: isString(reason) && reason ? reason : undefined,
    truncated: isBoolean(truncated) ? truncated : false,
    command: isString(command) ? command : "",
  };
}

/** `GET /execs`: a bare array. */
export function parseExecs(raw: JsonValue | undefined): BuddyExec[] {
  if (!Array.isArray(raw)) throw fail("unexpected execution list from the API");

  return raw.map(parseExec);
}

/** `GET /execs/{id}/log`. */
export interface LogSlice {
  lines: string[];
  nextOffset: number;
  truncated: boolean;
}

export function parseLog(raw: JsonValue | undefined, offset: number): LogSlice {
  const lines = field(raw, "lines");
  const next = field(raw, "next_offset");
  const truncated = field(raw, "truncated");

  if (lines !== undefined && !Array.isArray(lines))
    throw fail("unexpected execution log from the API");
  const text = (lines ?? []).map((line) => (isString(line) ? line : ""));

  return {
    lines: text,
    nextOffset:
      isNumber(next) && Number.isSafeInteger(next) && next >= offset ? next : offset + text.length,
    truncated: isBoolean(truncated) ? truncated : false,
  };
}

/** `POST /exec`, Buddy's synchronous command: never recorded in `GET /execs`. */
export interface SyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function parseSyncResult(raw: JsonValue | undefined): SyncResult {
  const code = field(raw, "exit_code");
  const stdout = field(raw, "stdout");
  const stderr = field(raw, "stderr");

  if (!isNumber(code) || !Number.isSafeInteger(code))
    throw fail("unexpected command result from the API");

  return {
    exitCode: code,
    stdout: isString(stdout) ? stdout : "",
    stderr: isString(stderr) ? stderr : "",
  };
}

export type SnapshotStatus = "CREATING" | "CREATED" | "DELETING" | "FAILED" | "OTHER";

/** `SnapshotView`. */
export interface BuddySnapshot {
  id: string;
  name: string;
  status: SnapshotStatus;
  /** The API URL, which names the source sandbox while it exists. */
  url: string;
}

const snapshotStatusOf = (value: JsonValue | undefined): SnapshotStatus =>
  value === "CREATING" || value === "CREATED" || value === "DELETING" || value === "FAILED"
    ? value
    : "OTHER";

export function parseSnapshot(raw: JsonValue | undefined): BuddySnapshot {
  const id = field(raw, "id");
  const name = field(raw, "name");
  const url = field(raw, "url");

  if (!isString(id) || !id) throw fail("unexpected snapshot object from the API");

  return {
    id,
    name: isString(name) ? name : "",
    status: snapshotStatusOf(field(raw, "status")),
    url: isString(url) ? url : "",
  };
}

/** `GET /sandboxes/{id}/snapshots` and `GET /sandboxes/snapshots`: `{ snapshots: [...] }`. */
export function parseSnapshots(raw: JsonValue | undefined): BuddySnapshot[] {
  const list = field(raw, "snapshots");

  if (list === undefined) return [];

  if (!Array.isArray(list)) throw fail("unexpected snapshot list from the API");

  return list.map(parseSnapshot);
}

/** One endpoint's auth mode, from `http.auth_type`. */
export function authOf(endpoint: JsonObject): string | undefined {
  const auth = field(endpoint.http, "auth_type");

  return isString(auth) ? auth : undefined;
}

/** An endpoint's public URL, with a scheme. */
export function urlOf(endpoint: JsonObject): string | undefined {
  const url = endpoint.endpoint_url;

  if (!isString(url) || !url) return undefined;

  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

/** Fields Buddy returns only for reading, never sent back. */
const readOnlyFields = new Set(["url", "html_url", "endpoint_url", "active", "target_latency"]);

/** HTTP settings Buddy never returns as written (`password`, `tls_ca`): sending a read value back breaks them. */
const writeOnlyHttp = new Set(["password", "tls_ca"]);

/**
 * An existing endpoint as a PATCH must send it to keep it: read-only fields dropped and the write-only
 * BASIC password left out, which keeps the stored one (checked live on 2026-11-24; sending its
 * `!encrypted` form back broke the endpoint). `undefined` when the endpoint holds settings that cannot
 * be sent back safely: custom TLS, a custom CA, or any other encrypted value.
 */
export function preservedEndpoint(endpoint: JsonObject): JsonObject | undefined {
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(endpoint)) {
    if (readOnlyFields.has(key) || value === undefined) continue;

    if (key === "tls") {
      if (value !== null) return undefined;
      continue;
    }

    if (key === "http" && isJsonObject(value)) {
      const http: JsonObject = {};

      for (const [name, setting] of Object.entries(value)) {
        if (readOnlyFields.has(name) || setting === undefined) continue;

        if (writeOnlyHttp.has(name)) {
          // A BASIC password is kept by leaving it out. A custom CA is not known to be.
          if (name === "tls_ca" && setting !== null && setting !== "") return undefined;
          continue;
        }

        if (hasEncrypted(setting)) return undefined;
        http[name] = setting;
      }

      out.http = http;
      continue;
    }

    if (hasEncrypted(value)) return undefined;
    out[key] = value;
  }

  return out;
}

function hasEncrypted(value: JsonValue | undefined): boolean {
  if (isString(value)) return value.startsWith("!encrypted");

  if (Array.isArray(value)) return value.some(hasEncrypted);

  if (isJsonObject(value)) return Object.values(value).some(hasEncrypted);

  return false;
}
