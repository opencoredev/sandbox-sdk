import { SandboxError, describeNative, reason, statusCode, type ErrorCode } from "../../errors.js";
import { isNumber, isObject } from "../../shared/narrow.js";

export function failure(message: string, code: ErrorCode = "provider", sandboxId?: string) {
  return new SandboxError(
    code === "auth" || code === "file_not_found" ? message : `${message}. Check Beam and retry.`,
    { code, provider: "beam", sandboxId },
  );
}

/** A Beam gateway answer that said `ok: false`, or an HTTP failure. Keeps no response text. */
export class BeamGatewayError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly kind: "http" | "refused" | "missing",
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

  const code: ErrorCode =
    cause instanceof BeamGatewayError && cause.kind === "missing"
      ? "not_found"
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

  return new SandboxError(
    `Beam request failed: ${reason(code, kept.detail)}. Check Beam and retry.`,
    { code, provider: "beam", sandboxId, cause: kept.cause },
  );
}
