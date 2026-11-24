import { SandboxError, scrub, type ErrorCode } from "../../errors.js";
import type { FailedRequest, HttpFailure } from "../../http.js";
import { isObject, isString } from "../../shared/narrow.js";

export const provider = "microsandbox";

/** An error this adapter writes itself. The message never holds text from Microsandbox. */
export function fail(
  message: string,
  code: ErrorCode = "provider",
  options: { sandboxId?: string; retryable?: boolean; cause?: unknown; hint?: string } = {},
) {
  return new SandboxError(`Microsandbox: ${message}`, { code, provider, ...options });
}

/**
 * Error codes Microsandbox Cloud documents for its control plane and Services
 * (https://docs.microsandbox.dev/sandboxes/services, https://docs.microsandbox.dev/sdk/errors). Only
 * these are shown in a message: any other `code` is text from the network and could hold anything.
 */
const documented: ReadonlySet<string> = new Set([
  "not_found",
  "sandbox_not_found",
  "snapshot_not_found",
  "service_not_found",
  "sandbox_not_running",
  "name_conflict",
  "already_exists",
  "conflict",
  "invalid_request",
  "validation_error",
  "unauthorized",
  "forbidden",
  "quota_exceeded",
  "rate_limited",
  "service_quota_exceeded",
  "sandbox_service_limit_exceeded",
  "service_changes_paused",
  "service_detached",
  "service_unavailable",
  "internal_error",
]);

/** `code` when it is one of Microsandbox's documented error codes, else undefined. */
export function shownCode(code: string | undefined): string | undefined {
  return code !== undefined && documented.has(code) ? code : undefined;
}

const writes = new Set(["POST", "PATCH"]);

/**
 * The HTTP client's error hook. A POST or PATCH answered with any 5xx may have taken effect: Microsandbox
 * documents none of its 5xx answers as a refusal made before anything happened, so they are
 * `outcome_unknown` and the adapter reconciles them.
 */
export function mapError(failure: HttpFailure, request: FailedRequest): ErrorCode | undefined {
  if (failure.kind !== "status") return undefined;
  const code = failure.body.code;

  if (writes.has(request.method) && failure.status >= 500) return "outcome_unknown";

  if (failure.status === 409) return "invalid_argument";

  if (code === "sandbox_not_running") return "unavailable";

  if (code === "quota_exceeded" || code === "service_quota_exceeded") return "quota";

  if (code === "sandbox_service_limit_exceeded") return "quota";

  return undefined;
}

/**
 * The `microsandbox` peer's error codes (`MicrosandboxError.code`) the adapter maps, grouped by what
 * the SDK reports. Any other code is `provider`.
 */
const peerCodes: ReadonlyMap<string, ErrorCode> = new Map<string, ErrorCode>([
  ["sandboxNotFound", "not_found"],
  ["sandboxReplaced", "not_found"],
  ["sandboxNotRunning", "unavailable"],
  ["execTimeout", "timeout"],
  ["invalidConfig", "invalid_argument"],
  ["unsupported", "unsupported"],
  ["unsupportedOperation", "unsupported"],
  ["cloudHttp", "unavailable"],
  ["http", "unavailable"],
]);

const missingFile = /no such file|not found|enoent|does not exist/i;

/** The message of a peer error, redacted and bounded, for `cause`. Never put in the message itself. */
function detail(cause: unknown, redact: (text: string) => string): string | undefined {
  if (!(cause instanceof Error)) return undefined;

  return scrub(redact(cause.message), 300);
}

/** The `microsandbox` peer's `MicrosandboxError.code`, read structurally (minifiers rename classes). */
export function peerCode(cause: unknown): string | undefined {
  return isObject(cause) && "code" in cause && isString(cause.code) ? cause.code : undefined;
}

/**
 * A SandboxError for a failure the `microsandbox` peer threw during `operation`. A filesystem error that
 * reads as a missing path is `file_not_found`; the peer's message stays in `cause`, redacted.
 */
export function peerError(
  cause: unknown,
  operation: string,
  options: { sandboxId?: string; redact: (text: string) => string; files?: boolean },
): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const code = peerCode(cause);
  const text = detail(cause, options.redact);
  let mapped: ErrorCode = code === undefined ? "provider" : (peerCodes.get(code) ?? "provider");

  if (options.files && (code === "sandboxFsOps" || code === "io") && missingFile.test(text ?? ""))
    mapped = "file_not_found";

  return fail(`${operation} failed${code ? ` (${code})` : ""}`, mapped, {
    sandboxId: options.sandboxId,
    retryable: mapped === "unavailable",
    cause: text,
  });
}

/** The fix for a peer that loaded but could not start its native addon, as `create` and the smoke checks name it. */
export const nativeHint =
  "Install microsandbox with optional dependencies enabled, so its platform package (@superradcompany/microsandbox-<platform>) is present, and Keep microsandbox external when bundling: it loads a native addon next to its own files.";
