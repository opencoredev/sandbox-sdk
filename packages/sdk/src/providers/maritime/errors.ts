import { SandboxError, type ErrorCode } from "../../errors.js";
import type { FailedRequest, HttpFailure } from "../../http.js";

export const provider = "maritime";

/** An error this adapter writes itself. The message never holds text from Maritime. */
export function fail(
  message: string,
  code: ErrorCode = "provider",
  options: { sandboxId?: string; retryable?: boolean; cause?: unknown } = {},
) {
  return new SandboxError(`Maritime: ${message}`, { code, provider, ...options });
}

// Maritime's error `code` values (maritime-sdk 0.13.0 SANDBOX_ERROR_CODES, https://maritime.sh/docs/limits),
// grouped by what the SDK reports.
const auth = new Set([
  "unauthenticated",
  "scope_missing",
  "account_suspended",
  "email_not_verified",
]);

const quota = new Set([
  "plan_required",
  "payment_required",
  "trial_required",
  "trial_cap_reached",
  "trial_size_limit",
  "rate_limited",
  "concurrency_limit",
  "concurrency",
  "awake_limit_reached",
  "seat_limit",
]);

const missing = new Set([
  "sandbox_not_found",
  "snapshot_not_found",
  "resource_not_found",
  "sandbox_ended",
]);

const invalid = new Set([
  "invalid_request",
  "invalid_size",
  "size_too_small",
  "screen_not_available",
]);

const unsupported = new Set(["not_supported", "promote_unavailable", "machine_unavailable"]);

/**
 * Answers Maritime gives before anything took effect: no host had room, or the sandbox is still
 * starting. Any other 5xx on a write may have taken effect.
 */
export const refusals: ReadonlySet<string> = new Set([
  "no_ready_machine",
  "out_of_capacity",
  "capacity_unavailable",
  "sandbox_starting",
]);

/**
 * Every error code the adapter may show in a message. A `code` from an SSE `error` event or an error body
 * is text from the network, which can hold anything, a credential included, so only these are shown.
 */
const documented: ReadonlySet<string> = new Set([
  ...auth,
  ...quota,
  ...missing,
  ...invalid,
  ...unsupported,
  ...refusals,
  "file_not_found",
  "command_timeout",
  "internal_error",
  "invalid_state",
  "sandbox_paused",
  "pause_failed",
  "create_failed",
  "snapshot_exists",
]);

/** `code` when it is one of Maritime's documented error codes, else undefined: safe to put in a message. */
export function shownCode(code: string | undefined): string | undefined {
  return code !== undefined && documented.has(code) ? code : undefined;
}

const writes = new Set(["POST", "PATCH"]);

/** The SDK's code for one of Maritime's error codes, or undefined to keep the status mapping. */
export function codeOf(code: string | undefined): ErrorCode | undefined {
  if (code === undefined) return undefined;

  if (auth.has(code)) return "auth";

  if (quota.has(code)) return "quota";

  if (missing.has(code)) return "not_found";

  if (code === "file_not_found") return "file_not_found";

  if (refusals.has(code)) return "unavailable";

  if (unsupported.has(code)) return "unsupported";

  if (invalid.has(code)) return "invalid_argument";

  if (code === "command_timeout") return "timeout";

  return undefined;
}

/**
 * The HTTP client's error hook. A write answered with a 5xx Maritime does not document as a refusal
 * (`internal_error`, `pause_failed`, or no code) may have taken effect, so it is `outcome_unknown`.
 */
export function mapError(failure: HttpFailure, request: FailedRequest): ErrorCode | undefined {
  if (failure.kind !== "status") return undefined;
  const code = failure.body.code;

  if (failure.status === 501 && (code === undefined || unsupported.has(code))) return "unsupported";

  if (
    writes.has(request.method) &&
    failure.status >= 500 &&
    (code === undefined || !refusals.has(code))
  )
    return "outcome_unknown";

  return codeOf(code);
}
