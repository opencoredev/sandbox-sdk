import { SandboxError, describeNative, reason, statusCode, type ErrorCode } from "../../errors.js";
import { isNumber, isObject } from "../../shared/narrow.js";

export function failure(message: string, code: ErrorCode = "provider", sandboxId?: string) {
  return new SandboxError(
    code === "auth" || code === "file_not_found" ? message : `${message}. Check Baseten and retry.`,
    { code, provider: "baseten", sandboxId },
  );
}

/** The HTTP status of a `SandboxApiError` (or `SandboxGatewayError`) from `@basetenlabs/sandbox`. */
export function nativeStatus(cause: unknown): number | undefined {
  if (!(cause instanceof Error) || !isObject(cause) || !("status" in cause)) return undefined;

  return isNumber(cause.status) ? cause.status : undefined;
}

/** A Baseten failure as a SandboxError, keeping only the error's name and HTTP status. */
export function basetenError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const status = nativeStatus(cause);
  const name = cause instanceof Error ? cause.name : undefined;

  const code: ErrorCode =
    status !== undefined
      ? statusCode(status)
      : name === "AbortError"
        ? "aborted"
        : name === "SandboxProcessWaitTimeoutError"
          ? "timeout"
          : cause instanceof TypeError
            ? "unavailable"
            : "provider";

  // Never keep native text: stream failures arrive as plain Errors carrying the response's
  // event data, and API errors can echo paths or requests. Only the name and status survive.
  const kept = describeNative(cause, {
    code,
    known: true,
    status: status === undefined ? undefined : `HTTP ${status}`,
  });

  return new SandboxError(
    `Baseten request failed: ${reason(code, kept.detail)}. Check Baseten and retry.`,
    { code, provider: "baseten", sandboxId, cause: kept.cause },
  );
}
