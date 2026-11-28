import { SandboxError, type ErrorCode } from "../../errors.js";
import type { FailedRequest, HttpFailure } from "../../http.js";

export const provider = "agent37";

/** An error this adapter writes itself. The message never holds text from Agent 37. */
export function fail(
  message: string,
  code: ErrorCode = "provider",
  options: { sandboxId?: string; retryable?: boolean; cause?: unknown } = {},
) {
  return new SandboxError(`Agent 37: ${message}`, { code, provider, ...options });
}

// Agent 37's error codes (https://www.agent37.com/docs/agents-api/errors), grouped by what the SDK reports.
const auth = new Set(["invalid_api_key", "ip_not_allowed"]);

const quota = new Set([
  "insufficient_balance",
  "instance_limit_reached",
  "instance_suspended",
  "tier_limit",
  "rate_limited",
]);

const missing = new Set(["not_found"]);

const invalid = new Set(["invalid_request", "validation_error", "payload_too_large"]);

/**
 * Answers Agent 37 gives before anything took effect: no host had room, the instance is mid-transition
 * (a sleep checkpoint being written), or the platform could not reach the instance. Any other 5xx on a
 * write may have taken effect.
 */
export const refusals: ReadonlySet<string> = new Set([
  "no_capacity",
  "capacity_unavailable",
  "try_again",
  "container_unavailable",
  "container_unreachable",
  "upstream_unreachable",
  "host_mesh_not_ready",
  "instance_saturated",
  "wake_failed",
  "wake_timeout",
]);

/**
 * Every error code the adapter may show in a message. An error body's code is text from the network,
 * which can hold anything, so only these are shown.
 */
const documented: ReadonlySet<string> = new Set([
  ...auth,
  ...quota,
  ...missing,
  ...invalid,
  ...refusals,
  "provisioning_failed",
  "memory_not_saved",
  "public_port_exists",
  "internal_error",
  "forbidden",
]);

/** `code` when it is one of Agent 37's documented error codes, else undefined: safe to put in a message. */
export function shownCode(code: string | undefined): string | undefined {
  return code !== undefined && documented.has(code) ? code : undefined;
}

const writes = new Set(["POST", "PATCH"]);

/** The SDK's code for one of Agent 37's error codes, or undefined to keep the status mapping. */
export function codeOf(code: string | undefined): ErrorCode | undefined {
  if (code === undefined) return undefined;

  if (auth.has(code)) return "auth";

  if (quota.has(code)) return "quota";

  if (missing.has(code)) return "not_found";

  if (refusals.has(code)) return "unavailable";

  if (invalid.has(code)) return "invalid_argument";

  return undefined;
}

/**
 * The HTTP client's error hook. A write answered with a 5xx Agent 37 does not document as a refusal
 * (`provisioning_failed`, `internal_error`, or no code) may have taken effect, so it is `outcome_unknown`.
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

  return codeOf(code);
}
