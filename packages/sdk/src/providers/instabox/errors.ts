import {
  SandboxError,
  describeNative,
  evidenceCause,
  reason,
  statusCode,
  type ErrorCode,
  type NativeEvidence,
} from "../../errors.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";

const provider = "instabox";

interface FailOptions {
  sandboxId?: string | undefined;
  retryable?: boolean;
  cause?: unknown;
}

/** An error this adapter writes itself; the message never holds text from Instabox. */
export function fail(message: string, code: ErrorCode = "provider", options: FailOptions = {}) {
  return new SandboxError(`Instabox: ${message}`, { code, provider, ...options });
}

/**
 * The machine-readable part of Instabox's error envelope (`{"error": {"code", "message",
 * "requestId", "retryable", "retryAfterSeconds"}}`). The message is never kept: it can echo
 * paths, commands or request bodies.
 */
export interface ApiErrorBody {
  code: string;
  retryable: boolean;
  retryAfterSeconds: number | undefined;
  requestId: string | undefined;
}

/** Instabox's codes are short snake_case words; anything else is not kept. */
const safeCode = /^[a-z][a-z0-9_]{0,47}$/;
const safeRequestId = /^[A-Za-z0-9_-]{1,64}$/;

export function parseErrorBody(raw: JsonValue | undefined): ApiErrorBody | undefined {
  const error = isJsonObject(raw) ? raw.error : undefined;

  if (!isJsonObject(error)) return undefined;
  const code = error.code;
  const retryAfter = error.retryAfterSeconds;
  const requestId = error.requestId;

  return {
    code: isString(code) && safeCode.test(code) ? code : "unknown",
    retryable: error.retryable === true,
    retryAfterSeconds: isNumber(retryAfter) ? retryAfter : undefined,
    requestId: isString(requestId) && safeRequestId.test(requestId) ? requestId : undefined,
  };
}

/** Instabox's error code first, then the HTTP status. */
export function errorCode(status: number, code: string): ErrorCode {
  switch (code) {
    case "missing_key":
    case "malformed_key":
    case "invalid_key":
    case "expired_key":
    case "revoked_key":
    case "missing_scope":
    case "permission_denied":
      return "auth";
    case "quota_exceeded":
    case "rate_limited":
    case "no_capacity":
      return "quota";
    case "spec_not_allowed":
    case "template_not_allowed":
      return "unsupported";
    case "host_unavailable":
      return "unavailable";
    case "not_found":
      return "not_found";
    default:
      return status === 0 ? "provider" : statusCode(status);
  }
}

/** A non-2xx answer from the API, kept as its status and allowlisted envelope fields. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(`Instabox HTTP ${status} ${body.code}`);
    this.name = "InstaboxApiFailure";
  }
}

function evidence(operation: string, failure: ApiFailure): NativeEvidence {
  const kept: NativeEvidence = { operation, status: failure.status };

  if (failure.body.code !== "unknown") kept.providerCode = failure.body.code;

  if (failure.body.requestId) kept.requestId = failure.body.requestId;

  return kept;
}

/** Any failure from a request as a SandboxError, keeping only Instabox's status and code. */
export function instaboxError(cause: unknown, operation: string, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;

  if (cause instanceof ApiFailure) {
    const code = errorCode(cause.status, cause.body.code);

    return new SandboxError(`Instabox ${operation} failed: ${reason(code)}`, {
      code,
      provider,
      sandboxId,
      retryable: cause.body.retryable || cause.status === 429,
      cause: evidenceCause(evidence(operation, cause)),
    });
  }

  // Only the error's name: a native message can quote a response body.
  const kept = describeNative(cause, { code: "provider", known: true });

  return new SandboxError(`Instabox ${operation} failed: ${reason("provider")}`, {
    code: "provider",
    provider,
    sandboxId,
    cause: kept.cause,
  });
}

/** A failed asynchronous operation: its code, never its message. */
export function operationError(input: {
  operationId: string;
  errorCode: string | undefined;
  sandboxId: string;
}): SandboxError {
  const providerCode =
    input.errorCode && safeCode.test(input.errorCode) ? input.errorCode : undefined;

  const code = errorCode(0, providerCode ?? "");
  const kept: NativeEvidence = { operation: "operation" };

  if (providerCode) kept.providerCode = providerCode;

  return new SandboxError(`Instabox operation ${input.operationId} failed: ${reason(code)}`, {
    code,
    provider,
    sandboxId: input.sandboxId,
    cause: evidenceCause(kept),
  });
}

export type CreateStage = "operation" | "prepare" | "read";

/** The allowlisted request fields an Instabox error's evidence already holds. */
function carried(cause: unknown): Pick<NativeEvidence, "status" | "providerCode" | "requestId"> {
  if (!(cause instanceof Error)) return {};
  const kept: Pick<NativeEvidence, "status" | "providerCode" | "requestId"> = {};

  if ("status" in cause && isNumber(cause.status)) kept.status = cause.status;

  if ("providerCode" in cause && isString(cause.providerCode) && safeCode.test(cause.providerCode))
    kept.providerCode = cause.providerCode;

  if ("requestId" in cause && isString(cause.requestId) && safeRequestId.test(cause.requestId))
    kept.requestId = cause.requestId;

  return kept;
}

/**
 * A create that failed after this call's POST /v1/machines admitted a machine. The evidence
 * names the machine, so the bench can recover it by its labels if the adapter's own delete
 * (`cleanupCode`) failed too.
 */
export function createError(
  cause: unknown,
  context: { sandboxId: string; stage: CreateStage; cleanupCode?: ErrorCode },
): SandboxError {
  const mapped = instaboxError(cause, "create", context.sandboxId);

  const kept: NativeEvidence = {
    operation: "create",
    admittedByThisCall: true,
    stage: context.stage,
    ...carried(mapped.cause),
  };

  if (/^m_[a-z0-9]{1,64}$/.test(context.sandboxId)) kept.sandboxId = context.sandboxId;

  if (context.cleanupCode !== undefined) kept.cleanupCode = context.cleanupCode;

  return new SandboxError(mapped.message, {
    code: mapped.code,
    provider,
    sandboxId: context.sandboxId,
    retryable: mapped.retryable,
    cause: evidenceCause(kept),
  });
}
