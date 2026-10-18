import { SandboxError, type ErrorCode } from "../../errors.js";

export function tenkiError(error: unknown, sandboxId?: string): SandboxError {
  if (error instanceof SandboxError) return error;
  const name = error instanceof Error ? error.name : "";
  const codes: Record<string, ErrorCode> = {
    MissingAuthTokenError: "auth",
    InvalidAuthTokenError: "auth",
    UnauthorizedError: "auth",
    PermissionDeniedError: "auth",
    SessionNotFoundError: "not_found",
    SessionExpiredError: "not_found",
    SessionTerminatedError: "not_found",
    SnapshotNotFoundError: "not_found",
    FileNotFoundError: "file_not_found",
    QuotaExceededError: "quota",
    PortLimitExceededError: "quota",
    RateLimitedError: "quota",
    CapacityUnavailableError: "unavailable",
    SSHUnavailableError: "unavailable",
    DataPlaneNotReadyError: "unavailable",
    CommandTimeoutError: "timeout",
    SnapshotWaitTimeoutError: "timeout",
    PrimitiveTimeoutError: "timeout",
    InvalidResourceConfigError: "invalid_argument",
    InvalidStateError: "invalid_argument",
    InboundDisabledError: "unsupported",
    CapabilityUnavailableError: "unsupported",
  };
  const code = codes[name] ?? "provider";
  // Do not retain native messages/causes: they may include credentials or commands.
  return new SandboxError(
    `Tenki request failed (${code}). The provider could not complete the operation. Check credentials, quotas, and session state.`,
    {
      code,
      provider: "tenki",
      sandboxId,
      retryable: ["quota", "unavailable", "timeout"].includes(code),
    },
  );
}
export function failure(message: string, code: ErrorCode = "provider"): SandboxError {
  return new SandboxError(
    `${message}. Tenki could not honor the request. Check the provider options.`,
    { code, provider: "tenki" },
  );
}
