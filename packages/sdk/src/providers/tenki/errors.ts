import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

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

// Native mapError wraps ConnectError in cause. Keep only bounded diagnostic
// scalars, never messages, bodies, URLs, headers or arbitrary native objects.
function nativeEvidence(error: unknown, denied: string[]) {
  const evidence: {
    status?: number;
    providerCode?: number | string;
    requestId?: string;
    nativeName?: string;
  } = {};

  const visited = new Set<unknown>();

  for (
    let depth = 0;
    depth < 4 && error && typeof error === "object" && !visited.has(error);
    depth++
  ) {
    visited.add(error);

    if (
      error instanceof Error &&
      (Object.hasOwn(codes, error.name) ||
        [
          "ResumeFailedError",
          "PauseFailedError",
          "WaitReadyFailedError",
          "StreamClosedError",
        ].includes(error.name))
    )
      evidence.nativeName ??= error.name;

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

// An unrecognized failure with no status or RPC code never got a Tenki response (an SDK
// bug, a network error), so its scrubbed message is kept. A response's text never is.
function localDetail(
  error: unknown,
  code: ErrorCode,
  evidence: ReturnType<typeof nativeEvidence>,
  denied: string[],
): { native?: string } {
  const status = evidence.status ?? evidence.providerCode;

  // An allowlisted native name is a recognized Tenki failure, whose text can carry the server response.
  const { detail } = describeNative(error, {
    code,
    known: evidence.nativeName === undefined ? undefined : true,
    status: status === undefined ? undefined : String(status),
    redact: redacting(denied),
  });

  return detail === undefined ? {} : { native: detail };
}

export function tenkiError(
  error: unknown,
  sandboxId?: string,
  operation: TenkiOperation = "request",
  secrets: string[] = [],
): SandboxError {
  if (error instanceof SandboxError) return error;
  const name = error instanceof Error ? error.name : "";
  const knownName = Object.hasOwn(codes, name);
  const code = knownName ? (codes[name] ?? "provider") : "provider";

  const denied = [
    ...secrets,
    process.env.TENKI_API_KEY ?? "",
    process.env.TENKI_AUTH_TOKEN ?? "",
  ].filter(Boolean);

  const native = nativeEvidence(error, denied);

  const evidence = {
    operation,
    ...native,
    ...localDetail(error, code, native, denied),
  };

  // Core preserves Error.message when redacting a cause; JSON survives that
  // boundary as well as exposing structured fields to direct adapter callers.
  const cause = Object.assign(new Error(JSON.stringify(evidence)), evidence);

  return new SandboxError(
    `Tenki request failed: ${reason(code, evidence.native)}. Check credentials, quotas, and session state.`,
    {
      code,
      provider: "tenki",
      sandboxId,
      cause,
      retryable: ["quota", "unavailable", "timeout"].includes(code),
    },
  );
}

export type CreateStage = "waitReady" | "validate" | "prepare";

// Only called after this invocation's CreateSession returned the session ID.
export function createError(
  error: unknown,
  context: { id: string; state: string; stage: CreateStage },
  secrets: string[],
  cleanupError?: unknown,
): SandboxError {
  const mapped = tenkiError(error, context.id, "create", secrets);

  const denied = [
    ...secrets,
    process.env.TENKI_API_KEY ?? "",
    process.env.TENKI_AUTH_TOKEN ?? "",
  ].filter(Boolean);

  const evidence = {
    operation: "create",
    admittedByThisCall: true,
    stage: context.stage,
    ...(/^[0-9a-f-]{36}$/i.test(context.id) && !denied.some((secret) => context.id.includes(secret))
      ? { sandboxId: context.id }
      : {}),
    ...(/^[A-Z_]{1,32}$/.test(context.state) ? { state: context.state } : {}),
    ...nativeEvidence(error, denied),
    ...localDetail(error, mapped.code, nativeEvidence(error, denied), denied),
    ...(cleanupError !== undefined ? { cleanupCode: tenkiError(cleanupError).code } : {}),
  };

  return new SandboxError(mapped.message, {
    code: mapped.code,
    provider: "tenki",
    sandboxId: context.id,
    retryable: mapped.retryable,
    hint: mapped.hint,
    cause: Object.assign(new Error(JSON.stringify(evidence)), evidence),
  });
}

export function failure(message: string, code: ErrorCode = "provider"): SandboxError {
  return new SandboxError(
    code === "auth"
      ? message
      : `${message}. Tenki could not honor the request. Check the provider options.`,
    { code, provider: "tenki" },
  );
}
