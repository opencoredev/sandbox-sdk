/**
 * Parsers for Agent 37's Sandbox API answers (https://www.agent37.com/docs/agents-api/instances/object),
 * each checked against live answers on 2026-11-28. Every parser takes parsed JSON and returns only the
 * fields the adapter uses.
 */
import type { Labels, SandboxInfo } from "../../provider.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isBoolean, isNumber, isString } from "../../shared/narrow.js";
import { fail } from "./errors.js";

/** The metadata entry that carries the SDK's sandbox key. */
export const keyLabel = "sandbox_sdk_key";

/**
 * The metadata entry that names the one `create()` call that made an instance. A lost create answer is
 * trusted, returned or deleted only when it carries this call's value.
 */
export const allocLabel = "sandbox_sdk_alloc";

/**
 * The metadata entry that marks a stopped fork the adapter keeps as a snapshot: its value is the ID of
 * the sandbox it was taken from. Such instances are never listed or found as sandboxes.
 */
export const snapshotLabel = "sandbox_sdk_snapshot";

/** Agent 37's instance statuses (https://www.agent37.com/docs/agents-api/instances/object#statuses). */
export type Agent37Status =
  | "provisioning"
  | "running"
  | "stopping"
  | "stopped"
  | "starting"
  | "restarting"
  | "updating"
  | "sleeping"
  | "waking"
  | "failed"
  | "deleting"
  | "deleted";

const statuses: ReadonlySet<string> = new Set<Agent37Status>([
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "starting",
  "restarting",
  "updating",
  "sleeping",
  "waking",
  "failed",
  "deleting",
  "deleted",
]);

const isStatus = (value: JsonValue | undefined): value is Agent37Status =>
  isString(value) && statuses.has(value);

/** Statuses of an instance that is gone or going: never listed, found or returned. */
export const ending: ReadonlySet<Agent37Status> = new Set(["deleting", "deleted"]);

/** Statuses on the way to `running`, which waits poll through. */
export const coming: ReadonlySet<Agent37Status> = new Set([
  "provisioning",
  "starting",
  "restarting",
  "updating",
  "waking",
]);

const field = (raw: JsonValue | undefined, key: string): JsonValue | undefined =>
  isJsonObject(raw) ? raw[key] : undefined;

function labelsOf(raw: JsonValue | undefined): Labels {
  const labels: Labels = {};

  if (isJsonObject(raw))
    for (const [key, value] of Object.entries(raw)) if (isString(value)) labels[key] = value;

  return labels;
}

/** An instance object, from create, get, list, fork and edit. */
export interface Agent37Instance {
  id: string;
  status: Agent37Status;
  metadata: Labels;
  createdAt: number;
}

export function parseInstance(raw: JsonValue | undefined): Agent37Instance {
  const id = field(raw, "id");
  const status = field(raw, "status");

  if (!isString(id) || !id || !isStatus(status))
    throw fail("unexpected instance object from the API");
  const created = field(raw, "created");

  return {
    id,
    status,
    metadata: labelsOf(field(raw, "metadata")),
    // Epoch seconds on the Sandbox API.
    createdAt: isNumber(created) && Number.isFinite(created) && created > 0 ? created * 1000 : 0,
  };
}

/** A create or fork answer, read as far as it goes: `unreadable` names no instance. */
export type InstanceAnswer =
  | { kind: "instance"; instance: Agent37Instance }
  | { kind: "unreadable" };

export function parseInstanceAnswer(raw: JsonValue | undefined): InstanceAnswer {
  try {
    return { kind: "instance", instance: parseInstance(raw) };
  } catch {
    return { kind: "unreadable" };
  }
}

/** `GET /v1/instances`: `{ data: [...] }`, newest first. */
export function parseInstanceList(raw: JsonValue | undefined): Agent37Instance[] {
  const data = field(raw, "data");

  if (!Array.isArray(data)) throw fail("unexpected instance list from the API");

  return data.map(parseInstance);
}

/** One `POST /v1/instances/{id}/exec` answer in the foreground. */
export interface ExecAnswer {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function parseExec(raw: JsonValue | undefined): ExecAnswer {
  const exitCode = field(raw, "exit_code");
  const stdout = field(raw, "stdout");
  const stderr = field(raw, "stderr");
  const truncated = field(raw, "truncated");

  if (
    !isNumber(exitCode) ||
    !Number.isSafeInteger(exitCode) ||
    !isString(stdout) ||
    !isString(stderr) ||
    (truncated !== undefined && !isBoolean(truncated))
  )
    throw fail("unexpected exec answer from the API");

  return { exitCode, stdout, stderr, truncated: truncated === true };
}

/** A URL Agent 37 handed back: absolute https, no credentials in the userinfo. */
function urlOf(raw: JsonValue | undefined): string {
  if (isString(raw))
    try {
      const parsed = new URL(raw);

      if (parsed.protocol === "https:" || parsed.protocol === "http:")
        if (!parsed.username && !parsed.password) return raw;
    } catch {
      // Falls through to the failure below.
    }

  throw fail("unexpected URL in the API answer");
}

/** `POST /v1/instances/{id}/signed-url`: the URL, which carries its `a37_token`, and its expiry. */
export function parseSignedUrl(raw: JsonValue | undefined): { url: string; expiresAt?: number } {
  const url = urlOf(field(raw, "url"));
  const expires = field(raw, "expires_at");

  return isNumber(expires) && Number.isFinite(expires) && expires > 0
    ? { url, expiresAt: expires * 1000 }
    : { url };
}

/** A public port entry's fields the adapter reads. */
export interface PublicPort {
  port: number;
  url: string;
}

/** A public port entry: `{ port, url, ... }`. */
export function parsePublicPort(raw: JsonValue | undefined): PublicPort {
  const port = field(raw, "port");

  if (!isNumber(port) || !Number.isSafeInteger(port))
    throw fail("unexpected public port from the API");

  return { port, url: urlOf(field(raw, "url")) };
}

/** `GET /v1/instances/{id}/public-ports`: `{ data: [...] }`, or a bare array. */
export function parsePublicPorts(raw: JsonValue | undefined): PublicPort[] {
  const data = Array.isArray(raw) ? raw : field(raw, "data");

  if (!Array.isArray(data)) throw fail("unexpected public port list from the API");

  return data.map(parsePublicPort);
}

/** Agent 37's workspace keys (`sk_live_...`). */
const keyPattern = /sk_live_[A-Za-z0-9_-]{8,}/g;

/**
 * Credential shapes the HTTP client redacts from every error, registered or not: workspace keys, and any
 * `a37_token=` query value, such as a signed preview URL's.
 */
export const leakPatterns: readonly RegExp[] = [keyPattern, /[?&;]a37_token=[^&#\s"'<>]+/gi];

/** The `a37_token` values in a signed URL, so the adapter can redact them. */
export function tokensIn(url: string): string[] {
  try {
    return new URL(url).searchParams.getAll("a37_token").filter(Boolean);
  } catch {
    return [];
  }
}

/** The SDK's view of an instance: the key and allocation marker move out of the labels. */
export function toInfo(instance: Agent37Instance): SandboxInfo {
  const {
    [keyLabel]: key,
    [allocLabel]: _alloc,
    [snapshotLabel]: _snapshot,
    ...labels
  } = instance.metadata;

  const state: SandboxInfo["state"] =
    instance.status === "running" || coming.has(instance.status)
      ? "running"
      : instance.status === "sleeping"
        ? "paused"
        : "stopped";

  return key === undefined
    ? { id: instance.id, labels, state, createdAt: instance.createdAt }
    : { id: instance.id, key, labels, state, createdAt: instance.createdAt };
}
