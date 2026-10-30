import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";
import type { FailedRequest, HttpFailure } from "../../http.js";

// These codes are already recognized by this adapter. Unknown wire codes are
// omitted until verified; a spelling filter alone can admit reflected secrets.
const knownCodes = new Set(["FILE_NOT_FOUND", "QUOTA_EXCEEDED"]);
const requestIdShape =
  /^(?:[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const operations =
  /^(request|create|restore|list|connect|destroy|exec|process|preview|snapshot|files)$/;

/** Bounded, validated attribution copied onto an error's cause. Never a response's message or body. */
interface Evidence {
  status?: number;
  providerCode?: string;
  requestId?: string;
  operation: string;
  source?: string;
  native?: string;
}
const isEvidence = (cause: unknown): cause is Error & Evidence =>
  cause instanceof Error && typeof Reflect.get(cause, "operation") === "string";

/**
 * Maps a failure to a SandboxError with bounded evidence on its cause. `error` is an HTTP failure shaped by
 * {@link httpHooks} (`statusCode`, `code`, `source`, `headers`), any other thrown value, or a SandboxError,
 * which keeps its code and only gets `operation` set on its evidence.
 */
export function daytonaError(
  error: unknown,
  sandboxId?: string,
  file = false,
  operation = file ? "files" : "request",
  apiKey = process.env.DAYTONA_API_KEY,
  knownSecrets: Iterable<string> = [],
): SandboxError {
  const safeOperation = operations.test(operation) ? operation : "request";
  if (error instanceof SandboxError) {
    if (!isEvidence(error.cause) || error.cause.operation === safeOperation) return error;
    const { status, providerCode, requestId, source, native } = error.cause;
    const evidence: Evidence = {
      operation: safeOperation,
      ...(status === undefined ? {} : { status }),
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(source === undefined ? {} : { source }),
      ...(native === undefined ? {} : { native }),
    };
    return new SandboxError(error.message, {
      code: error.code,
      provider: error.provider,
      sandboxId: error.sandboxId,
      retryable: error.retryable,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      cause: Object.assign(new Error(JSON.stringify(evidence)), evidence),
    });
  }
  const status =
    error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
  const nativeCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const name = error instanceof Error ? error.name : "";
  const missingFile =
    file &&
    status === 400 &&
    error instanceof Error &&
    /(?:\bENOENT\b|no such file or directory|\bnot found\b|\bdoes not exist\b)/i.test(
      error.message,
    );
  let code: ErrorCode = "provider";
  if (status === 401 || status === 403) code = "auth";
  else if (nativeCode === "FILE_NOT_FOUND" || (file && status === 404) || missingFile)
    code = "file_not_found";
  else if (status === 404 || status === 410) code = "not_found";
  else if (status === 429 || status === 402 || nativeCode === "QUOTA_EXCEEDED") code = "quota";
  else if (status === 408 || status === 504 || name.includes("Timeout")) code = "timeout";
  else if ((typeof status === "number" && status >= 500) || name.includes("Connection"))
    code = "unavailable";
  else if (status === 400 || status === 422 || name.includes("InvalidArgument"))
    code = "invalid_argument";
  const evidence: Evidence = { operation: safeOperation };
  const denied = [...knownSecrets, apiKey, process.env.DAYTONA_API_KEY].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const safeToken = (value: unknown, pattern: RegExp): value is string =>
    typeof value === "string" &&
    pattern.test(value) &&
    !denied.some((secret) => value.includes(secret));
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
    evidence.status = status;
  if (safeToken(nativeCode, /^[A-Z_]{1,64}$/) && knownCodes.has(nativeCode))
    evidence.providerCode = nativeCode;
  if (error && typeof error === "object") {
    if ("source" in error && safeToken(error.source, /^DAYTONA_(API|DAEMON|PROXY)$/))
      evidence.source = error.source;
    if ("headers" in error && error.headers && typeof error.headers === "object") {
      for (const key of ["x-request-id", "x-daytona-request-id"]) {
        const value: unknown = Reflect.get(error.headers, key);
        if (safeToken(value, requestIdShape)) {
          evidence.requestId = value;
          break;
        }
      }
    }
  }
  const { detail } = describeNative(error, {
    code,
    status: status === undefined ? undefined : String(status),
    redact: redacting(denied),
  });
  if (detail !== undefined) evidence.native = detail;
  // Error.message survives the SDK redactor; own fields support direct clients.
  const cause = Object.assign(new Error(JSON.stringify(evidence)), evidence);
  return new SandboxError(
    `Daytona request failed: ${reason(code, evidence.native)}. Check the sandbox and provider configuration.`,
    {
      code,
      provider: "daytona",
      sandboxId,
      cause,
      retryable: ["quota", "unavailable", "timeout"].includes(code),
      hint: "Check Daytona credentials, quotas, sandbox state, and request options before retrying.",
    },
  );
}

/** A toolbox call on a path, as opposed to a process or session: its 404 means a missing file. */
export function isFileRequest(request: FailedRequest): boolean {
  return request.plane === "toolbox" && /^[A-Z]+ \/files(?:\/|$)/.test(request.operation);
}
/** An HTTP status failure in the shape {@link daytonaError} reads. The message is only matched, never copied. */
function statusFailure(failed: Extract<HttpFailure, { kind: "status" }>) {
  const json = failed.body.json;
  const source: unknown =
    typeof json === "object" && json !== null ? Reflect.get(json, "source") : undefined;
  const headers: Record<string, string> = {};
  for (const key of ["x-request-id", "x-daytona-request-id"]) {
    const value = failed.headers.get(key);
    if (value !== null) headers[key] = value;
  }
  return Object.assign(new Error(failed.body.message ?? ""), {
    statusCode: failed.status,
    code: failed.body.code,
    source,
    headers,
  });
}
/**
 * The HTTP client's `mapError` and `cause` hooks: Daytona's status rules (a missing file is a 404, or a 400
 * that says so), and the same bounded evidence {@link daytonaError} builds. Other failures keep the defaults.
 */
export function httpHooks(denied: () => Iterable<string>) {
  const map = (failed: HttpFailure, request: FailedRequest) =>
    failed.kind === "status"
      ? daytonaError(
          statusFailure(failed),
          request.sandboxId,
          isFileRequest(request),
          "request",
          undefined,
          denied(),
        )
      : undefined;
  return {
    mapError: (failed: HttpFailure, request: FailedRequest): ErrorCode | undefined =>
      map(failed, request)?.code,
    cause: (failed: HttpFailure, request: FailedRequest): Error | undefined => {
      const cause = map(failed, request)?.cause;
      return cause instanceof Error ? cause : undefined;
    },
  };
}

export function unsupported(message: string): never {
  throw new SandboxError(
    `${message}. Daytona cannot enforce this request. Choose supported settings.`,
    { code: "unsupported", provider: "daytona" },
  );
}
