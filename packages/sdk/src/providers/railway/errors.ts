import { isPeerError } from "../../peer.js";
import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

/** Railway messages can include tokens and output. Only an unrecognized failure without a
 * status keeps its scrubbed text, with the token redacted, as `cause` (see describeNative). */
export function railwayError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;
  // The SDK sets name from new.target.name, which a bundler renames along with the class. Match the classes
  // the adapter loaded, most specific first; the name check covers callers that never loaded the peer.
  const name = cause instanceof Error ? cause.name : "";
  const is = (type: string) => isPeerError(cause, "railway", type) || name === type;
  const status = typeof cause === "object" && cause !== null && "status" in cause ? cause.status : undefined;
  let code: ErrorCode = "provider";
  if (is("RailwayAuthError") || status === 401 || status === 403) code = "auth";
  else if (is("SandboxFileNotFoundError")) code = "file_not_found";
  else if (is("SandboxNotFoundError") || status === 404) code = "not_found";
  else if (is("ExecControlUnsupportedError")) code = "unsupported";
  else if (is("ExecNotStartedError")) code = "unavailable";
  else if (is("ExecInterruptedError") || is("RailwayConnectionError")) code = "outcome_unknown";
  else if (status === 429 || status === 507) code = "quota";
  else if (typeof status === "number" && status >= 500) code = "unavailable";
  else if (is("SandboxTimeoutError")) code = "timeout";
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
