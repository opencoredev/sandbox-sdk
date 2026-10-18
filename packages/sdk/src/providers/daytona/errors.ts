import { SandboxError, type ErrorCode } from "../../errors.js";

export function daytonaError(error: unknown, sandboxId?: string, file = false): SandboxError {
  if (error instanceof SandboxError) return error;
  const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
  const nativeCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const name = error instanceof Error ? error.name : "";
  let code: ErrorCode = "provider";
  if (status === 401 || status === 403) code = "auth";
  else if (nativeCode === "FILE_NOT_FOUND" || (file && status === 404)) code = "file_not_found";
  else if (status === 404 || status === 410) code = "not_found";
  else if (status === 429 || status === 402 || nativeCode === "QUOTA_EXCEEDED") code = "quota";
  else if (status === 408 || status === 504 || name.includes("Timeout")) code = "timeout";
  else if (typeof status === "number" && status >= 500 || name.includes("Connection")) code = "unavailable";
  else if (status === 400 || status === 422 || name.includes("InvalidArgument")) code = "invalid_argument";
  // Native errors may contain API keys, tokens, request bodies and headers.
  return new SandboxError(`Daytona request failed (${code}). The provider could not complete the operation. Check the sandbox and provider configuration.`, {
    code, provider: "daytona", sandboxId, retryable: ["quota", "unavailable", "timeout"].includes(code),
    hint: "Check Daytona credentials, quotas, sandbox state, and request options before retrying.",
  });
}
export function unsupported(message: string): never {
  throw new SandboxError(`${message}. Daytona cannot enforce this request. Choose supported settings.`, { code: "unsupported", provider: "daytona" });
}
