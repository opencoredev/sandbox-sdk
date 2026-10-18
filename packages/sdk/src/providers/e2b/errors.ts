import { SandboxError, type ErrorCode } from "../../errors.js";

/** Native messages/causes can contain API keys and command output. Keep them private. */
export function e2bError(cause: unknown, sandboxId?: string, file = false): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const name = cause instanceof Error ? cause.constructor.name : "";
  const status = typeof cause === "object" && cause !== null && "status" in cause ? cause.status : undefined;
  let code: ErrorCode = "provider";
  if (name === "AuthenticationError" || status === 401 || status === 403) code = "auth";
  else if (name === "FileNotFoundError") code = "file_not_found";
  else if (["NotFoundError", "SandboxNotFoundError"].includes(name) || status === 404) code = file ? "file_not_found" : "not_found";
  else if (["RateLimitError", "NotEnoughSpaceError"].includes(name) || status === 429 || status === 507) code = "quota";
  else if (["ServiceBusyError", "SandboxUnreachableError", "SandboxNotRunningError"].includes(name) || (typeof status === "number" && status >= 500)) code = "unavailable";
  else if (name === "TimeoutError" || name === "TimeoutException") code = "timeout";
  else if (name === "AbortError" || (typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError")) code = "aborted";
  else if (name === "InvalidArgumentError" || status === 400) code = "invalid_argument";
  const hint = code === "auth" ? "Check E2B_API_KEY and the E2B domain." : "Check the sandbox, template and E2B service, then retry.";
  return new SandboxError(`E2B request failed. The provider reported ${code}. ${hint}`, { code, provider: "e2b", sandboxId, hint, retryable: ["quota", "unavailable", "timeout"].includes(code) });
}
