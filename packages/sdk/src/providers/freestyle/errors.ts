import { isNumber, isObject, isString } from "../../shared/narrow.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

type RequestEvidence = { status?: number; requestId?: string; operation?: string };

export const requestEvidence = new AsyncLocalStorage<
  RequestEvidence & { deniedValues?: string[]; backgroundRequestId?: string }
>();

const routes = new Set([
  "v5",
  "vms",
  "fs",
  "read",
  "write",
  "uploads",
  "commit",
  "dir",
  "mkdir",
  "remove",
  "exists",
  "stat",
  "exec-await",
  "firewall",
  "rules",
  "tls",
  "pause",
  "start",
  "snapshot",
  "snapshots",
  "background-requests",
]);

function operation(path: string): string {
  // Retain route names only. IDs, file paths, query strings and URLs are private.
  return (path.split("?")[0] ?? "")
    .split("/")
    .map((part) => (routes.has(part) ? part : part ? ":id" : ""))
    .join("/");
}

export function recordRequest(url: string | URL | Request, method = "GET", apiKey?: string) {
  const context = requestEvidence.getStore();

  if (!context) return;

  if (apiKey && !context.deniedValues?.includes(apiKey))
    context.deniedValues = [...(context.deniedValues ?? []), apiKey];
  const path = new URL(url instanceof Request ? url.url : url).pathname;

  if (!path.startsWith("/v5/background-requests/") || !context.operation) {
    context.operation = `${/^(GET|POST|PUT|DELETE|PATCH|HEAD)$/.test(method) ? method : "REQUEST"} ${operation(path)}`;
    delete context.backgroundRequestId;
  }

  delete context.status;
  delete context.requestId;
}

export function recordResponse(response: Response, apiKey: string) {
  const context = requestEvidence.getStore();

  if (!context) return;
  context.status = response.status;
  const backgroundId = response.headers.get("x-freestyle-background-request-id");

  const safeId = (id: string | null | undefined) =>
    id &&
    /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
    !id.includes(apiKey) &&
    !context.deniedValues?.some((value) => id.includes(value))
      ? id
      : undefined;

  if (safeId(backgroundId)) context.backgroundRequestId = safeId(backgroundId);
  context.requestId =
    safeId(response.headers.get("x-request-id")) ??
    safeId(response.headers.get("x-freestyle-request-id")) ??
    context.backgroundRequestId;
}

export function failure(
  message: string,
  code: ErrorCode = "provider",
  sandboxId?: string,
  cause?: unknown,
) {
  return new SandboxError(
    code === "auth" ? message : `${message}. Check Freestyle configuration and retry.`,
    {
      code,
      provider: "freestyle",
      sandboxId,
      cause,
    },
  );
}

/** A non-2xx Freestyle answer: its status and the error body's `code`, `message`. The message is classified, never kept. */
export class FreestyleApiError extends Error {
  override readonly name = "FreestyleApiError";
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string | undefined,
    readonly path: string,
    readonly backgroundRequestId?: string,
  ) {
    super(message || `Freestyle API error: ${code ?? status}`);
  }
}

const codes: Record<number, ErrorCode> = {
  400: "invalid_argument",
  401: "auth",
  403: "auth",
  404: "not_found",
  402: "quota",
  408: "timeout",
  429: "quota",
  500: "unavailable",
  502: "unavailable",
  503: "unavailable",
  504: "timeout",
};

/** The filesystem API answers a missing guest path with 404 NOT_FOUND too; only its message tells it from a missing VM. */
export const missingPath = (status: number, message: string | undefined) =>
  status === 404 && /no such file or directory|\bos error 2\b/i.test(message ?? "");

/** The code for a Freestyle status, as adapter errors and native calls report it. */
export const statusCode = (status: number, message?: string): ErrorCode =>
  missingPath(status, message) ? "file_not_found" : (codes[status] ?? "provider");

export function freestyleError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;

  const status = isObject(cause) && "status" in cause ? cause.status : undefined;

  const context = requestEvidence.getStore();
  const evidence: RequestEvidence & { providerCode?: string; native?: string } = {};

  if (isNumber(status) && Number.isInteger(status) && status >= 100 && status <= 599)
    evidence.status = status;

  if (isObject(cause)) {
    if ("code" in cause && isString(cause.code) && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code)) {
      const code = cause.code;

      if (!context?.deniedValues?.some((value) => code.includes(value)))
        evidence.providerCode = code;
    }

    if ("path" in cause && isString(cause.path)) evidence.operation = operation(cause.path);
  }

  if (context?.operation) evidence.operation = context.operation;

  if (context?.status === status && context?.requestId) evidence.requestId = context.requestId;

  const code: ErrorCode = isNumber(status)
    ? statusCode(status, cause instanceof Error ? cause.message : undefined)
    : cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
      ? cause.name === "TimeoutError"
        ? "timeout"
        : "aborted"
      : cause instanceof Error && cause.name === "FreestyleTransportError"
        ? "unavailable"
        : "provider";

  // An unrecognized failure without a status keeps its scrubbed message (see describeNative).
  // A response's message, body and headers never are kept.
  const { detail } = describeNative(cause, {
    code,
    status: status === undefined ? undefined : String(status),
    redact: redacting([process.env.FREESTYLE_API_KEY, ...(context?.deniedValues ?? [])]),
  });

  if (detail !== undefined) evidence.native = detail;

  // Core's redactor preserves Error.message rather than arbitrary cause objects.
  // JSON in the message keeps these fields available there, too, without ever
  // copying a response's message, body, headers, URL or native cause.
  const reported = Object.keys(evidence).length
    ? Object.assign(new Error(JSON.stringify(evidence)), evidence)
    : undefined;

  return failure(
    `Freestyle request failed: ${reason(code, evidence.native)}`,
    code,
    sandboxId,
    reported,
  );
}
