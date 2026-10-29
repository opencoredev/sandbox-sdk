import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";
import { isNumber, isObject, isString } from "../../shared/narrow.js";

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

const codes = new Map<string, ErrorCode>([
  ["MissingAuthTokenError", "auth"],
  ["InvalidAuthTokenError", "auth"],
  ["UnauthorizedError", "auth"],
  ["PermissionDeniedError", "auth"],
  ["SessionNotFoundError", "not_found"],
  ["SessionExpiredError", "not_found"],
  ["SessionTerminatedError", "not_found"],
  ["SnapshotNotFoundError", "not_found"],
  ["FileNotFoundError", "file_not_found"],
  ["QuotaExceededError", "quota"],
  ["PortLimitExceededError", "quota"],
  ["RateLimitedError", "quota"],
  ["CapacityUnavailableError", "unavailable"],
  ["SSHUnavailableError", "unavailable"],
  ["DataPlaneNotReadyError", "unavailable"],
  ["CommandTimeoutError", "timeout"],
  ["SnapshotWaitTimeoutError", "timeout"],
  ["PrimitiveTimeoutError", "timeout"],
  ["InvalidResourceConfigError", "invalid_argument"],
  ["InvalidStateError", "invalid_argument"],
  ["InboundDisabledError", "unsupported"],
  ["CapabilityUnavailableError", "unsupported"],
]);

/** Bounded diagnostic scalars copied from a native error chain. */
type NativeEvidence = {
  status?: number;
  providerCode?: number | string;
  requestId?: string;
  nativeName?: string;
};

// Native mapError wraps ConnectError in cause. Keep only bounded diagnostic
// scalars, never messages, bodies, URLs, headers or arbitrary native objects.
function nativeEvidence(cause: unknown, denied: string[]): NativeEvidence {
  const evidence: NativeEvidence = {};
  const visited = new Set<object>();
  let error = cause;

  for (let depth = 0; depth < 4 && isObject(error) && !visited.has(error); depth++) {
    visited.add(error);

    if (
      error instanceof Error &&
      (codes.has(error.name) ||
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

    if (isNumber(status) && Number.isInteger(status) && status >= 100 && status <= 599)
      evidence.status ??= status;
    const code = "code" in error ? error.code : undefined;

    if (
      (isNumber(code) && Number.isInteger(code) && code >= 0 && code <= 16) ||
      (isString(code) &&
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
      isString(requestId) &&
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
  cause: unknown,
  code: ErrorCode,
  evidence: NativeEvidence,
  denied: string[],
): { native?: string } {
  const status = evidence.status ?? evidence.providerCode;

  // An allowlisted native name is a recognized Tenki failure, whose text can carry the server response.
  const { detail } = describeNative(cause, {
    code,
    known: evidence.nativeName === undefined ? undefined : true,
    status: status === undefined ? undefined : String(status),
    redact: redacting(denied),
  });

  return detail === undefined ? {} : { native: detail };
}

export function tenkiError(
  cause: unknown,
  sandboxId?: string,
  operation: TenkiOperation = "request",
  secrets: string[] = [],
): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const name = cause instanceof Error ? cause.name : "";
  const code = codes.get(name) ?? "provider";

  const denied = [
    ...secrets,
    process.env.TENKI_API_KEY ?? "",
    process.env.TENKI_AUTH_TOKEN ?? "",
  ].filter(Boolean);

  const native = nativeEvidence(cause, denied);

  const evidence = {
    operation,
    ...native,
    ...localDetail(cause, code, native, denied),
  };

  // Core preserves Error.message when redacting a cause; JSON survives that
  // boundary as well as exposing structured fields to direct adapter callers.
  const details = Object.assign(new Error(JSON.stringify(evidence)), evidence);

  return new SandboxError(
    `Tenki request failed: ${reason(code, evidence.native)}. Check credentials, quotas, and session state.`,
    {
      code,
      provider: "tenki",
      sandboxId,
      cause: details,
      retryable: ["quota", "unavailable", "timeout"].includes(code),
    },
  );
}

export type CreateStage = "waitReady" | "validate" | "prepare";

/** What a failed create records about itself; ordered as it appears in the JSON message. */
type CreateEvidence = NativeEvidence & {
  operation: "create";
  admittedByThisCall: true;
  stage: CreateStage;
  sandboxId?: string;
  state?: string;
  native?: string;
  cleanupCode?: ErrorCode;
};

// Only called after this invocation's CreateSession returned the session ID.
export function createError(
  cause: unknown,
  context: { id: string; state: string; stage: CreateStage },
  secrets: string[],
  cleanupCode?: ErrorCode,
): SandboxError {
  const mapped = tenkiError(cause, context.id, "create", secrets);

  const denied = [
    ...secrets,
    process.env.TENKI_API_KEY ?? "",
    process.env.TENKI_AUTH_TOKEN ?? "",
  ].filter(Boolean);

  const evidence: CreateEvidence = {
    operation: "create",
    admittedByThisCall: true,
    stage: context.stage,
  };

  if (/^[0-9a-f-]{36}$/i.test(context.id) && !denied.some((secret) => context.id.includes(secret)))
    evidence.sandboxId = context.id;

  if (/^[A-Z_]{1,32}$/.test(context.state)) evidence.state = context.state;
  const native = nativeEvidence(cause, denied);
  Object.assign(evidence, native, localDetail(cause, mapped.code, native, denied));

  if (cleanupCode !== undefined) evidence.cleanupCode = cleanupCode;

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
