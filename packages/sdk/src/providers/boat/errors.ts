import { SandboxError, type ErrorCode } from "../../errors.js";

/** Do not expose native responses: they can contain credentials and command text. */
export function boatError(cause: unknown, sandboxId?: string): SandboxError {
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
      ? "Set BOAT_API_KEY to a valid Boat API key."
      : "Check the sandbox and Boat service before retrying.";
  return new SandboxError(`Boat request failed. The provider reported ${code}. ${hint}`, {
    code,
    provider: "boat",
    sandboxId,
    hint,
    retryable: code === "unavailable" || code === "quota",
  });
}
export function failure(message: string, code: ErrorCode = "provider", sandboxId?: string) {
  return new SandboxError(code === "auth" ? message : `${message}. Check the Boat provider configuration and retry.`, {
    code,
    provider: "boat",
    sandboxId,
  });
}
