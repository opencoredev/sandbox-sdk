/**
 * Parsers for Maritime's Virtual machines API answers (https://maritime.sh/docs/ephemeral-sandboxes,
 * maritime-sdk 0.13.0's decoders), each checked against live answers on 2026-11-23. Every parser takes
 * parsed JSON and returns only the fields the adapter uses. A sandbox's data-plane `secret` (`mst_...`)
 * and URL token (`mut_...`) never leave the connection record, except to {@link credentials}, which the
 * adapter registers for redaction.
 */
import type { Labels, SandboxInfo } from "../../provider.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { fail } from "./errors.js";

/** The metadata entry that carries the SDK's sandbox key. */
export const keyLabel = "sandbox-sdk-key";

/**
 * The metadata entry that names the one `create()` call that made a sandbox. A lost or replayed create
 * answer is trusted, returned or destroyed only when it carries this call's value.
 */
export const allocLabel = "sandbox-sdk-alloc";

/** Maritime's sandbox states (maritime-sdk SANDBOX_STATES). */
export type MaritimeState =
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "error"
  | "ended";

/** Every state but `ended`: what `list()` asks for. Ended sandboxes stay listed for 7 days. */
export const liveStates: readonly MaritimeState[] = [
  "starting",
  "running",
  "pausing",
  "paused",
  "resuming",
  "error",
];

const states: ReadonlySet<string> = new Set<MaritimeState>([...liveStates, "ended"]);

const isState = (value: JsonValue | undefined): value is MaritimeState =>
  isString(value) && states.has(value);

const field = (raw: JsonValue | undefined, key: string): JsonValue | undefined =>
  isJsonObject(raw) ? raw[key] : undefined;

function labelsOf(raw: JsonValue | undefined): Labels {
  const labels: Labels = {};

  if (isJsonObject(raw))
    for (const [key, value] of Object.entries(raw)) if (isString(value)) labels[key] = value;

  return labels;
}

/** `GET /v1/sandboxes/{id}`, an entry of `GET /v1/sandboxes`, and the answer of a create or pause. */
export interface MaritimeSandbox {
  id: string;
  state: MaritimeState;
  metadata: Labels;
  createdAt: number;
}

/** What reaching a sandbox's data plane and ports needs, from any sandbox answer. */
export interface Connection {
  dataPlaneUrl: string;
  secret: string;
  urlToken: string | undefined;
}

export function parseSandbox(raw: JsonValue | undefined): MaritimeSandbox {
  const id = field(raw, "id");
  const state = field(raw, "state");

  if (!isString(id) || !id || !isState(state)) throw fail("unexpected sandbox object from the API");
  const created = field(raw, "createdAt");
  const createdAt = isString(created) ? Date.parse(created) : Number.NaN;

  return {
    id,
    state,
    metadata: labelsOf(field(raw, "metadata")),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  };
}

/** A data-plane base URL: absolute http(s), no credentials, query or fragment. */
function dataPlaneOf(raw: JsonValue | undefined): string | undefined {
  if (!isString(raw)) return undefined;
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;

  if (url.search || url.hash) return undefined;

  return raw.replace(/\/+$/, "");
}

/** The connection a sandbox answer carries, or undefined when it has no data-plane URL or secret. */
export function connectionOf(raw: JsonValue | undefined): Connection | undefined {
  const dataPlaneUrl = dataPlaneOf(field(raw, "dataPlaneUrl"));
  const secret = field(raw, "secret");
  const urlToken = field(raw, "urlToken");

  if (dataPlaneUrl === undefined || !isString(secret) || !secret) return undefined;

  return { dataPlaneUrl, secret, urlToken: isString(urlToken) && urlToken ? urlToken : undefined };
}

/**
 * A create's answer, read as far as it goes. `incomplete` names a sandbox that exists without what reaching
 * it needs; `unreadable` names none, so it says nothing about whether one was made.
 */
export type SandboxAnswer =
  | { kind: "sandbox"; sandbox: MaritimeSandbox; connection: Connection }
  | { kind: "incomplete"; sandbox: MaritimeSandbox }
  | { kind: "unreadable" };

export function parseSandboxAnswer(raw: JsonValue | undefined): SandboxAnswer {
  let sandbox: MaritimeSandbox;

  try {
    sandbox = parseSandbox(raw);
  } catch {
    return { kind: "unreadable" };
  }

  const connection = connectionOf(raw);

  return connection ? { kind: "sandbox", sandbox, connection } : { kind: "incomplete", sandbox };
}

/** One page of `GET /v1/sandboxes`: each sandbox with its raw entry, whose credentials the adapter keeps. */
export interface SandboxPage {
  data: { sandbox: MaritimeSandbox; raw: JsonValue | undefined }[];
  nextCursor: string | undefined;
}

export function parseSandboxPage(raw: JsonValue | undefined): SandboxPage {
  const data = field(raw, "data");

  if (!Array.isArray(data)) throw fail("unexpected sandbox list from the API");
  const cursor = field(raw, "nextCursor");

  return {
    data: data.map((entry) => ({ sandbox: parseSandbox(entry), raw: entry })),
    nextCursor: isString(cursor) && cursor ? cursor : undefined,
  };
}

const credentialKeys: ReadonlySet<string> = new Set(["secret", "urlToken", "apiKey"]);

/** The credentials a sandbox answer carries (`secret`, `urlToken`), so the adapter can redact them. */
export function credentials(raw: JsonValue | undefined): string[] {
  return ["secret", "urlToken"].flatMap((key) => {
    const value = field(raw, key);

    return isString(value) && value ? [value] : [];
  });
}

/** Maritime's credential prefixes: sandbox secrets, URL tokens, account and server keys. */
const tokenPattern = /\b(?:mst|mut|mk|mlk)_[A-Za-z0-9_-]{8,}/g;

/**
 * Credential shapes the HTTP client redacts from every error, registered or not: Maritime's tokens, and
 * any `token=` query value, such as a preview URL's.
 */
export const leakPatterns: readonly RegExp[] = [tokenPattern, /[?&;]token=[^&#\s"'<>]+/gi];

/**
 * The credentials anywhere in an answer the caller asked for through `box.native` or `provider.api`, whose
 * shape the adapter does not know: `secret`, `urlToken` and `apiKey` fields at any depth, and any string
 * holding a Maritime token, such as a preview URL with `?token=mut_...`.
 */
export function nestedCredentials(raw: JsonValue | undefined): string[] {
  const found: string[] = [];
  const pending: (JsonValue | undefined)[] = [raw];

  for (let seen = 0; pending.length > 0 && seen < 1_000_000; seen++) {
    const value = pending.pop();

    if (isString(value)) for (const match of value.match(tokenPattern) ?? []) found.push(match);
    else if (Array.isArray(value)) for (const entry of value) pending.push(entry);
    else if (isJsonObject(value))
      for (const [key, entry] of Object.entries(value))
        if (credentialKeys.has(key) && isString(entry) && entry) found.push(entry);
        else pending.push(entry);
  }

  return found;
}

/** The Maritime tokens in one string, such as the `?token=mut_...` of a preview URL. */
export function tokensIn(text: string): string[] {
  return text.match(tokenPattern) ?? [];
}

/** How a command ended, from its Command object. */
export type CommandOutcome =
  | { kind: "exited"; exitCode: number }
  | { kind: "killed"; signal: number }
  | { kind: "running" }
  | { kind: "unreadable" };

const signals = new Map([
  ["SIGHUP", 1],
  ["SIGINT", 2],
  ["SIGQUIT", 3],
  ["SIGABRT", 6],
  ["SIGKILL", 9],
  ["SIGSEGV", 11],
  ["SIGPIPE", 13],
  ["SIGTERM", 15],
]);

/**
 * A Command object (`result` event, JSON answer of `POST /commands`, `command` of an error). Each state
 * has one shape, and anything else is unreadable: `exited` has a whole `exitCode` of 0 or more and a null
 * `signal`; `killed` has a known `signal` and a null `exitCode`. So `{ state: "exited", exitCode: 0,
 * signal: "SIGKILL" }` is never a clean exit.
 */
export function parseCommand(raw: JsonValue | undefined): CommandOutcome {
  const state = field(raw, "state");
  const exitCode = field(raw, "exitCode");
  const signal = field(raw, "signal");

  switch (state) {
    case "running":
      return { kind: "running" };
    case "exited":
      return isNumber(exitCode) &&
        Number.isSafeInteger(exitCode) &&
        exitCode >= 0 &&
        signal === null
        ? { kind: "exited", exitCode }
        : { kind: "unreadable" };
    case "killed": {
      const number = isString(signal) ? signals.get(signal) : undefined;

      return number !== undefined && (exitCode === null || exitCode === undefined)
        ? { kind: "killed", signal: number }
        : { kind: "unreadable" };
    }

    default:
      return { kind: "unreadable" };
  }
}

/** Whether a Command object says the command ran to a normal exit 0, with no signal. */
export function exitedCleanly(raw: JsonValue | undefined): boolean {
  const outcome = parseCommand(raw);

  return outcome.kind === "exited" && outcome.exitCode === 0;
}

/** `POST /v1/sandboxes/{id}/save` and `GET /v1/snapshots/{name}`. */
export interface MaritimeSnapshot {
  name: string;
  sourceSandboxId: string | undefined;
}

export function parseSnapshot(raw: JsonValue | undefined): MaritimeSnapshot {
  const name = field(raw, "name");
  const source = field(raw, "sourceSandboxId");

  if (!isString(name) || !name) throw fail("unexpected snapshot object from the API");

  return { name, sourceSandboxId: isString(source) && source ? source : undefined };
}

/** `POST /v1/sandboxes/{id}/urls`: `{ url }`, an absolute https URL. */
export function parseUrl(raw: JsonValue | undefined): string {
  const url = field(raw, "url");

  if (isString(url))
    try {
      const parsed = new URL(url);

      if (parsed.protocol === "https:" || parsed.protocol === "http:") return url;
    } catch {
      // Falls through to the failure below.
    }

  throw fail("unexpected preview URL answer from the API");
}

/** `GET /v1/sandboxes/{id}/usage` fields, and the shared usage names they become. */
const usageNames = [
  ["cpuPercent", "cpuPercent", 1],
  ["memoryUsedMib", "memoryBytes", 1024 * 1024],
  ["memoryMib", "memoryLimitBytes", 1024 * 1024],
  ["diskUsedGib", "diskBytes", 1024 ** 3],
  ["diskGib", "diskLimitBytes", 1024 ** 3],
  ["idleSeconds", "idleSeconds", 1],
  ["runningCommands", "runningCommands", 1],
] as const;

export function parseUsage(raw: JsonValue | undefined): Record<string, number> {
  if (!isJsonObject(raw)) return {};

  return Object.fromEntries(
    usageNames.flatMap(([from, to, scale]) => {
      const value = raw[from];

      return isNumber(value) && Number.isFinite(value) ? [[to, value * scale]] : [];
    }),
  );
}

/** The SDK's view of a sandbox: the key and allocation marker move out of the labels. */
export function toInfo(sandbox: MaritimeSandbox): SandboxInfo {
  const { [keyLabel]: key, [allocLabel]: _alloc, ...labels } = sandbox.metadata;

  const state: SandboxInfo["state"] = ["running", "starting", "resuming"].includes(sandbox.state)
    ? "running"
    : sandbox.state === "paused" || sandbox.state === "pausing"
      ? "paused"
      : "stopped";

  return key === undefined
    ? { id: sandbox.id, labels, state, createdAt: sandbox.createdAt }
    : { id: sandbox.id, key, labels, state, createdAt: sandbox.createdAt };
}
