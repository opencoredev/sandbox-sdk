import { SandboxError, describeNative, reason, statusCode, type ErrorCode } from "../../errors.js";
import { isNumber, isObject } from "../../shared/narrow.js";

// An outcome_unknown failure's message already says what to check before repeating it.
const plain = new Set<ErrorCode>(["auth", "file_not_found", "outcome_unknown"]);

export function failure(message: string, code: ErrorCode = "provider", sandboxId?: string) {
  return new SandboxError(plain.has(code) ? message : `${message}. Check Beam and retry.`, {
    code,
    provider: "beam",
    sandboxId,
  });
}

/**
 * A Beam gateway answer that said `ok: false`, or an HTTP failure. Keeps no response text.
 * `unknown`: a write whose answer was lost and may have taken effect. `too_large`: a download over
 * the gateway's message cap.
 */
export class BeamGatewayError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly kind: "http" | "refused" | "missing" | "malformed" | "unknown" | "too_large",
  ) {
    super(status === undefined ? `Beam gateway ${kind}` : `Beam gateway HTTP ${status}`);
    this.name = "BeamGatewayError";
  }
}

/** The HTTP status of a gateway error, or of an axios error from `@beamcloud/beam-js`. */
function httpStatus(cause: unknown): number | undefined {
  if (cause instanceof BeamGatewayError) return cause.status;

  if (!isObject(cause) || !("response" in cause) || !isObject(cause.response)) return undefined;

  return "status" in cause.response && isNumber(cause.response.status)
    ? cause.response.status
    : undefined;
}

/** A Beam failure as a SandboxError, keeping only the error's name and HTTP status. */
export function beamError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const status = httpStatus(cause);
  const name = cause instanceof Error ? cause.name : undefined;

  const kind = cause instanceof BeamGatewayError ? cause.kind : undefined;

  const code: ErrorCode =
    kind === "missing"
      ? "not_found"
      : kind === "unknown"
        ? "outcome_unknown"
        : kind === "too_large"
          ? "quota"
          : status !== undefined
            ? statusCode(status)
            : name === "AbortError" || name === "CanceledError"
              ? "aborted"
              : name === "TimeoutError"
                ? "timeout"
                : cause instanceof TypeError
                  ? "unavailable"
                  : "provider";

  // Beam's error messages can echo paths and commands, so only the name and status survive.
  const kept = describeNative(cause, {
    code,
    known: true,
    status: status === undefined ? undefined : `HTTP ${status}`,
  });

  const next =
    code === "outcome_unknown"
      ? "It may or may not have taken effect; check the sandbox's state before repeating it."
      : "Check Beam and retry.";

  return new SandboxError(`Beam request failed: ${reason(code, kept.detail)}. ${next}`, {
    code,
    provider: "beam",
    sandboxId,
    cause: kept.cause,
  });
}

/**
 * Whether a failed allocation may still have allocated: no validated answer came back. A refusal
 * (an HTTP 4xx, or Beam's `ok:false`) made nothing; a network failure, a timeout, a 5xx or an
 * answer that could not be read leaves it unknown.
 */
export function maybeSent(cause: unknown) {
  if (
    cause instanceof Error &&
    ["AbortError", "TimeoutError", "CanceledError", "SyntaxError"].includes(cause.name)
  )
    return true;

  if (cause instanceof TypeError) return true;

  // The shared client's verdict on a restore it sent and lost.
  if (cause instanceof SandboxError) return cause.code === "outcome_unknown";

  // An answer that did not say ok:false and named no container, or that could not be read.
  if (cause instanceof BeamGatewayError && cause.kind === "unknown") return true;

  // beam-js's message when the allocation answer had no `ok` it could read (a body it could not
  // parse arrives as text). Beam's refusals carry their own errorMsg; one that came with an empty
  // errorMsg throws the same message and is reported as unknown too. beam-js keeps the answer to
  // itself, so the two can't be told apart here, and unknown is the side that never loses a sandbox.
  if (cause instanceof Error && cause.message === "Failed to create sandbox") return true;

  const status = httpStatus(cause);

  if (status !== undefined) return status >= 500;

  // An axios error without a response: the request may have arrived.
  return isObject(cause) && "isAxiosError" in cause;
}

/** The token and base URL of beam-js's cached HTTP client, when it has made one. */
export function cachedAuthorization(
  cause: unknown,
): { authorization: unknown; baseURL: unknown } | undefined {
  if (!isObject(cause) || !("_client" in cause)) return undefined;
  const axios = cause._client;

  // An axios instance is a function with properties, so objects and functions both count.
  if (!isObject(axios) && !(axios instanceof Function)) return undefined;

  if (!("defaults" in axios) || !isObject(axios.defaults))
    return { authorization: undefined, baseURL: undefined };
  const defaults = axios.defaults;

  const headers = "headers" in defaults && isObject(defaults.headers) ? defaults.headers : {};

  return {
    authorization: "Authorization" in headers ? headers.Authorization : undefined,
    baseURL: "baseURL" in defaults ? defaults.baseURL : undefined,
  };
}
