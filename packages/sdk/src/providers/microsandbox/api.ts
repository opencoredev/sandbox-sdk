/**
 * Decoders for Microsandbox Cloud's REST answers (https://api.microsandbox.dev/docs/openapi.json, retrieved
 * 2026-11-24) and its Services routes, which the OpenAPI document omits (their wire types are
 * `CloudService`, `CloudServiceTarget` and `CloudPaginated` in `microsandbox-types`, the crate the
 * official SDKs share). Each decoder takes parsed JSON and returns only the fields the adapter uses, or
 * throws a `provider` error naming what was unreadable.
 */
import type { Labels, SandboxInfo } from "../../provider.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isBoolean, isNumber, isString } from "../../shared/narrow.js";
import { fail } from "./errors.js";

/** The label that carries the SDK's sandbox key. */
export const keyLabel = "sandbox-sdk-key";

/** The label naming the one `create()` call that made a sandbox. A sandbox is returned or deleted only when it carries this call's value. */
export const allocLabel = "sandbox-sdk-alloc";

/** The snapshot label naming the sandbox it was captured from. */
export const sourceLabel = "sandbox-sdk-source";

/** Microsandbox Cloud's compute tiers (`CloudComputeType`). */
export type MicrosandboxComputeType = "standard" | "shared";

const computeTypes: ReadonlySet<string> = new Set<MicrosandboxComputeType>(["standard", "shared"]);

export const isComputeType = (value: JsonValue | undefined): value is MicrosandboxComputeType =>
  isString(value) && computeTypes.has(value);

/** `SandboxStatus`. */
export type SandboxStatus =
  | "created"
  | "starting"
  | "running"
  | "temporarily_unavailable"
  | "recovery_decision_required"
  | "stopping"
  | "saving_state"
  | "stopped"
  | "failed";

const statuses: ReadonlySet<string> = new Set<SandboxStatus>([
  "created",
  "starting",
  "running",
  "temporarily_unavailable",
  "recovery_decision_required",
  "stopping",
  "saving_state",
  "stopped",
  "failed",
]);

const isStatus = (value: JsonValue | undefined): value is SandboxStatus =>
  isString(value) && statuses.has(value);

const field = (raw: JsonValue | undefined, key: string): JsonValue | undefined =>
  isJsonObject(raw) ? raw[key] : undefined;

function labelsOf(raw: JsonValue | undefined): Labels {
  const labels: Labels = {};

  if (isJsonObject(raw))
    for (const [key, value] of Object.entries(raw)) if (isString(value)) labels[key] = value;

  return labels;
}

const timeOf = (raw: JsonValue | undefined) => {
  const at = isString(raw) ? Date.parse(raw) : Number.NaN;

  return Number.isFinite(at) ? at : 0;
};

/**
 * The resolved spec of a sandbox (`SandboxSpecResponse`), or `null` while the cloud has not resolved it.
 * Labels live only here: `SandboxResponse` has no top-level labels.
 */
export interface SandboxSpec {
  labels: Labels;
}

/** `SandboxResponse`: `GET /v1/sandboxes/{id}`, `GET /v1/sandboxes/by-name/{name}`, list entries, create, start and stop answers. */
export interface MicrosandboxSandbox {
  id: string;
  name: string;
  status: SandboxStatus;
  /** `compute.type`; undefined when the answer has no readable one. */
  compute: MicrosandboxComputeType | undefined;
  spec: SandboxSpec | null;
  createdAt: number;
}

export function parseSandbox(raw: JsonValue | undefined): MicrosandboxSandbox {
  const id = field(raw, "id");
  const name = field(raw, "name");
  const status = field(raw, "status");

  if (!isString(id) || !id || !isString(name) || !isStatus(status))
    throw fail("unexpected sandbox object from the API");
  const compute = field(field(raw, "compute"), "type");
  const rawSpec = field(raw, "spec");

  return {
    id,
    name,
    status,
    compute: isComputeType(compute) ? compute : undefined,
    spec: isJsonObject(rawSpec) ? { labels: labelsOf(rawSpec.labels) } : null,
    createdAt: timeOf(field(raw, "created_at")),
  };
}

/** A sandbox answer read as far as it goes: `unreadable` names no sandbox, so it says nothing about whether one exists. */
export type SandboxAnswer =
  | { kind: "sandbox"; sandbox: MicrosandboxSandbox }
  | { kind: "unreadable" };

export function parseSandboxAnswer(raw: JsonValue | undefined): SandboxAnswer {
  try {
    return { kind: "sandbox", sandbox: parseSandbox(raw) };
  } catch {
    return { kind: "unreadable" };
  }
}

/** One page of a `PaginatedResponse`: `{ data, has_more, next_cursor }`. */
export interface Page<T> {
  data: T[];
  nextCursor: string | undefined;
}

function parsePage<T>(
  raw: JsonValue | undefined,
  what: string,
  parse: (entry: JsonValue) => T,
): Page<T> {
  const data = field(raw, "data");

  if (!Array.isArray(data)) throw fail(`unexpected ${what} list from the API`);
  const cursor = field(raw, "next_cursor");
  const more = field(raw, "has_more");

  // A page that says it has no more ends the listing, whatever cursor it carries.
  return {
    data: data.map(parse),
    nextCursor: isString(cursor) && cursor && (!isBoolean(more) || more) ? cursor : undefined,
  };
}

export const parseSandboxPage = (raw: JsonValue | undefined) =>
  parsePage(raw, "sandbox", parseSandbox);

/** `CloudServiceStatus`. Unknown values read as `unknown`, as the official SDK does. */
export type ServiceStatus = "enabled" | "disabled" | "detached" | "unknown";

/** `CloudService`: `POST /v1/services`, `GET /v1/services/{slug}` and list entries. */
export interface MicrosandboxService {
  slug: string;
  url: string;
  status: ServiceStatus;
  /** The sandbox (by name) and port that receive requests, or null when detached. */
  target: { sandbox: string; port: number } | null;
  /** Server creation timestamp (`created_at`), used to distinguish a reused slug after deletion. */
  createdAt: string | undefined;
}

export function parseService(raw: JsonValue | undefined): MicrosandboxService {
  const slug = field(raw, "slug");
  const url = field(raw, "url");
  const status = field(raw, "status");
  const target = field(raw, "target");
  const createdAt = field(raw, "created_at");

  if (!isString(slug) || !slug || !isString(url))
    throw fail("unexpected Service object from the API");
  const sandbox = field(target, "sandbox");
  const port = field(target, "port");

  return {
    slug,
    url,
    status:
      status === "enabled" || status === "disabled" || status === "detached" ? status : "unknown",
    target:
      isString(sandbox) && isNumber(port) && Number.isInteger(port) ? { sandbox, port } : null,
    createdAt: isString(createdAt) && createdAt ? createdAt : undefined,
  };
}

export const parseServicePage = (raw: JsonValue | undefined) =>
  parsePage(raw, "Service", parseService);

/** A Service URL: absolute https (http only for the loopback fakes), no credentials. */
export function serviceUrl(service: MicrosandboxService): string {
  try {
    const url = new URL(service.url);

    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password)
      return service.url;
  } catch {
    // Falls through.
  }

  throw fail("unexpected Service URL from the API");
}

/** `CloudSnapshotLocation`. */
export type SnapshotLocation =
  | { type: "managed"; id: string }
  | { type: "host_volume" }
  | { type: "unknown" };

/** `CloudSnapshot` (`CloudSnapshotDetails` plus `kind`): `GET /v1/snapshots/{id}`, `by-name`, and an operation's `result`. */
export interface MicrosandboxSnapshot {
  name: string;
  location: SnapshotLocation;
  sandboxId: string | undefined;
  labels: Labels;
}

function locationOf(raw: JsonValue | undefined): SnapshotLocation {
  const type = field(raw, "type");
  const id = field(raw, "id");

  if (type === "managed" && isString(id) && id) return { type: "managed", id };

  if (type === "host_volume") return { type: "host_volume" };

  return { type: "unknown" };
}

export function parseSnapshot(raw: JsonValue | undefined): MicrosandboxSnapshot {
  const name = field(raw, "name");

  if (!isString(name) || !name) throw fail("unexpected snapshot object from the API");
  const sandboxId = field(raw, "sandbox_id");

  return {
    name,
    location: locationOf(field(raw, "location")),
    sandboxId: isString(sandboxId) && sandboxId ? sandboxId : undefined,
    labels: labelsOf(field(raw, "labels")),
  };
}

/** Whether a snapshot was captured from `sandboxId`: its own `sandbox_id`, or the adapter's source label. */
export const capturedFrom = (snapshot: MicrosandboxSnapshot, sandboxId: string) =>
  snapshot.sandboxId === sandboxId || snapshot.labels[sourceLabel] === sandboxId;

/** `CloudSnapshotOperationStatus`. */
export type OperationStatus = "queued" | "in_progress" | "succeeded" | "failed";

/** `CloudSnapshotOperation`, plus the list item's `snapshot_name` and `sandbox_id` when present. */
export interface SnapshotOperation {
  id: string;
  status: OperationStatus;
  /** Present once the operation succeeded, when readable. */
  result: MicrosandboxSnapshot | undefined;
  snapshotName: string | undefined;
  sandboxId: string | undefined;
}

const operationStatuses: ReadonlySet<string> = new Set<OperationStatus>([
  "queued",
  "in_progress",
  "succeeded",
  "failed",
]);

const isOperationStatus = (value: JsonValue | undefined): value is OperationStatus =>
  isString(value) && operationStatuses.has(value);

export function parseOperation(raw: JsonValue | undefined): SnapshotOperation {
  const id = field(raw, "id");
  const status = field(raw, "status");

  if (!isString(id) || !id || !isOperationStatus(status))
    throw fail("unexpected snapshot operation from the API");
  const result = field(raw, "result");
  const snapshotName = field(raw, "snapshot_name");
  const sandboxId = field(raw, "sandbox_id");
  let parsed: MicrosandboxSnapshot | undefined;

  try {
    parsed = isJsonObject(result) ? parseSnapshot(result) : undefined;
  } catch {
    parsed = undefined;
  }

  return {
    id,
    status,
    result: parsed,
    snapshotName: isString(snapshotName) && snapshotName ? snapshotName : undefined,
    sandboxId: isString(sandboxId) && sandboxId ? sandboxId : undefined,
  };
}

export const parseOperationPage = (raw: JsonValue | undefined) =>
  parsePage(raw, "snapshot operation", parseOperation);

/** Microsandbox credential shapes: organization API keys (`msb_...`) and personal access tokens (`msb_pat_...`). */
export const tokenPattern = /msb_(?:pat_)?[A-Za-z0-9_-]+/g;

/** Credential shapes the HTTP client and peer error mapping redact from every error, registered or not. */
export const leakPatterns: readonly RegExp[] = [tokenPattern];

/** The Microsandbox tokens in one string. */
export function tokensIn(text: string): string[] {
  return text.match(tokenPattern) ?? [];
}

/** Every Microsandbox token anywhere in an answer read through `box.native` or `provider.api`. */
export function nestedTokens(raw: JsonValue | undefined): string[] {
  const found: string[] = [];
  const pending: (JsonValue | undefined)[] = [raw];

  for (let seen = 0; pending.length > 0 && seen < 1_000_000; seen++) {
    const value = pending.pop();

    if (isString(value)) found.push(...tokensIn(value));
    else if (Array.isArray(value)) pending.push(...value);
    else if (isJsonObject(value)) pending.push(...Object.values(value));
  }

  return found;
}

/** Statuses `list()` and `find()` report as running: the sandbox is up or coming up. */
const runningStatuses: ReadonlySet<SandboxStatus> = new Set<SandboxStatus>([
  "starting",
  "running",
  "temporarily_unavailable",
]);

/** The SDK's view of a sandbox: the key and allocation marker move out of the labels. */
export function toInfo(sandbox: MicrosandboxSandbox): SandboxInfo {
  const { [keyLabel]: key, [allocLabel]: _alloc, ...labels } = sandbox.spec?.labels ?? {};
  const state: SandboxInfo["state"] = runningStatuses.has(sandbox.status) ? "running" : "stopped";

  return key === undefined
    ? { id: sandbox.id, labels, state, createdAt: sandbox.createdAt }
    : { id: sandbox.id, key, labels, state, createdAt: sandbox.createdAt };
}
