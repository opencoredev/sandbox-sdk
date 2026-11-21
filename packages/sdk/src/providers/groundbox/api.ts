/**
 * Groundbox's REST API (https://api.groundbox.dev/v1): the shared HTTP client the adapter and
 * `box.native` use, and parsers that turn its JSON answers into the shapes the adapter needs.
 * Shapes from https://groundbox.dev/openapi.json and @groundbox/sdk 0.4.2, retrieved 2026-11-20.
 */
import { createHttpClient, type HttpClient } from "../../http.js";
import type { FileInfo, Labels, SandboxInfo } from "../../provider.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { fail, mapFailure } from "./errors.js";

/** Groundbox has one API surface, under `/v1`. Paths take `{id}` for the sandbox. */
export type GroundboxPlane = "api";

/** The label that carries the SDK's sandbox key in a sandbox's metadata. */
export const keyLabel = "sandbox-sdk-key";

export interface ClientOptions {
  /** The key, read per request; throws when it is missing. */
  apiKey: () => string;
  baseUrl: string;
  requestTimeoutMs: number;
}

export function createGroundboxClient(options: ClientOptions): HttpClient<GroundboxPlane> {
  return createHttpClient<GroundboxPlane>({
    provider: "groundbox",
    label: "Groundbox",
    planes: {
      api: {
        baseUrl: options.baseUrl,
        auth: () => ({ Authorization: `Bearer ${options.apiKey()}` }),
      },
    },
    defaultPlane: "api",
    timeoutMs: options.requestTimeoutMs,
    idempotencyHeader: "Idempotency-Key",
    secrets: () => {
      try {
        return [options.apiKey()];
      } catch {
        // No key yet: nothing to redact.
        return [];
      }
    },
    authHint: "Set GROUNDBOX_API_KEY to a valid Groundbox API key (gbx_...).",
    mapError: mapFailure,
  });
}

/** A member of a JSON object, or undefined. */
export const field = (raw: JsonValue | undefined, key: string): JsonValue | undefined =>
  isJsonObject(raw) ? raw[key] : undefined;

/** The statuses a sandbox can have (`SandboxStatus` in the OpenAPI spec). */
const running = new Set(["queued", "starting", "running", "resuming"]);

const paused = new Set(["pausing", "paused"]);

/** Over for good: a sandbox in these is gone for the SDK, though Groundbox still answers for it. */
export const ended = new Set(["stopping", "stopped", "failed"]);

/** Still coming up: commands would wait, so create and resume poll until it leaves these. */
export const pending = new Set(["queued", "starting", "resuming", "pausing"]);

export interface Sandbox {
  id: string;
  status: string;
  metadata: Labels;
  createdAt: number;
  cpus: number;
  memoryGb: number;
  diskGb: number;
  /** Why a failed sandbox failed; never copied into errors. */
  failed: boolean;
}

function labelsOf(raw: JsonValue | undefined): Labels {
  const labels: Labels = {};

  if (isJsonObject(raw))
    for (const [key, value] of Object.entries(raw)) if (isString(value)) labels[key] = value;

  return labels;
}

const count = (raw: JsonValue | undefined) => (isNumber(raw) && Number.isFinite(raw) ? raw : 0);

export function parseSandbox(raw: JsonValue | undefined): Sandbox {
  const id = field(raw, "id");
  const status = field(raw, "status");
  const created = field(raw, "created_at");

  if (!isString(id) || !isString(status) || !isString(created))
    throw fail("unexpected sandbox object from the API");
  const createdAt = Date.parse(created);

  if (!Number.isFinite(createdAt))
    throw fail("sandbox has no valid creation time", "provider", { sandboxId: id });

  return {
    id,
    status,
    metadata: labelsOf(field(raw, "metadata")),
    createdAt,
    cpus: count(field(raw, "cpus")),
    memoryGb: count(field(raw, "memory_gb")),
    diskGb: count(field(raw, "disk_gb")),
    failed: status === "failed",
  };
}

export interface SandboxPage {
  sandboxes: Sandbox[];
  nextCursor: string | null;
}

export function parseSandboxPage(raw: JsonValue | undefined): SandboxPage {
  const data = field(raw, "data");

  if (!Array.isArray(data)) throw fail("unexpected sandbox list from the API");
  const cursor = field(raw, "next_cursor");

  return { sandboxes: data.map(parseSandbox), nextCursor: isString(cursor) ? cursor : null };
}

/** A sandbox as the SDK sees it: the key label moves to `key`, the status to running, paused or stopped. */
export function toInfo(sandbox: Sandbox): SandboxInfo {
  const { [keyLabel]: key, ...labels } = sandbox.metadata;

  const state: SandboxInfo["state"] = paused.has(sandbox.status)
    ? "paused"
    : running.has(sandbox.status)
      ? "running"
      : "stopped";

  return key === undefined
    ? { id: sandbox.id, labels, state, createdAt: sandbox.createdAt }
    : { id: sandbox.id, key, labels, state, createdAt: sandbox.createdAt };
}

export interface ExecAnswer {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** `POST /v1/sandboxes/{id}/exec`. */
export function parseExec(raw: JsonValue | undefined, sandboxId: string): ExecAnswer {
  const exitCode = field(raw, "exit_code");
  const stdout = field(raw, "stdout");
  const stderr = field(raw, "stderr");

  if (!isNumber(exitCode) || !isString(stdout) || !isString(stderr))
    throw fail("unexpected exec answer from the API", "provider", { sandboxId });

  return { exitCode, stdout, stderr, timedOut: field(raw, "timed_out") === true };
}

/** One running command from `GET /v1/sandboxes/{id}/commands`: its exec ID and the start of its shell line. */
export function parseCommands(raw: JsonValue | undefined): { id: string; cmd: string }[] {
  const data = field(raw, "data");

  if (!Array.isArray(data)) return [];

  return data.flatMap((entry) => {
    const id = field(entry, "id");
    const cmd = field(entry, "cmd");

    return isString(id) && isString(cmd) ? [{ id, cmd }] : [];
  });
}

/** A `FileEntry`: `dir`, `file`, `symlink` or `other`. */
export function parseEntry(raw: JsonValue | undefined, sandboxId: string): FileInfo {
  const path = field(raw, "path");
  const type = field(raw, "type");

  if (!isString(path) || !isString(type))
    throw fail("unexpected file entry from the API", "provider", { sandboxId });
  const modified = field(raw, "modified_at");
  const modifiedAt = isString(modified) ? Date.parse(modified) : Number.NaN;

  return {
    path,
    type: type === "dir" ? "directory" : type === "symlink" ? "symlink" : "file",
    size: count(field(raw, "size_bytes")),
    modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : 0,
  };
}

export function parseEntries(raw: JsonValue | undefined, sandboxId: string): FileInfo[] {
  const entries = field(raw, "entries");

  if (!Array.isArray(entries))
    throw fail("directory listing has no entries", "provider", { sandboxId });

  return entries.map((entry) => parseEntry(entry, sandboxId));
}

export interface Snapshot {
  id: string;
  /** `creating`, `ready`, `failed` or `deleted`. */
  status: string;
}

export function parseSnapshot(raw: JsonValue | undefined): Snapshot {
  const id = field(raw, "id");
  const status = field(raw, "status");

  if (!isString(id) || !isString(status)) throw fail("unexpected snapshot object from the API");

  return { id, status };
}

export interface PreviewAnswer {
  url: string;
  /** The share token of a private preview, sent as the `x-groundbox-preview-token` header. */
  token?: string;
  expiresAt?: number;
}

/** `POST /v1/sandboxes/{id}/previews`. A private preview's share URL carries its token as `gb_token`. */
export function parsePreview(raw: JsonValue | undefined, sandboxId: string): PreviewAnswer {
  const url = field(raw, "url");

  if (!isString(url)) throw fail("the preview has no URL", "provider", { sandboxId });
  const share = field(raw, "share_url");
  const expires = field(raw, "expires_at");
  const answer: PreviewAnswer = { url };

  if (isString(share)) {
    let token: string | null = null;

    try {
      token = new URL(share).searchParams.get("gb_token");
    } catch {
      token = null;
    }

    if (!token) throw fail("the private preview has no share token", "provider", { sandboxId });
    answer.token = token;
  }

  if (isString(expires) && Number.isFinite(Date.parse(expires)))
    answer.expiresAt = Date.parse(expires);

  return answer;
}

export interface TemplateAnswer {
  id: string;
  name: string;
  /** The version the newest build makes, when there is one. */
  build?: Build;
}

export function parseTemplate(raw: JsonValue | undefined): TemplateAnswer {
  const id = field(raw, "id");
  const name = field(raw, "name");

  if (!isString(id) || !isString(name)) throw fail("unexpected template object from the API");
  const latest = field(raw, "latest_build");
  const version = field(latest, "version");
  const status = field(latest, "status");

  return isNumber(version) && isString(status)
    ? { id, name, build: { version, status } }
    : { id, name };
}

/** One version of a template and how far its build is. */
export interface Build {
  version: number;
  /** `queued`, `building`, `ready`, `failed` or `canceled`. */
  status: string;
}

/** `POST /v1/templates/{id}/builds`: the new version. */
export function parseBuild(raw: JsonValue | undefined): Build {
  const version = field(raw, "version");
  const status = field(raw, "status");

  if (!isNumber(version) || !isString(status)) throw fail("unexpected template build from the API");

  return { version, status };
}

export interface LogPage {
  lines: string[];
  next: number;
  status: string;
  done: boolean;
}

/** `GET /v1/templates/{id}/builds/{version}/logs`. */
export function parseLogs(raw: JsonValue | undefined): LogPage {
  const lines = field(raw, "lines");
  const next = field(raw, "next");
  const status = field(raw, "status");

  if (!Array.isArray(lines) || !isNumber(next) || !isString(status))
    throw fail("unexpected template log page from the API");

  return {
    lines: lines.flatMap((line) => {
      const text = field(line, "text");

      return isString(text) ? [text] : [];
    }),
    next,
    status,
    done: field(raw, "done") === true,
  };
}
