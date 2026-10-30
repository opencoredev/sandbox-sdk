/** Boat API v1 over plain HTTP. Sandboxer serves the same shapes:
 * https://sandboxer.com/api/v1/openapi.yaml. Routes, headers and bodies follow
 * @boatdev/sdk 1.9.9 (`src/apis/BoatApi.ts`), which no longer loads at runtime.
 */
import type { JsonValue } from "../../shared/json.js";
import { isNumber, isObject, isString } from "../../shared/narrow.js";
import { SandboxError } from "../../errors.js";
import { createHttpClient, type Fetch, type HttpClient, type HttpRequest } from "../../http.js";

/** Boat has one API surface: the control plane, which also runs commands and moves files. */
export type BoatPlane = "api";

export type BoatHttp = HttpClient<BoatPlane>;

export interface BoatHttpOptions {
  provider: string;
  label: string;
  keyEnv: string;
  /** Resolved per request, so env set after construction still applies. */
  baseUrl: () => string;
  /** The API key, or a thrown `auth`/`invalid_argument` SandboxError. */
  credentials: () => string;
  /** Values to redact besides the credential header. */
  secrets: () => Iterable<string | undefined>;
  timeoutMs: number;
  retries?: number;
  fetch?: Fetch;
}

/** One client per provider instance. `retries: 0` gives the create loop sole control of attempts. */
export function boatHttp(options: BoatHttpOptions): BoatHttp {
  return createHttpClient({
    provider: options.provider,
    label: options.label,
    defaultPlane: "api",
    planes: {
      api: {
        baseUrl: options.baseUrl,
        auth: () => ({ authorization: `Bearer ${options.credentials()}` }),
      },
    },
    timeoutMs: options.timeoutMs,
    secrets: options.secrets,
    idempotencyHeader: "Idempotency-Key",
    authHint: `Set ${options.keyEnv} to a valid ${options.label} API key.`,
    ...(options.retries === undefined ? undefined : { retries: options.retries }),
    ...(options.fetch === undefined ? undefined : { fetch: options.fetch }),
  });
}

/** The sandbox fields the adapter reads. `raw` is the object as sent, for provider extras (Sandboxer's region). */
export interface BoatSandbox {
  id: string;
  /** `""` when the API sent none: such a VM has no SDK metadata. */
  name: string;
  state: string;
  /** Milliseconds since the epoch, or NaN when missing or invalid. */
  createdAt: number;
  raw: object;
}

function invalidResponse(
  provider: string,
  label: string,
  what: string,
  sandboxId?: string,
): SandboxError {
  return new SandboxError(
    `${label} returned an invalid ${what}. Check the ${label} provider configuration and retry.`,
    { code: "provider", provider, sandboxId },
  );
}

/** Parses one sandbox object. */
export function parseSandbox(
  value: JsonValue | undefined,
  provider: string,
  label: string,
): BoatSandbox {
  if (!isObject(value) || value === null || !("id" in value) || !isString(value.id) || !value.id)
    throw invalidResponse(provider, label, "sandbox");
  const name = "name" in value && isString(value.name) ? value.name : "";
  const state = "state" in value && isString(value.state) ? value.state : "";

  const created =
    "createdAt" in value && (isString(value.createdAt) || isNumber(value.createdAt))
      ? new Date(value.createdAt).getTime()
      : Number.NaN;

  return { id: value.id, name, state, createdAt: created, raw: value };
}

/** `{ sandbox }`, the body of create, get and update. */
export function parseSandboxBody(
  value: JsonValue | undefined,
  provider: string,
  label: string,
): BoatSandbox {
  return parseSandbox(
    isObject(value) && "sandbox" in value ? value.sandbox : undefined,
    provider,
    label,
  );
}

/** `{ sandboxes, pageInfo }` from `GET /sandboxes`. */
export function parseSandboxPage(
  value: JsonValue | undefined,
  provider: string,
  label: string,
): { sandboxes: BoatSandbox[]; hasMore: boolean; nextCursor?: string } {
  if (
    !isObject(value) ||
    value === null ||
    !("sandboxes" in value) ||
    !Array.isArray(value.sandboxes)
  )
    throw invalidResponse(provider, label, "sandbox list");

  const sandboxes = value.sandboxes.map((item: JsonValue | undefined) =>
    parseSandbox(item, provider, label),
  );

  const page: unknown = "pageInfo" in value ? value.pageInfo : undefined;

  const hasMore = isObject(page) && "hasMore" in page && page.hasMore === true;

  const next =
    isObject(page) && page !== null && "nextCursor" in page && isString(page.nextCursor)
      ? page.nextCursor
      : undefined;

  return { sandboxes, hasMore, ...(next === undefined ? undefined : { nextCursor: next }) };
}

/** What `POST /sandboxes/{sandboxId}/commands` returned. */
export type CommandOutcome =
  | {
      kind: "finished";
      stdout: string;
      stderr: string;
      exitCode: number | null;
      truncated: boolean;
    }
  | { kind: "started"; processId: number }
  | { kind: "unknown" };

export function parseCommand(value: JsonValue | undefined): CommandOutcome {
  if (!isObject(value) || value === null) return { kind: "unknown" };

  if (
    "stdout" in value &&
    isString(value.stdout) &&
    "stderr" in value &&
    isString(value.stderr) &&
    "exitCode" in value &&
    (value.exitCode === null || isNumber(value.exitCode))
  ) {
    const truncated =
      ("stdoutTruncated" in value && value.stdoutTruncated === true) ||
      ("stderrTruncated" in value && value.stderrTruncated === true);

    return {
      kind: "finished",
      stdout: value.stdout,
      stderr: value.stderr,
      exitCode: value.exitCode,
      truncated,
    };
  }

  if ("processId" in value && isNumber(value.processId))
    return { kind: "started", processId: value.processId };

  return { kind: "unknown" };
}

export interface CommandBody {
  command: string;
  timeoutSeconds?: number;
  detached?: boolean;
}

/** Runs a command, or starts it with `detached`. Never retried: it is a POST without an idempotency key.
 * `cleanup` sends it after an abort, with its own short deadline. */
export async function command(
  http: BoatHttp,
  id: string,
  body: CommandBody,
  cleanup = false,
): Promise<CommandOutcome> {
  const request: HttpRequest<BoatPlane> = {
    method: "POST",
    path: "/sandboxes/{sandboxId}/commands",
    params: { sandboxId: id },
    sandboxId: id,
    body,
  };

  return parseCommand((await (cleanup ? http.cleanup(request) : http.request(request))).json());
}

/** `PUT /files`: at most 5 MiB decoded, only under /home/user or /tmp, parents created. */
export async function writeFile(
  http: BoatHttp,
  id: string,
  body: { path: string; content: string; encoding: "utf8" | "base64" },
): Promise<void> {
  await http.request({
    method: "PUT",
    path: "/sandboxes/{sandboxId}/files",
    params: { sandboxId: id },
    sandboxId: id,
    body,
  });
}

/** Kills a detached command and its descendants. Resolves with the reported `running` value. */
export async function stopCommand(
  http: BoatHttp,
  id: string,
  processId: number,
): Promise<JsonValue | undefined> {
  const value = await http.json({
    method: "DELETE",
    path: "/sandboxes/{sandboxId}/commands/{processId}",
    params: { sandboxId: id, processId },
    sandboxId: id,
  });

  return isObject(value) && "running" in value ? value.running : undefined;
}
