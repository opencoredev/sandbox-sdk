import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

/** `detailed` adds the HTTP status and the envelope's fixed error code, never free text. */
export function errors(provider = "boat", label = "Boat", keyEnv = "BOAT_API_KEY", detailed = false) {
  /** Do not expose native responses: they can contain credentials and command text. */
  function boatError(cause: unknown, sandboxId?: string): SandboxError {
    if (cause instanceof SandboxError) return cause;
    const response =
      typeof cause === "object" && cause !== null && "response" in cause ? cause.response : undefined;
    const status = response instanceof Response ? response.status : undefined;
    let code: ErrorCode = "provider";
    if (status === 401 || status === 403) code = "auth";
    else if (status === 404) code = "not_found";
    else if (status === 402 || status === 429) code = "quota";
    else if (status === 400) code = "invalid_argument";
    else if (status === 408 || (cause instanceof Error && cause.name === "TimeoutError"))
      code = "timeout";
    else if (status !== undefined && status >= 500) code = "unavailable";
    else if (cause instanceof Error && cause.name === "AbortError") code = "aborted";
    const hint =
      code === "auth"
        ? `Set ${keyEnv} to a valid ${label} API key.`
        : `Check the sandbox and ${label} service before retrying.`;
    const apiCode = typeof cause === "object" && cause !== null && "apiCode" in cause &&
      typeof cause.apiCode === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(cause.apiCode) ? ` ${cause.apiCode}` : "";
    const detail = detailed && status !== undefined ? ` (HTTP ${status}${apiCode})` : "";
    // Response text can echo the request, so an HTTP failure keeps only its status.
    const native = describeNative(cause, { code, status: status === undefined ? undefined : `HTTP ${status}${apiCode}`, redact: redacting([process.env[keyEnv]]) });
    return new SandboxError(`${label} request failed${detail}: ${reason(code, native.detail)}. ${hint}`, {
      code,
      provider,
      sandboxId,
      hint,
      retryable: code === "unavailable" || code === "quota",
      cause: native.cause,
    });
  }
  function failure(message: string, code: ErrorCode = "provider", sandboxId?: string) {
    const text = message.replaceAll("Boat", label);
    return new SandboxError(code === "auth" ? text : `${text}. Check the ${label} provider configuration and retry.`, {
      code,
      provider,
      sandboxId,
    });
  }
  return { boatError, failure };
}
