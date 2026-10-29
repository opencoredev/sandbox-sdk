import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

/** Railway messages can include tokens and output. Only an unrecognized failure without a
 * status keeps its scrubbed text, with the token redacted, as `cause` (see describeNative). */
export function railwayError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const name = cause instanceof Error ? cause.constructor.name : "";
  const status = typeof cause === "object" && cause !== null && "status" in cause ? cause.status : undefined;
  let code: ErrorCode = "provider";
  if (name === "RailwayAuthError" || status === 401 || status === 403) code = "auth";
  else if (name === "SandboxFileNotFoundError") code = "file_not_found";
  else if (name === "SandboxNotFoundError" || status === 404) code = "not_found";
  else if (name === "ExecControlUnsupportedError") code = "unsupported";
  else if (name === "ExecInterruptedError" || name === "RailwayConnectionError") code = "outcome_unknown";
  else if (status === 429 || status === 507) code = "quota";
  else if (name === "ExecNotStartedError" || (typeof status === "number" && status >= 500)) code = "unavailable";
  else if (name === "SandboxTimeoutError") code = "timeout";
  else if (name === "AbortError") code = "aborted";
  // fetch reports a network failure as TypeError("fetch failed"); the SDK's input validation also throws TypeError.
  else if (cause instanceof TypeError && cause.message === "fetch failed") code = "unavailable";
  else if (cause instanceof TypeError || status === 400) code = "invalid_argument";
  const hint = code === "auth" ? "Check RAILWAY_API_TOKEN and RAILWAY_ENVIRONMENT_ID." : "Check the sandbox and Railway service before retrying.";
  // A TypeError is the SDK's own input validation or an SDK bug, never server text, so it keeps its message.
  const native = describeNative(cause, { code, known: cause instanceof TypeError ? false : undefined, status: status === undefined ? undefined : `HTTP ${String(status)}`, redact: redacting([process.env.RAILWAY_API_TOKEN]) });
  return new SandboxError(`Railway request failed: ${reason(code, native.detail)}. ${hint}`, {
    code, provider: "railway", sandboxId, hint, retryable: ["quota", "unavailable"].includes(code), cause: native.cause,
  });
}
export function unsupported(message: string): never {
  throw new SandboxError(`${message}. Railway cannot enforce this request. Omit the option or use another provider.`, { code: "unsupported", provider: "railway" });
}
