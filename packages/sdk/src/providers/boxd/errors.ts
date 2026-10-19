import { SandboxError, type ErrorCode } from "../../errors.js";
export function failure(message: string, code: ErrorCode = "provider", sandboxId?: string) {
  return new SandboxError(`${message}. Check boxd configuration and retry.`, {
    code,
    provider: "boxd",
    sandboxId,
  });
}
export function boxdError(error: unknown, sandboxId?: string): SandboxError {
  if (error instanceof SandboxError) return error;
  const status =
    typeof error === "object" && error !== null && "grpcCode" in error ? error.grpcCode : undefined;
  const codes: Record<number, ErrorCode> = {
    1: "aborted",
    3: "invalid_argument",
    4: "timeout",
    5: "not_found",
    6: "invalid_argument",
    9: "invalid_argument",
    7: "auth",
    8: "quota",
    12: "unsupported",
    14: "unavailable",
    16: "auth",
  };
  const names: Record<string, ErrorCode> = {
    AuthenticationError: "auth",
    PermissionDeniedError: "auth",
    NotFoundError: "not_found",
    RateLimitError: "quota",
    APIConnectionError: "unavailable",
  };
  return failure(
    "boxd request failed",
    typeof status === "number"
      ? (codes[status] ?? "provider")
      : error instanceof Error
        ? (names[error.name] ?? "provider")
        : "provider",
    sandboxId,
  );
}
