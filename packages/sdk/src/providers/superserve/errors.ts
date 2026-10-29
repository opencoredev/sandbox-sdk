import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";
import { decodeNative } from "../../shared/native-error.js";

export function failure(
  message: string,
  code: ErrorCode = "provider",
  sandboxId?: string,
  cause?: string,
) {
  return new SandboxError(
    code === "auth" ? message : `${message}. Check superserve configuration and retry.`,
    {
      code,
      provider: "superserve",
      sandboxId,
      cause,
    },
  );
}

const codes = new Map<number, ErrorCode>([
  [400, "invalid_argument"],
  [401, "auth"],
  [403, "auth"],
  [404, "not_found"],
  [408, "timeout"],
  [409, "unavailable"],
  [422, "invalid_argument"],
  [429, "quota"],
  [500, "unavailable"],
  [502, "unavailable"],
  [503, "unavailable"],
  [504, "timeout"],
]);

const names = new Map<string, ErrorCode>([
  ["AuthenticationError", "auth"],
  ["NotFoundError", "not_found"],
  ["ValidationError", "invalid_argument"],
  ["TimeoutError", "timeout"],
  ["AbortError", "aborted"],
  ["ConflictError", "unavailable"],
]);

export function superserveError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const native = decodeNative(cause);
  const status = native.statusCode;

  const code =
    status === undefined
      ? (names.get(native.name) ?? "provider")
      : (codes.get(status) ?? "provider");

  // Response text can echo the request; see describeNative for what is kept.
  const kept = describeNative(cause, {
    code,
    status: status === undefined ? undefined : `HTTP ${status}`,
    redact: redacting([process.env.SUPERSERVE_API_KEY]),
  });

  return failure(
    `Superserve request failed: ${reason(code, kept.detail)}`,
    code,
    sandboxId,
    kept.cause,
  );
}
