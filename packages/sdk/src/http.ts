/**
 * The HTTP client converted adapters and `box.native` share. One client per provider instance.
 *
 * - Planes: each provider API surface (control plane, Daytona's toolbox, Superserve's data plane) has a base
 *   URL, possibly per sandbox, and its own credentials. Credentials attach only to that plane's origin; an
 *   absolute URL or redirect elsewhere (signed upload URLs, poll URLs) gets none.
 * - Retries: at most `retries` more attempts on 429, 502, 503, 504 and network errors, only for GET, HEAD, PUT
 *   and DELETE, or a POST/PATCH that carries a server-supported idempotency key. Never with a streamed body.
 *   `Retry-After` is honoured up to 20 s and never past the deadline.
 * - Outcomes: a POST or PATCH that fails after it may have reached the server (a network error once sent, a
 *   timeout, a 504) is `outcome_unknown`, not `unavailable`: the caller must check before repeating it.
 * - Deadlines: `timeoutMs` (or a shared {@link Deadline}) covers credentials, every attempt, backoff and the
 *   body. Streams have a startup timeout (until headers) and an idle timeout (between chunks) instead.
 * - Redaction: credential header values, `secrets()` and credential-shaped text never reach a SandboxError.
 *   Response text is kept only for native calls (`detail: "message"`), scrubbed; adapter calls keep the
 *   status and the provider's error code.
 */
import { SandboxError, nativeDetail, redacting, scrub, statusCode, type ErrorCode } from "./errors.js";
import type { HttpMethod } from "./native.js";

/** Blocks inference from a position, like TypeScript 5.4's `NoInfer`, for consumers on older compilers. */
type NoInfer<T> = [T][T extends unknown ? 0 : never];

/** The subset of `fetch` the client calls. `globalThis.fetch` and test doubles both fit. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** What a plane's base URL and credential callbacks get. One call passes the same object to every callback. */
export interface PlaneContext {
  /** The sandbox the request is for, when there is one. */
  sandboxId?: string;
  /** Fires when the request's deadline or the caller's signal does. */
  signal: AbortSignal;
}

/** One API surface of a provider. */
export interface HttpPlane {
  /**
   * The base URL, including any path prefix (`https://app.daytona.io/api`). Paths are appended to it. A
   * function can resolve it per sandbox, such as a regional proxy; cache inside it.
   */
  baseUrl: string | ((context: PlaneContext) => string | Promise<string>);
  /** Credential headers, read once per attempt so rotated tokens apply. Sent only to the base URL's origin. */
  auth?: (context: PlaneContext) => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Refresh the credentials `auth` returns. Called once after a 401 from this plane, shared between
   * concurrent requests, and the request is sent again with fresh credentials. `context` is the first
   * waiter's; a waiter whose signal fires stops waiting, so do not abort the shared work on `context.signal`.
   */
  refresh?: (context: PlaneContext) => Promise<void>;
  /**
   * Which failed responses besides a 401 mean stale credentials or a stale route, such as a 404 whose error
   * code says the route moved. `true` refreshes and resends once, like a 401. `credentials` are the headers
   * `auth` returned for that attempt. Default: only a 401.
   */
  stale?: (failure: { status: number; body: ErrorBody; credentials: Readonly<Record<string, string>> }, context: PlaneContext) => boolean;
  /** Headers for every request to this plane that are not credentials (`Accept`, API version pins). */
  headers?: Record<string, string>;
}

/** What a provider error hook sees. `body` is bounded to 64 KB and must never be copied into messages. */
export type HttpFailure =
  | { kind: "status"; status: number; headers: Headers; body: ErrorBody }
  | { kind: "network"; sent: boolean; error: unknown }
  | { kind: "timeout"; sent: boolean }
  | { kind: "aborted" };

/** A non-2xx response's body, as far as the client parsed it. */
export interface ErrorBody {
  /** The first 64 KB of the body, decoded as UTF-8. */
  text: string;
  /** `text` parsed as JSON, or `undefined` when it is not JSON. */
  json: unknown;
  /** The provider's error code (`sandbox_not_found`), from `code`, `error.code`, `error` or `type`. */
  code?: string;
  /** The provider's error message, from `message`, `error.message`, `error`, `detail` or `title`. */
  message?: string;
}

/** The request a hook classifies. */
export interface FailedRequest {
  method: HttpMethod;
  plane: string;
  /** `METHOD /path/{template}`, without query strings or filled values. */
  operation: string;
  sandboxId?: string;
}

export interface HttpClientOptions<Plane extends string> {
  /** Provider name on errors: `"daytona"`. */
  provider: string;
  /** Display name in messages: `"Daytona"`. */
  label: string;
  planes: Record<Plane, HttpPlane>;
  /** The plane a request without `plane` uses. Plane names are inferred from `planes` only. */
  defaultPlane: NoInfer<Plane>;
  /** Default: `globalThis.fetch`, looked up per request so test stubs apply. */
  fetch?: Fetch;
  /** Default overall deadline per call, in ms. Default: 60000. */
  timeoutMs?: number;
  /** Extra attempts for retryable failures. Default: 2. */
  retries?: number;
  /** First backoff, doubled per attempt with jitter. Default: 250. */
  backoffMs?: number;
  /** Values to redact besides the credential headers, read on each error (API keys, tokens). */
  secrets?: () => Iterable<string | undefined>;
  /** Header that carries `idempotencyKey`. Leave it out when the key travels in the body. */
  idempotencyHeader?: string;
  /** Next step for `auth` errors: `"Set DAYTONA_API_KEY to a valid Daytona API key."` */
  authHint?: string;
  /**
   * Refine the shared status mapping, such as a 404 for a missing file (`file_not_found`) or a stale route.
   * Return `undefined` to keep the default. Never put `failure.body` text in errors.
   */
  mapError?: (failure: HttpFailure, request: FailedRequest) => ErrorCode | undefined;
  /**
   * Build the error's `cause` instead of the default `HTTP <status> (request <id>)` text, such as an Error with
   * machine-readable evidence fields. Return `undefined` to keep the default. It is not redacted: copy only
   * bounded, validated values, never `failure.body` text.
   */
  cause?: (failure: HttpFailure, request: FailedRequest) => Error | undefined;
}

/** One request. */
export interface HttpRequest<Plane extends string = string> {
  method: HttpMethod;
  /** A path under the plane's base URL, with `{name}` placeholders, or an absolute `https:` URL. */
  path: string;
  plane?: Plane;
  /** The sandbox this is for: passed to plane callbacks and put on errors. */
  sandboxId?: string;
  /** Values for every `{name}` placeholder in `path`, URI-encoded. Missing or unused names are `invalid_argument`. */
  params?: Readonly<Record<string, string | number>>;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Sent as is when it is a `BodyInit` (string, bytes, Blob, FormData, URLSearchParams, ReadableStream), else as JSON. */
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Overall deadline for this call. Ignored when `deadline` is given. Default: the client's `timeoutMs`. */
  timeoutMs?: number;
  /** A deadline shared with other calls of the same operation (create then poll). */
  deadline?: Deadline;
  /** A server-supported idempotency key. It makes a POST or PATCH retryable; with `idempotencyHeader`, the client sends it. */
  idempotencyKey?: string;
  /** A POST or PATCH that changes nothing (a search). Failures after sending map like a GET's, not `outcome_unknown`. Still not retried. */
  readOnly?: boolean;
  /** `false` sends no credentials, even to the plane's origin (signed URLs). */
  auth?: false;
  /** Largest buffered response body in bytes. Default: 32 MiB. */
  maxBytes?: number;
  /** `"message"` keeps the provider's scrubbed error message in the error (native calls). Default: `"status"`. */
  detail?: "status" | "message";
}

/** A stream request: the overall deadline is off unless `timeoutMs` or `deadline` is set. */
export interface StreamRequest<Plane extends string = string> extends HttpRequest<Plane> {
  /** Time until response headers. Default: the client's `timeoutMs`. */
  startupTimeoutMs?: number;
  /** Longest gap between body chunks. Default: none. */
  idleTimeoutMs?: number;
}

/** A buffered response. */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  /** The body as UTF-8 text. */
  text(): string;
  /** The body parsed as JSON, or `undefined` when it is empty. Invalid JSON is a `provider` SandboxError. */
  json(): unknown;
}

export interface HttpClient<Plane extends string = string> {
  readonly provider: string;
  readonly label: string;
  /** Redacts credentials seen so far, `secrets()` and credential-shaped text. */
  readonly redact: (text: string) => string;
  /** Send a request and buffer the response body (bounded by `maxBytes`). Non-2xx rejects. */
  request(request: HttpRequest<Plane>): Promise<HttpResponse>;
  /** `request(...).json()`. */
  json(request: HttpRequest<Plane>): Promise<unknown>;
  /** Send a request and return once headers arrive. The body enforces the idle timeout and deadline; the caller reads or cancels it. */
  stream(request: StreamRequest<Plane>): Promise<Response>;
  /** A best-effort request after an abort: no caller signal, its own deadline of at most 10 s. */
  cleanup(request: HttpRequest<Plane>): Promise<HttpResponse>;
}

/** A deadline several calls share. */
export interface Deadline {
  /** Fires on the timeout or the caller's signal. */
  readonly signal: AbortSignal;
  /** Fires only on the timeout. */
  readonly timeout: AbortSignal;
  /** The caller's signal, if any. */
  readonly parent?: AbortSignal;
  /** Milliseconds left, never negative. */
  remaining(): number;
}

/** A deadline `timeoutMs` from now that also follows `parent`. */
export function createDeadline(timeoutMs: number, parent?: AbortSignal): Deadline {
  const at = Date.now() + timeoutMs;
  const timeout = AbortSignal.timeout(Math.max(0, timeoutMs));
  return { signal: parent ? AbortSignal.any([parent, timeout]) : timeout, timeout, parent, remaining: () => Math.max(0, at - Date.now()) };
}

/** Waits `ms`, rejecting with a `timeout` or `aborted` SandboxError when `deadline` fires first. For polling loops. */
export function sleep(ms: number, deadline: Deadline, provider: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); deadline.signal.removeEventListener("abort", fire); };
    const fire = () => { done(); reject(stopped(deadline, provider)); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    if (deadline.signal.aborted) fire(); else deadline.signal.addEventListener("abort", fire, { once: true });
  });
}
/** `promise`, or a rejection as soon as `signal` fires. The promise itself is not cancelled. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const fire = () => reject(signal.reason);
    signal.addEventListener("abort", fire, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", fire));
  });
}
function stopped(deadline: Deadline, provider: string, sandboxId?: string): SandboxError {
  return deadline.parent?.aborted && !deadline.timeout.aborted
    ? new SandboxError("Request aborted. The signal was cancelled.", { code: "aborted", provider, sandboxId })
    : new SandboxError("Request timed out. The operation took too long.", { code: "timeout", provider, sandboxId, retryable: true });
}

const statuses = new WeakMap<SandboxError, { status: number; code?: string }>();
/**
 * The HTTP status and provider error code (when it is a safe token) behind a client error, or `undefined`
 * for errors that are not a non-2xx response. For adapters that branch on a status, such as a 409 retry.
 */
export function httpStatus(error: unknown): { status: number; code?: string } | undefined {
  return error instanceof SandboxError ? statuses.get(error) : undefined;
}

const errorBodyBytes = 64 * 1024;
const defaultMaxBytes = 32 * 1024 * 1024;
const maxRetryAfterMs = 20_000;
const cleanupTimeoutMs = 10_000;
const maxRedirects = 5;
const retryStatuses = new Set([429, 502, 503, 504]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const idempotentMethods = new Set<HttpMethod>(["GET", "HEAD", "PUT", "DELETE"]);
// Failure codes (undici, Node and Bun) that mean the request never left this process: no server saw it.
const unsentCodes = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "ConnectionRefused", "FailedToOpenSocket", "ERR_INVALID_URL", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED"]);
const placeholderPattern = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const safeCode = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const safeRequestId = /^[A-Za-z0-9_.:-]{1,128}$/;

function errorCodes(error: unknown, depth = 0): string[] {
  if (typeof error !== "object" || error === null || depth > 3) return [];
  const own = "code" in error && typeof error.code === "string" ? [error.code] : [];
  return [...own, ...errorCodes("cause" in error ? error.cause : undefined, depth + 1)];
}
function isBodyInit(value: unknown): value is BodyInit {
  return typeof value === "string" || value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value) ||
    value instanceof Blob || value instanceof FormData || value instanceof URLSearchParams || value instanceof ReadableStream;
}
function retryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
function pick(value: unknown, keys: readonly string[]): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const key of keys) { const found: unknown = Reflect.get(value, key); if (typeof found === "string" && found) return found; }
  return undefined;
}
/** Pulls the code and message out of the error shapes providers use: `{ code, message }`, `{ error: { code, message } }`, `{ error: "text" }`, RFC 7807. */
export function parseErrorBody(text: string): ErrorBody {
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  const nested = typeof json === "object" && json !== null ? Reflect.get(json, "error") : undefined;
  const code = pick(json, ["code", "error_code", "errorCode", "type"]) ?? pick(nested, ["code", "type"]) ?? (typeof nested === "string" && safeCode.test(nested) ? nested : undefined);
  const message = pick(json, ["message", "detail", "error_description", "title"]) ?? pick(nested, ["message"]) ?? (typeof nested === "string" ? nested : undefined) ?? (json === undefined && text.trim() ? text.trim() : undefined);
  return { text, json, ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) };
}
/** Reads at most `limit` bytes. `onOverflow: "truncate"` stops there and cancels; `"throw"` throws. */
async function readBody(body: ReadableStream<Uint8Array> | null, limit: number, onOverflow: () => Error | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) {
        const error = onOverflow();
        chunks.push(value.subarray(0, limit - size)); size = limit;
        await reader.cancel().catch(() => {});
        if (error) throw error;
        break;
      }
      chunks.push(value); size += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
const utf8 = new TextDecoder();
function buffered(status: number, headers: Headers, body: Uint8Array, fail: (message: string) => SandboxError): HttpResponse {
  return {
    status, headers, body,
    text: () => utf8.decode(body),
    json() {
      const text = utf8.decode(body);
      if (!text.trim()) return undefined;
      try { return JSON.parse(text); } catch { throw fail("returned a body that is not JSON. Use fetch for text, bytes or streams"); }
    },
  };
}

/** Builds the client. Planes are fixed; their base URLs and credentials are read per request. */
export function createHttpClient<Plane extends string>(options: HttpClientOptions<Plane>): HttpClient<Plane> {
  const { provider, label } = options;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 250;
  // Credential values the client has sent. They are redacted from every later error too.
  const sent = new Set<string>();
  const remember = (value: string) => {
    sent.delete(value); sent.add(value);
    // Rotating tokens add a value per refresh; keep the newest 256.
    for (const old of sent) { if (sent.size <= 256) break; sent.delete(old); }
  };
  const redact = (text: string) => scrub(redacting([...sent, ...(options.secrets?.() ?? [])])(text));
  // Single-flight credential refresh per plane and sandbox. `generation` tells a request that got a 401 with
  // credentials older than the latest refresh to just resend, instead of refreshing again.
  const refreshes = new Map<string, { generation: number; pending?: Promise<void> }>();

  const planes: Readonly<Record<string, HttpPlane>> = options.planes;
  function planeOf(name: string | undefined): { name: string; plane: HttpPlane } {
    const key = name ?? options.defaultPlane;
    // Native callers pass any string at runtime, so look the plane up as an own key only.
    const plane = Object.hasOwn(planes, key) ? planes[key] : undefined;
    if (!plane) throw invalidRequest(`Unknown plane "${String(key).slice(0, 32)}". Use one of: ${Object.keys(planes).join(", ")}`);
    return { name: key, plane };
  }
  function invalidRequest(message: string, sandboxId?: string) {
    return new SandboxError(`${redact(message)}. The request is invalid. Check the supplied options.`, { code: "invalid_argument", provider, sandboxId });
  }
  /** `METHOD /template`, with no query or filled values: safe to show. */
  function operationOf(request: HttpRequest<string>) {
    const path = /^[a-z][a-z0-9+.-]*:/i.test(request.path) ? "[absolute URL]" : (request.path.split("?")[0] ?? "").slice(0, 200);
    return `${request.method} ${scrub(path)}`;
  }
  function fillPath(request: HttpRequest<string>): string {
    const params = request.params ?? {};
    const used = new Set<string>();
    const filled = request.path.replace(placeholderPattern, (_, name: string) => {
      if (!Object.hasOwn(params, name)) throw invalidRequest(`The path has a {${name}} placeholder but params.${name} is missing`, request.sandboxId);
      const value = String(params[name]);
      if (value === "" || value === "." || value === "..") throw invalidRequest(`params.${name} must not be empty, "." or ".."`, request.sandboxId);
      used.add(name);
      return encodeURIComponent(value);
    });
    const unused = Object.keys(params).filter(name => !used.has(name));
    if (unused.length) throw invalidRequest(`params.${unused[0]} has no {${unused[0]}} placeholder in the path`, request.sandboxId);
    return filled;
  }
  function buildUrl(base: string, request: HttpRequest<string>): URL {
    const path = fillPath(request);
    let url: URL;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
      try { url = new URL(path); } catch { throw invalidRequest("The path is not a valid URL", request.sandboxId); }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw invalidRequest("Only http and https URLs are supported", request.sandboxId);
    } else {
      if (!path.startsWith("/")) throw invalidRequest(`The path must start with "/" or be an absolute URL`, request.sandboxId);
      if (path.split("?")[0]?.split("/").some(segment => segment === "." || segment === "..")) throw invalidRequest(`The path must not contain "." or ".." segments`, request.sandboxId);
      url = new URL(base.replace(/\/+$/, "") + path);
    }
    for (const [name, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.append(name, String(value));
    return url;
  }

  function failure(code: ErrorCode, request: HttpRequest<string>, what: string, cause?: string, retryable = code === "unavailable" || code === "quota") {
    const hint = code === "auth" ? options.authHint : undefined;
    return new SandboxError(redact(`${label} ${operationOf(request)} failed${what}`), { code, provider, sandboxId: request.sandboxId, retryable, ...(hint === undefined ? {} : { hint }), ...(cause === undefined ? {} : { cause: redact(cause) }) });
  }
  /** Maps a failure with the provider hook first, then the shared rules. */
  function mapFailure(failed: HttpFailure, request: HttpRequest<string>, plane: string): SandboxError {
    const error = mapDefault(failed, request, plane);
    const cause = options.cause?.(failed, { method: request.method, plane, operation: operationOf(request), sandboxId: request.sandboxId });
    if (cause === undefined) return error;
    return new SandboxError(error.message, { code: error.code, provider, sandboxId: error.sandboxId, retryable: error.retryable, ...(error.hint === undefined ? {} : { hint: error.hint }), cause });
  }
  function mapDefault(failed: HttpFailure, request: HttpRequest<string>, plane: string): SandboxError {
    const unsafe = !idempotentMethods.has(request.method) && !request.readOnly;
    const hooked = options.mapError?.(failed, { method: request.method, plane, operation: operationOf(request), sandboxId: request.sandboxId });
    switch (failed.kind) {
      case "status": {
        let code = hooked ?? statusCode(failed.status);
        if (code === "timeout" && unsafe) code = "outcome_unknown";
        const apiCode = failed.body.code !== undefined && safeCode.test(failed.body.code) ? ` ${failed.body.code}` : "";
        const id = ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"].map(name => failed.headers.get(name)).find(value => value !== null && safeRequestId.test(value));
        const status = `HTTP ${failed.status}${apiCode}`;
        const message = request.detail === "message" && failed.body.message ? `: ${scrub(redact(failed.body.message)).slice(0, 300)}` : "";
        const cause = `${status}${id ? ` (request ${id})` : ""}${message}`;
        const error = failure(code, request, ` (${status})${message}.${code === "outcome_unknown" ? " The request may or may not have taken effect; check before repeating it." : ""}`, cause, code === "unavailable" || code === "quota" || code === "timeout");
        statuses.set(error, { status: failed.status, ...(apiCode ? { code: apiCode.trim() } : {}) });
        return error;
      }
      case "network": {
        const detail = nativeDetail(failed.error, redact);
        if (unsafe && failed.sent) return failure(hooked ?? "outcome_unknown", request, ": the connection failed after the request was sent, so it may or may not have taken effect. Check before repeating it.", detail, false);
        return failure(hooked ?? "unavailable", request, `: ${failed.sent ? "the connection failed" : "the service is unreachable"}.`, detail, true);
      }
      case "timeout":
        if (unsafe && failed.sent) return failure(hooked ?? "outcome_unknown", request, ": no response before the deadline, so it may or may not have taken effect. Check before repeating it.", undefined, false);
        return failure(hooked ?? "timeout", request, ": no response before the deadline.", undefined, true);
      case "aborted":
        return failure(hooked ?? "aborted", request, ": the signal was cancelled.", undefined, false);
      default: { const _exhaustive: never = failed; return _exhaustive; }
    }
  }

  function serialize(request: HttpRequest<string>): { body: BodyInit | undefined; contentType?: string; replayable: boolean } {
    if (request.body === undefined) return { body: undefined, replayable: true };
    if (request.method === "GET" || request.method === "HEAD") throw invalidRequest(`A ${request.method} request cannot have a body`, request.sandboxId);
    if (isBodyInit(request.body)) return { body: request.body, replayable: !(request.body instanceof ReadableStream) };
    return { body: JSON.stringify(request.body), contentType: "application/json", replayable: true };
  }

  /** Runs the attempts. Resolves with a 2xx response whose body is unread; `deadline.signal` aborts it. */
  async function exchange(request: HttpRequest<string>, deadline: Deadline): Promise<Response> {
    const { name: planeName, plane } = planeOf(request.plane);
    const { body, contentType, replayable } = serialize(request);
    const unsafe = !idempotentMethods.has(request.method);
    const canRetry = replayable && (!unsafe || request.idempotencyKey !== undefined);
    const { signal } = deadline;
    const context: PlaneContext = { signal, ...(request.sandboxId === undefined ? {} : { sandboxId: request.sandboxId }) };
    const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const refreshKey = `${planeName}\0${request.sandboxId ?? ""}`;
    let refreshed = false;
    /** Which deadline fired: the caller's signal is an abort, anything else (overall, stream startup) a timeout. */
    const halted = (): HttpFailure | undefined => deadline.parent?.aborted && !deadline.timeout.aborted ? { kind: "aborted" } : signal.aborted ? { kind: "timeout", sent: false } : undefined;

    for (let attempt = 0; ; attempt++) {
      const stop = halted();
      if (stop) throw mapFailure(stop, request, planeName);
      let base: string;
      let credentials: Record<string, string>;
      try {
        base = typeof plane.baseUrl === "string" ? plane.baseUrl : await plane.baseUrl(context);
        credentials = request.auth === false || !plane.auth ? {} : await plane.auth(context);
      } catch (error) {
        if (error instanceof SandboxError) throw error;
        const halt = halted();
        if (halt) throw mapFailure(halt, request, planeName);
        throw failure("auth", request, `: resolving ${label} credentials failed.`, nativeDetail(error, redact), false);
      }
      for (const value of Object.values(credentials)) if (value) remember(value);
      const generation = refreshes.get(refreshKey)?.generation ?? 0;
      let origin: string;
      try { origin = new URL(base).origin; } catch { throw failure("provider", request, `: the ${label} base URL is invalid.`, undefined, false); }
      let url = buildUrl(base, request);
      let method: HttpMethod = request.method;
      let sendBody = body;
      let response: Response | undefined;
      let failed: HttpFailure | undefined;
      for (let hop = 0; ; hop++) {
        const headers = new Headers({ ...plane.headers, ...(contentType && sendBody !== undefined ? { "content-type": contentType } : {}) });
        if (request.idempotencyKey !== undefined && options.idempotencyHeader) headers.set(options.idempotencyHeader, request.idempotencyKey);
        if (url.origin === origin) for (const [name, value] of Object.entries(credentials)) headers.set(name, value);
        for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value);
        const init: RequestInit & { duplex?: "half" } = { method, headers, body: sendBody, signal, redirect: "manual" };
        if (sendBody instanceof ReadableStream) init.duplex = "half";
        try {
          response = await fetcher(url.href, init);
        } catch (error) {
          response = undefined;
          // A deadline that fires mid-request may have let it reach the server, so a timeout counts as sent.
          const halt = halted();
          failed = halt?.kind === "timeout" ? { kind: "timeout", sent: true } : halt ?? { kind: "network", sent: !errorCodes(error).some(code => unsentCodes.has(code)), error };
          break;
        }
        const location = response.headers.get("location");
        if (!redirectStatuses.has(response.status) || location === null) break;
        await response.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) throw failure("provider", request, `: more than ${maxRedirects} redirects.`, undefined, false);
        try { url = new URL(location, url); } catch { throw failure("provider", request, ": the redirect location is invalid.", undefined, false); }
        if (url.protocol !== "https:" && url.protocol !== "http:") throw failure("provider", request, ": the redirect left http and https.", undefined, false);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) { method = "GET"; sendBody = undefined; }
        else if (!replayable) throw failure("provider", request, ": the server redirected a streamed upload, which cannot be sent twice.", undefined, false);
      }

      const refreshable = response !== undefined && plane.refresh !== undefined && !refreshed && replayable && request.auth !== false && url.origin === origin;
      // A `stale` hook needs the error body, so read it (bounded) once here and reuse it for the failure below.
      let errorBody: ErrorBody | undefined;
      if (refreshable && plane.stale && response && response.status >= 400 && response.status !== 401)
        errorBody = parseErrorBody(utf8.decode(await readBody(response.body, errorBodyBytes, () => undefined).catch(() => new Uint8Array())));
      if (refreshable && plane.refresh && response && (response.status === 401 || (errorBody !== undefined && plane.stale?.({ status: response.status, body: errorBody, credentials }, context)))) {
        if (errorBody === undefined) await response.body?.cancel().catch(() => {});
        refreshed = true;
        const state = refreshes.get(refreshKey) ?? { generation: 0 };
        refreshes.set(refreshKey, state);
        if (state.generation === generation) {
          state.pending ??= plane.refresh(context).then(() => { state.generation++; }).finally(() => { state.pending = undefined; });
          // Each waiter stops on its own signal; the shared refresh keeps going for the others.
          try { await untilAborted(state.pending, signal); }
          catch (error) {
            const halt = halted();
            if (halt) throw mapFailure(halt, request, planeName);
            if (error instanceof SandboxError) throw error;
            throw failure("auth", request, `: refreshing ${label} credentials failed.`, nativeDetail(error, redact), false);
          }
        }
        attempt--;
        continue;
      }

      let wait: number | undefined;
      if (response && response.status >= 200 && response.status < 300) return response;
      if (response) {
        const body = errorBody ?? parseErrorBody(utf8.decode(await readBody(response.body, errorBodyBytes, () => undefined).catch(() => new Uint8Array())));
        failed = { kind: "status", status: response.status, headers: response.headers, body };
        if (retryStatuses.has(response.status)) {
          const after = retryAfter(response.headers);
          wait = after === undefined ? undefined : after <= maxRetryAfterMs ? after : Infinity;
        }
        if (!retryStatuses.has(response.status)) throw mapFailure(failed, request, planeName);
      }
      if (!failed) throw new SandboxError(`${label} request produced no response`, { code: "provider", provider });
      if (failed.kind === "aborted" || failed.kind === "timeout") throw mapFailure(failed, request, planeName);
      const delay = wait ?? backoffMs * 2 ** attempt * (0.5 + Math.random() / 2);
      if (!canRetry || attempt >= retries || delay === Infinity || delay >= deadline.remaining()) throw mapFailure(failed, request, planeName);
      try { await sleep(delay, deadline, provider); }
      catch { throw mapFailure(halted() ?? failed, request, planeName); }
    }
  }

  async function request(request: HttpRequest<Plane>): Promise<HttpResponse> {
    const deadline = request.deadline ?? createDeadline(request.timeoutMs ?? timeoutMs, request.signal);
    const response = await exchange(request, deadline);
    const limit = request.maxBytes ?? defaultMaxBytes;
    let body: Uint8Array;
    try {
      body = await readBody(response.body, limit, () => failure("unsupported", request, `: the response is larger than ${limit} bytes.`, undefined, false));
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      const { name } = planeOf(request.plane);
      if (deadline.parent?.aborted && !deadline.timeout.aborted) throw mapFailure({ kind: "aborted" }, request, name);
      // The server answered 2xx, so a write took effect; only its result is lost.
      throw mapFailure(deadline.signal.aborted ? { kind: "timeout", sent: true } : { kind: "network", sent: true, error }, request, name);
    }
    return buffered(response.status, response.headers, body, what => failure("provider", { ...request, detail: "status" }, ` (HTTP ${response.status}): the response ${what}.`, undefined, false));
  }

  async function stream(request: StreamRequest<Plane>): Promise<Response> {
    const overall = request.deadline ?? (request.timeoutMs === undefined ? createDeadline(2 ** 31 - 1, request.signal) : createDeadline(request.timeoutMs, request.signal));
    const startup = createDeadline(request.startupTimeoutMs ?? timeoutMs);
    // `startup` must not abort the body once headers are in, so the fetch follows its own controller.
    const controller = new AbortController();
    const relay = () => controller.abort();
    const combined = AbortSignal.any([overall.signal, startup.signal]);
    combined.addEventListener("abort", relay, { once: true });
    const gate: Deadline = { signal: controller.signal, timeout: overall.timeout, parent: overall.parent, remaining: () => Math.min(overall.remaining(), startup.remaining()) };
    let response: Response;
    try { response = await exchange(request, gate); }
    finally { combined.removeEventListener("abort", relay); }
    // Bodiless statuses cannot be rebuilt with a stream; there is nothing to time out.
    if (!response.body || response.status === 204 || response.status === 205) return response;
    overall.signal.addEventListener("abort", relay, { once: true });
    const { name } = planeOf(request.plane);
    const reader = response.body.getReader();
    let idle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const finish = () => { clearTimeout(idle); overall.signal.removeEventListener("abort", relay); };
    const body = new ReadableStream<Uint8Array>({
      async pull(output) {
        if (request.idleTimeoutMs !== undefined) idle = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); controller.abort(); }, request.idleTimeoutMs);
        try {
          const { done, value } = await reader.read();
          clearTimeout(idle);
          if (timedOut) throw new Error("idle");
          if (done) { finish(); output.close(); return; }
          output.enqueue(value);
        } catch (error) {
          finish();
          const failed: HttpFailure = overall.parent?.aborted && !overall.timeout.aborted ? { kind: "aborted" }
            : timedOut || overall.timeout.aborted ? { kind: "timeout", sent: true }
            : { kind: "network", sent: true, error };
          // Headers arrived with a 2xx, so the request took effect: a broken body is a lost connection, not an unknown outcome.
          const mapped = mapFailure(failed, { ...request, readOnly: true }, name);
          output.error(timedOut ? failure("timeout", request, `: no data for ${request.idleTimeoutMs} ms.`, undefined, true) : mapped);
        }
      },
      async cancel(reason) { finish(); await reader.cancel(reason).catch(() => {}); controller.abort(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  return {
    provider, label, redact,
    request,
    async json(input) { return (await request(input)).json(); },
    stream,
    cleanup(input) {
      const { signal: _signal, deadline: _deadline, ...rest } = input;
      return request({ ...rest, timeoutMs: Math.min(input.timeoutMs ?? cleanupTimeoutMs, cleanupTimeoutMs) });
    },
  };
}
