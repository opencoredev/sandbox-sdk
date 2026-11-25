import { SandboxError, type ErrorCode } from "../../errors.js";
import type { FailedRequest, HttpFailure } from "../../http.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isString } from "../../shared/narrow.js";

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

const unsupported = new Set(["not_implemented", "not_supported", "class_not_served"]);

const safeCode = /^[a-z][a-z0-9_]{0,63}$/;
const plainId = /^[\w.-]{1,128}$/;

/** The fields by which a Styne error body names the resource it answers for. */
const nameKeys = ["sandboxID", "name", "snapshotID", "id"] as const;

type NameKey = (typeof nameKeys)[number];

/**
 * A failed answer as Styne's own error body says it: the exact `error_code`, never the shared parser's
 * `code` guess, and each resource the body names (`null` for a name that is not a plain ID).
 */
export interface StyneAnswer {
  status: number;
  errorCode: string | undefined;
  names: Partial<Record<NameKey, string | null>>;
}

export function answerOf(status: number, json: JsonValue | undefined): StyneAnswer {
  const body = isJsonObject(json) ? json : {};
  const code = body.error_code;
  const names: StyneAnswer["names"] = {};

  for (const key of nameKeys) {
    const value = body[key];

    if (value !== undefined) names[key] = isString(value) && plainId.test(value) ? value : null;
  }

  return { status, errorCode: isString(code) && safeCode.test(code) ? code : undefined, names };
}

/** What a request was about: its sandbox, and for a snapshot call the snapshot's name, its ID. */
export interface StyneTarget {
  sandboxId?: string;
  snapshot?: string;
}

/**
 * Whether Styne said `target` is gone: `404 not_found`, or for a sandbox (never a snapshot or a request
 * about no sandbox) a 410 with an ended code, from a body that names no other resource. A route-level,
 * undecodable or foreign 404 or 410 says nothing.
 */
export function isGoneAnswer(answer: StyneAnswer, target: StyneTarget): boolean {
  const expected: Record<NameKey, string | undefined> = {
    sandboxID: target.sandboxId,
    name: target.snapshot,
    snapshotID: target.snapshot,
    id: target.snapshot ?? target.sandboxId,
  };

  if (
    !nameKeys.every((key) => answer.names[key] === undefined || answer.names[key] === expected[key])
  )
    return false;

  if (answer.status === 404) return answer.errorCode === "not_found";

  return (
    answer.status === 410 &&
    target.sandboxId !== undefined &&
    target.snapshot === undefined &&
    answer.errorCode !== undefined &&
    ended.has(answer.errorCode)
  );
}

const requestId = /^[\w.:-]{1,128}$/;

/**
 * A failed request's cause: the status and Styne's own answer, so a caller can tell its target is gone
 * ({@link isGoneAnswer}), and the request ID. Holds only validated tokens, never body text.
 */
export class StyneFailure extends Error {
  constructor(
    readonly answer: StyneAnswer,
    request: string | undefined,
  ) {
    const code = answer.errorCode === undefined ? "" : ` ${answer.errorCode}`;
    super(`HTTP ${answer.status}${code}${request === undefined ? "" : ` (request ${request})`}`);
    this.name = "StyneFailure";
  }
}

/** The HTTP client's cause hook: every failed answer keeps Styne's own reading of it. */
export function causeOf(failure: HttpFailure): Error | undefined {
  if (failure.kind !== "status") return undefined;
  const id = failure.headers.get("x-request-id") ?? undefined;

  return new StyneFailure(
    answerOf(failure.status, failure.body.json),
    id !== undefined && requestId.test(id) ? id : undefined,
  );
}

/** The SDK's code for one of Styne's `error_code` values, or undefined to keep the status mapping. */
export function codeOf(errorCode: string | undefined): ErrorCode | undefined {
  if (errorCode === undefined) return undefined;

  if (auth.has(errorCode)) return "auth";

  if (quota.has(errorCode)) return "quota";

  if (ended.has(errorCode) || errorCode === "not_found") return "not_found";

  if (refusals.has(errorCode)) return "unavailable";

  if (unsupported.has(errorCode)) return "unsupported";

  if (errorCode === "invalid_argument" || errorCode === "unknown_region") return "invalid_argument";

  if (errorCode === "deadline_exceeded" || errorCode === "command_timeout") return "timeout";

  return undefined;
}

/**
 * The HTTP client's error hook, from Styne's own `error_code` only. A file route's 404 is a missing path;
 * the adapter checks the sandbox itself before it reports one. Any other 404 or 410 is `not_found` only
 * when Styne said so of this request's sandbox ({@link isGoneAnswer}); otherwise it is `provider`, never
 * absence. A `501` (`not_implemented`, or no code) is a route Styne does not serve, so nothing ran. A write
 * answered with any other 5xx Styne does not document as a refusal may have taken effect, so it is
 * `outcome_unknown`.
 */
export function mapError(failure: HttpFailure, request: FailedRequest): ErrorCode | undefined {
  if (failure.kind !== "status") return undefined;
  const answer = answerOf(failure.status, failure.body.json);
  const code = answer.errorCode;

  if (failure.status === 501 && (code === undefined || unsupported.has(code))) return "unsupported";

  if (
    writes.has(request.method) &&
    failure.status >= 500 &&
    (code === undefined || !refusals.has(code))
  )
    return "outcome_unknown";

  if (failure.status === 404 && /\/files(?:\/list)?$/.test(request.operation))
    return "file_not_found";

  if (failure.status === 404 || failure.status === 410) {
    if (isGoneAnswer(answer, { sandboxId: request.sandboxId })) return "not_found";
    const mapped = codeOf(code);

    return mapped === undefined || mapped === "not_found" ? "provider" : mapped;
  }

  return codeOf(code);
}
