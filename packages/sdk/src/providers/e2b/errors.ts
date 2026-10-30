import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";
import type { FailedRequest, HttpFailure } from "../../http.js";

/**
 * Connect error codes, from unary error bodies and stream end frames, as e2b's DEFAULT_ERROR_MAP reads them.
 * Codes it leaves to its generic SandboxError (already_exists, internal, ...) stay `provider`.
 */
const connectCodes: Readonly<Record<string, ErrorCode>> = {
  invalid_argument: "invalid_argument",
  unauthenticated: "auth",
  permission_denied: "auth",
  not_found: "not_found",
  resource_exhausted: "quota",
  unavailable: "unavailable",
  canceled: "timeout",
  deadline_exceeded: "timeout",
};

/** The envd file routes: a missing path there is `file_not_found`, not a missing sandbox. */
export function isFileOperation(operation: string): boolean {
  return / \/files(?:\?|$)/.test(operation) || operation.includes(" /filesystem.Filesystem/");
}

/** Maps a Connect error code. `file` turns `not_found` into `file_not_found`. */
export function connectCode(code: string, file: boolean): ErrorCode {
  const mapped = Object.hasOwn(connectCodes, code) ? connectCodes[code] ?? "provider" : "provider";
  return mapped === "not_found" && file ? "file_not_found" : mapped;
}

/**
 * The HTTP client's `mapError` hook. Status mapping never depends on SDK class names: envd answers with a
 * Connect code in the body, the API and envd's file routes with a status. 507 (no disk space) is `quota`.
 */
export function mapE2BError(failure: HttpFailure, request: FailedRequest): ErrorCode | undefined {
  if (failure.kind !== "status") return undefined;
  const file = request.plane === "envd" && isFileOperation(request.operation);
  const code = failure.body.code;
  if (request.plane === "envd" && code !== undefined && Object.hasOwn(connectCodes, code)) return connectCode(code, file);
  if (failure.status === 507) return "quota";
  if (failure.status === 404 && file) return "file_not_found";
  return undefined;
}

/** A Connect error from a stream end frame, which arrives inside an HTTP 200. Keeps only the code, never envd's text. */
export function rpcError(options: { code: string; method: string; sandboxId: string; file?: boolean }): SandboxError {
  const code = connectCode(options.code, options.file ?? false);
  const safe = /^[a-z_]{1,32}$/.test(options.code) ? options.code : "unknown";
  return new SandboxError(`E2B ${options.method} failed (rpc ${safe}).`, { code, provider: "e2b", sandboxId: options.sandboxId, retryable: ["quota", "unavailable", "timeout"].includes(code), cause: `rpc ${safe}` });
}

/** Wraps anything that is not already a SandboxError. Only an unrecognized local failure keeps its scrubbed text. */
export function e2bError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const code: ErrorCode = typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError" ? "aborted" : "provider";
  const native = describeNative(cause, { code, redact: redacting([process.env.E2B_API_KEY]) });
  return new SandboxError(`E2B request failed: ${reason(code, native.detail)}. Check the sandbox, template and E2B service, then retry.`, { code, provider: "e2b", sandboxId, cause: native.cause });
}
