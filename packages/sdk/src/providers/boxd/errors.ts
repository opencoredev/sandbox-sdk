import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";
import { isNumber, isObject } from "../../shared/narrow.js";

export function failure(
  message: string,
  code: ErrorCode = "provider",
  sandboxId?: string,
  cause?: string,
) {
  return new SandboxError(
    code === "auth"
      ? message
      : code === "file_not_found"
        ? `${message}. Check the path.`
        : `${message}. Check boxd configuration and retry.`,
    {
      code,
      provider: "boxd",
      sandboxId,
      cause,
    },
  );
}

const codes = new Map<number, ErrorCode>([
  [1, "aborted"],
  [3, "invalid_argument"],
  [4, "timeout"],
  [5, "not_found"],
  [6, "invalid_argument"],
  [9, "invalid_argument"],
  [7, "auth"],
  [8, "quota"],
  [12, "unsupported"],
  [14, "unavailable"],
  [16, "auth"],
]);

const names = new Map<string, ErrorCode>([
  ["AuthenticationError", "auth"],
  ["PermissionDeniedError", "auth"],
  ["NotFoundError", "not_found"],
  ["RateLimitError", "quota"],
  ["APIConnectionError", "unavailable"],
]);

export function boxdError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const status = isObject(cause) && "grpcCode" in cause ? cause.grpcCode : undefined;

  // A gRPC status means boxd answered, and its text can echo paths or the request.
  const describe = (code: ErrorCode, known?: boolean) =>
    describeNative(cause, {
      code,
      known,
      status: isNumber(status) ? `gRPC ${status}` : undefined,
      redact: redacting([process.env.BOXD_API_KEY]),
    });

  // 0.2.17's local machines.exec deadline is a plain BoxdError, without
  // grpcCode. Match its published message narrowly; never expose that message.
  if (
    cause instanceof Error &&
    cause.name === "BoxdError" &&
    /^exec timed out after \d+ms$/.test(cause.message)
  )
    return failure("boxd request timed out", "timeout", sandboxId, describe("timeout").cause);

  // gRPC NOT_FOUND covers both a missing VM ("VM not found") and a missing guest path
  // ("no such file on <machine>: <path>"). Only the latter is a file_not_found.
  if (cause instanceof Error && /\bno such file\b/i.test(cause.message))
    return failure(
      "File does not exist",
      "file_not_found",
      sandboxId,
      describe("file_not_found").cause,
    );

  const code = isNumber(status)
    ? (codes.get(status) ?? "provider")
    : cause instanceof Error
      ? (names.get(cause.name) ?? "provider")
      : "provider";

  // A recognized failure names only an allowlisted category, never native text or paths.
  const permissionDenied = cause instanceof Error && /permission denied/i.test(cause.message);
  const native = describe(code, permissionDenied || undefined);

  return failure(
    permissionDenied
      ? "boxd guest filesystem permission denied"
      : `boxd request failed: ${reason(code, native.detail)}`,
    code,
    sandboxId,
    native.cause,
  );
}
