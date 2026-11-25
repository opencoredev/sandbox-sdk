import { SandboxError, type ErrorCode } from "../../errors.js";
import type { FailedRequest, HttpFailure } from "../../http.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isString } from "../../shared/narrow.js";

export const provider = "buddy";

/** An error this adapter writes itself. The message never holds text from Buddy. */
export function fail(
  message: string,
  code: ErrorCode = "provider",
  options: { sandboxId?: string; retryable?: boolean; cause?: unknown } = {},
) {
  return new SandboxError(`Buddy: ${message}`, { code, provider, ...options });
}

/**
 * What a Buddy error answer says, read from the first `errors[].message`. Buddy has no error codes, so the
 * adapter matches the exact messages it relies on (checked live on 2026-11-24) and nothing else.
 */
export type FaultReason =
  /** `400 'identifier' must be unique`: another sandbox in the workspace holds the identifier. */
  | "identifier_taken"
  /** `404 File not found` from a download. */
  | "file_not_found"
  /** `404 Sandbox not found`. */
  | "sandbox_not_found"
  /** `404 Resource not found`: an unknown sandbox, execution or snapshot. */
  | "resource_not_found"
  /** `Sandbox must be running`: a stopped sandbox refused a command or transfer. */
  | "not_running"
  /** `409` from `POST /execs`: refused before anything ran. */
  | "busy"
  /** Any other answer. */
  | "other";

/** The `cause` the HTTP client puts on a Buddy failure: the reason only, never Buddy's own text. */
export class BuddyFault extends Error {
  readonly reason: FaultReason;
  readonly status: number;

  constructor(reason: FaultReason, status: number) {
    super(`HTTP ${status} (${reason})`);
    this.name = "BuddyFault";
    this.reason = reason;
    this.status = status;
  }
}

/** Whether a client error is Buddy's answer for `reason`. */
export function isFault(cause: unknown, reason: FaultReason): cause is SandboxError {
  return (
    cause instanceof SandboxError &&
    cause.cause instanceof BuddyFault &&
    cause.cause.reason === reason
  );
}

/** The first `errors[].message` of a Buddy error body. */
export function messageOf(json: JsonValue | undefined): string | undefined {
  if (!isJsonObject(json)) return undefined;
  const errors = json.errors;

  if (!Array.isArray(errors)) return undefined;
  const [first] = errors;

  return isJsonObject(first) && isString(first.message) ? first.message : undefined;
}

function reasonOf(status: number, message: string | undefined, operation: string): FaultReason {
  if (status === 409 && operation.endsWith("/execs")) return "busy";

  switch (message) {
    case "'identifier' must be unique":
      return "identifier_taken";
    case "File not found":
      return "file_not_found";
    case "Sandbox not found":
      return "sandbox_not_found";
    case "Resource not found":
      return "resource_not_found";
    case "Sandbox must be running":
      return "not_running";
    default:
      return "other";
  }
}

/** The HTTP client's `cause` hook: a {@link BuddyFault} for every non-2xx answer. */
export function causeOf(failure: HttpFailure, request: FailedRequest): Error | undefined {
  if (failure.kind !== "status") return undefined;

  return new BuddyFault(
    reasonOf(failure.status, messageOf(failure.body.json), request.operation),
    failure.status,
  );
}

const writes = new Set(["POST", "PATCH"]);

/**
 * The HTTP client's error hook. A write answered with a 5xx may have taken effect, so it is
 * `outcome_unknown`. A download's 404 is `file_not_found` only when Buddy says `File not found`, and
 * `not_found` only when it says the sandbox is gone: any other 404 there is `provider`, never taken as
 * proof that the file is absent.
 */
export function mapError(failure: HttpFailure, request: FailedRequest): ErrorCode | undefined {
  if (failure.kind !== "status") return undefined;
  const reason = reasonOf(failure.status, messageOf(failure.body.json), request.operation);

  if (writes.has(request.method) && failure.status >= 500) return "outcome_unknown";

  // A download's 404 proves only what its message names. `Resource not found` there is not taken as
  // proof that the sandbox is gone, nor that the file is absent.
  if (failure.status === 404 && request.operation.includes("/download/"))
    return reason === "file_not_found"
      ? "file_not_found"
      : reason === "sandbox_not_found"
        ? "not_found"
        : "provider";

  switch (reason) {
    case "busy":
      return "unavailable";
    case "file_not_found":
      return "file_not_found";
    case "sandbox_not_found":
    case "resource_not_found":
      return "not_found";
    case "not_running":
      return "unavailable";
    case "identifier_taken":
      return "invalid_argument";
    case "other":
      return undefined;
    default: {
      const exhaustive: never = reason;

      return exhaustive;
    }
  }
}

/**
 * Credential shapes redacted from every error whether or not the adapter saw them: Buddy's encrypted
 * values (`!encrypted <ciphertext>`) and HTTP Basic credentials.
 */
export const leakPatterns: readonly RegExp[] = [
  /!encrypted [^\s"'<>]+/g,
  /\bBasic [A-Za-z0-9+/]{8,}={0,2}/g,
];
