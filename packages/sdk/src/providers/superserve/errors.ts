import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

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

export function superserveError(error: unknown, sandboxId?: string): SandboxError {
  if (error instanceof SandboxError) return error;

  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? error.statusCode
      : undefined;

  const codes: Record<number, ErrorCode> = {
    400: "invalid_argument",
    401: "auth",
    403: "auth",
    404: "not_found",
    408: "timeout",
    409: "unavailable",
    422: "invalid_argument",
    429: "quota",
    500: "unavailable",
    502: "unavailable",
    503: "unavailable",
    504: "timeout",
  };

  const names: Record<string, ErrorCode> = {
    AuthenticationError: "auth",
    NotFoundError: "not_found",
    ValidationError: "invalid_argument",
    TimeoutError: "timeout",
    AbortError: "aborted",
    ConflictError: "unavailable",
  };

  const code =
    typeof status === "number"
      ? (codes[status] ?? "provider")
      : error instanceof Error
        ? (names[error.name] ?? "provider")
        : "provider";

  // Response text can echo the request; see describeNative for what is kept.
  const native = describeNative(error, {
    code,
    status: status === undefined ? undefined : `HTTP ${String(status)}`,
    redact: redacting([process.env.SUPERSERVE_API_KEY]),
  });

  return failure(
    `Superserve request failed: ${reason(code, native.detail)}`,
    code,
    sandboxId,
    native.cause,
  );
}
