export const sandboxErrorCodes = [
  "authentication",
  "permission",
  "not_found",
  "timeout",
  "rate_limited",
  "unavailable",
  "unsupported",
  "invalid_input",
  "conflict",
  "terminated",
  "process_failed",
  "internal",
] as const;

export type SandboxErrorCode = (typeof sandboxErrorCodes)[number];

const sensitive =
  /((?:token|key|secret|authorization|credential|signature)=?)[^\s&,]+|https?:\/\/[^\s]+(?:token|sig|signature|key)=[^\s&]+/gi;

export function redactSensitive(value: string): string {
  return value.replace(sensitive, "$1[REDACTED]");
}

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly provider: string;
  readonly operation?: string;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(options: {
    code: SandboxErrorCode;
    provider: string;
    message: string;
    operation?: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(redactSensitive(options.message), { cause: options.cause });
    this.name = "SandboxError";
    this.code = options.code;
    this.provider = options.provider;
    this.operation = options.operation;
    this.retryable =
      options.retryable ?? ["rate_limited", "timeout", "unavailable"].includes(options.code);
    this.cause = options.cause;
  }

  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

export function isSandboxError(error: unknown): error is SandboxError {
  return error instanceof SandboxError;
}

export function normalizeError(
  provider: string,
  operation: string,
  error: unknown,
  fallback: SandboxErrorCode = "internal",
): SandboxError {
  if (isSandboxError(error)) return error;
  const message = error instanceof Error ? error.message : "Unknown provider error";
  const lower = `${error instanceof Error ? error.name : ""} ${message}`.toLowerCase();
  const status = errorStatus(error);
  const code =
    status === 401 || lower.includes("unauthorized") || lower.includes("api key")
      ? "authentication"
      : status === 403 || lower.includes("forbidden") || lower.includes("permission")
        ? "permission"
        : status === 404 || lower.includes("not found") || lower.includes("enoent")
          ? "not_found"
          : status === 408 || lower.includes("timeout") || lower.includes("timed out")
            ? "timeout"
            : status === 429 || lower.includes("rate limit") || lower.includes("429")
              ? "rate_limited"
              : status === 409 || lower.includes("already exists") || lower.includes("conflict")
                ? "conflict"
                : fallback;
  return new SandboxError({ code, provider, operation, message, cause: error });
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  if ("status" in error && typeof error.status === "number") return error.status;
  if (
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null &&
    "status" in error.response &&
    typeof error.response.status === "number"
  ) {
    return error.response.status;
  }
  return undefined;
}
