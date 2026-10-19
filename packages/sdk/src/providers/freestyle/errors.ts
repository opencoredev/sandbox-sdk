import { SandboxError, type ErrorCode } from "../../errors.js";
export function failure(message: string, code: ErrorCode = "provider", sandboxId?: string) {
  return new SandboxError(`${message}. Check Freestyle configuration and retry.`, {
    code,
    provider: "freestyle",
    sandboxId,
  });
}
export function freestyleError(error: unknown, sandboxId?: string): SandboxError {
  if (error instanceof SandboxError) return error;
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  const codes: Record<number, ErrorCode> = {
    400: "invalid_argument",
    401: "auth",
    403: "auth",
    404: "not_found",
    402: "quota",
    408: "timeout",
    429: "quota",
    500: "unavailable",
    502: "unavailable",
    503: "unavailable",
    504: "timeout",
  };
  return failure(
    "Freestyle request failed",
    typeof status === "number"
      ? (codes[status] ?? "provider")
      : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? error.name === "TimeoutError"
          ? "timeout"
          : "aborted"
        : error instanceof Error && error.name === "FreestyleTransportError"
          ? "unavailable"
          : "provider",
    sandboxId,
  );
}
