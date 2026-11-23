import { SandboxError, type ErrorCode } from "../../errors.js";
import type { FailedRequest, HttpFailure } from "../../http.js";

export const provider = "styne";

/** An error this adapter writes itself. The message never holds text from Styne. */
export function fail(
  message: string,
  code: ErrorCode = "provider",
  options: { sandboxId?: string; retryable?: boolean; cause?: unknown } = {},
) {
  return new SandboxError(`Styne: ${message}`, { code, provider, ...options });
}

// Styne's `error_code` values (https://docs.styne.ai/errors), grouped by what the SDK reports.
const auth = new Set(["unauthenticated", "permission_denied", "account_suspended"]);

const quota = new Set([
  "no_credit_stopped",
  "plan_required",
  "payment_required",
  "guaranteed_needs_paid",
  "limit_hours",
  "quota_exceeded",
  "resident_limit",
  "storage_limit",
  "limit_concurrent",
  "limit_rate_minute",
  "limit_rate_hour",
  "limit_rate_day",
  "capacity_provisioning",
  "account_throttled",
]);

/** A sandbox that ended: killed, timed out, its node lost, or its guest agent gone. */
export const ended = new Set(["sandbox_ended", "sandbox_timeout", "node_loss", "agent_exit"]);

/**
 * 5xx answers Styne documents as refusals made before any effect ("a refused create holds nothing"):
 * no node had room, the region or the sandbox's node could not take it. Any other 5xx on a write may
 * have taken effect.
 */
const refusals = new Set([
  "capacity",
  "region_unavailable",
  "guaranteed_capacity",
  "upstream_unavailable",
  "resource_exhausted",
]);

const writes = new Set(["POST", "PATCH"]);

/** The SDK's code for one of Styne's `error_code` values, or undefined to keep the status mapping. */
export function codeOf(errorCode: string | undefined): ErrorCode | undefined {
  if (errorCode === undefined) return undefined;

  if (auth.has(errorCode)) return "auth";

  if (quota.has(errorCode)) return "quota";

  if (ended.has(errorCode) || errorCode === "not_found") return "not_found";

  if (refusals.has(errorCode)) return "unavailable";

  if (errorCode === "not_implemented" || errorCode === "class_not_served") return "unsupported";

  if (errorCode === "invalid_argument" || errorCode === "unknown_region") return "invalid_argument";

  if (errorCode === "deadline_exceeded" || errorCode === "command_timeout") return "timeout";

  return undefined;
}

/**
 * The HTTP client's error hook. A file route's 404 is a missing path; the adapter checks the sandbox
 * itself before it reports one. A write answered with a 5xx Styne does not document as a refusal may
 * have taken effect, so it is `outcome_unknown`.
 */
export function mapError(failure: HttpFailure, request: FailedRequest): ErrorCode | undefined {
  if (failure.kind !== "status") return undefined;
  const code = failure.body.code;

  if (
    writes.has(request.method) &&
    failure.status >= 500 &&
    (code === undefined || !refusals.has(code))
  )
    return "outcome_unknown";

  if (failure.status === 404 && /\/files(?:\/list)?$/.test(request.operation))
    return "file_not_found";

  return codeOf(code);
}
