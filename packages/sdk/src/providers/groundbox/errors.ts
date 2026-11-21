import {
  SandboxError,
  evidenceCause,
  reason,
  type ErrorCode,
  type NativeEvidence,
} from "../../errors.js";
import type { FailedRequest, HttpFailure } from "../../http.js";
import { httpStatus } from "../../http.js";

const provider = "groundbox";

interface FailOptions {
  sandboxId?: string | undefined;
  retryable?: boolean;
  cause?: unknown;
}

/** An error this adapter writes itself; the message never holds text from Groundbox. */
export function fail(message: string, code: ErrorCode = "provider", options: FailOptions = {}) {
  return new SandboxError(`Groundbox: ${message}`, { code, provider, ...options });
}

/** Groundbox's error codes (`{"error": {"code", "message", "request_id"}}`) as SDK codes. */
export function errorCode(code: string | undefined): ErrorCode | undefined {
  switch (code) {
    case "unauthorized":
    case "key_pending_claim":
    case "forbidden":
    case "missing_scope":
    case "team_suspended":
      return "auth";
    case "insufficient_balance":
    case "spend_cap_reached":
    case "paid_plan_required":
    case "trial_limit":
    case "trial_credit_exhausted":
    case "concurrency_limit":
    case "team_held":
    case "no_capacity":
    case "rate_limited":
      return "quota";
    case "not_available":
      return "unsupported";
    case "busy":
      return "unavailable";
    case "timeout":
      return "timeout";
    case "bad_request":
    case "idempotency_key_reused":
      return "invalid_argument";
    case "conflict":
    case "upgrade_required":
      return "provider";
    case "not_found":
      return "not_found";
    default:
      return undefined;
  }
}

/** File routes answer 404 for a missing path with a message that names the path, and for a missing sandbox with "No sandbox". */
const filePath = /\/files(?:\/stat|\/mkdir)?$/;

/**
 * The shared client's `mapError` hook: Groundbox's code first, then the status. A 404 on a file route
 * that is not about the sandbox is a missing file. The message is read to tell the two apart and never kept.
 */
export function mapFailure(failure: HttpFailure, request: FailedRequest): ErrorCode | undefined {
  if (failure.kind !== "status") return undefined;
  const code = errorCode(failure.body.code);

  if (
    code === "not_found" &&
    filePath.test(request.operation) &&
    !failure.body.message?.startsWith("No sandbox")
  )
    return "file_not_found";

  return code;
}

/** Whether a client error is Groundbox's answer with this HTTP status or error code. */
export function answered(error: SandboxError, match: { status?: number; code?: string }): boolean {
  const seen = httpStatus(error);

  if (!seen) return false;

  return (
    (match.status === undefined || seen.status === match.status) &&
    (match.code === undefined || seen.code === match.code)
  );
}

export type CreateStage = "start" | "prepare" | "read";

/**
 * A create that failed after this call's `POST /v1/sandboxes` admitted a sandbox. The evidence names
 * the sandbox, so the bench can recover it by its labels if the adapter's own delete (`cleanupCode`)
 * failed too.
 */
export function createError(
  cause: unknown,
  context: { sandboxId: string; stage: CreateStage; cleanupCode?: ErrorCode },
): SandboxError {
  const mapped =
    cause instanceof SandboxError
      ? cause
      : fail(`create failed: ${reason("provider")}`, "provider", { sandboxId: context.sandboxId });

  const seen = httpStatus(mapped);

  const kept: NativeEvidence = {
    operation: "create",
    admittedByThisCall: true,
    stage: context.stage,
  };

  if (seen) {
    kept.status = seen.status;

    if (seen.code) kept.providerCode = seen.code;
  }

  if (/^sbx_[A-Za-z0-9]{1,64}$/.test(context.sandboxId)) kept.sandboxId = context.sandboxId;

  if (context.cleanupCode !== undefined) kept.cleanupCode = context.cleanupCode;

  return new SandboxError(mapped.message, {
    code: mapped.code,
    provider,
    sandboxId: context.sandboxId,
    retryable: mapped.retryable,
    cause: evidenceCause(kept),
  });
}
