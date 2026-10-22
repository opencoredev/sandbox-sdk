import { SandboxError, type ErrorCode } from "../../errors.js";

export type TenkiOperation =
  | "request"
  | "create"
  | "list"
  | "connect"
  | "destroy"
  | "exec"
  | "files"
  | "preview"
  | "pause"
  | "resume"
  | "snapshot";

// Native mapError wraps ConnectError in cause. Keep only bounded diagnostic
// scalars, never messages, bodies, URLs, headers or arbitrary native objects.
function nativeEvidence(error: unknown, denied: string[]) {
  const evidence: { status?: number; providerCode?: number | string; requestId?: string } = {};
  const visited = new Set<unknown>();
  for (
    let depth = 0;
    depth < 4 && error && typeof error === "object" && !visited.has(error);
    depth++
  ) {
    visited.add(error);
    const status =
      "status" in error ? error.status : "statusCode" in error ? error.statusCode : undefined;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
      evidence.status ??= status;
    const code = "code" in error ? error.code : undefined;
    if (
      (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 16) ||
      (typeof code === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(code) &&
        !denied.some((secret) => code.includes(secret)))
    )
      evidence.providerCode ??= code;
    const metadata = "metadata" in error ? error.metadata : undefined;
    const requestId =
      "requestId" in error
        ? error.requestId
        : metadata instanceof Headers
          ? (metadata.get("x-request-id") ?? metadata.get("request-id"))
          : undefined;
    if (
      typeof requestId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(requestId) &&
      !denied.some((secret) => requestId.includes(secret))
    )
      evidence.requestId ??= requestId;
    error = "cause" in error ? error.cause : undefined;
  }
  return evidence;
}

export function tenkiError(
  error: unknown,
  sandboxId?: string,
  operation: TenkiOperation = "request",
  secrets: string[] = [],
): SandboxError {
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
  const knownName = Object.hasOwn(codes, name);
  const code = knownName ? (codes[name] ?? "provider") : "provider";
  const denied = [
    ...secrets,
    process.env.TENKI_API_KEY ?? "",
    process.env.TENKI_AUTH_TOKEN ?? "",
  ].filter(Boolean);
  const evidence = {
    operation,
    ...(knownName ||
    ["ResumeFailedError", "PauseFailedError", "WaitReadyFailedError", "StreamClosedError"].includes(
      name,
    )
      ? { nativeName: name }
      : {}),
    ...nativeEvidence(error, denied),
  };
  // Core preserves Error.message when redacting a cause; JSON survives that
  // boundary as well as exposing structured fields to direct adapter callers.
  const cause = Object.assign(new Error(JSON.stringify(evidence)), evidence);
  return new SandboxError(
    `Tenki request failed (${code}). The provider could not complete the operation. Check credentials, quotas, and session state.`,
    {
      code,
      provider: "tenki",
      sandboxId,
      cause,
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
