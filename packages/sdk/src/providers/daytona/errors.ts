import { SandboxError, type ErrorCode } from "../../errors.js";

export function daytonaError(error: unknown, sandboxId?: string, file = false, operation = file ? "files" : "request", apiKey = process.env.DAYTONA_API_KEY): SandboxError {
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
  // Copy only bounded machine fields; never copy native messages or bodies.
  const evidence: { status?: number; providerCode?: string; requestId?: string; operation: string; source?: string } = {
    operation: /^(request|create|restore|list|connect|destroy|exec|process|preview|snapshot|files)$/.test(operation) ? operation : "request",
  };
  const safeToken = (value: unknown, pattern: RegExp): value is string =>
    typeof value === "string" && pattern.test(value) && !(apiKey && value.includes(apiKey));
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) evidence.status = status;
  if (safeToken(nativeCode, /^[A-Z][A-Z0-9_]{0,63}$/)) evidence.providerCode = nativeCode;
  if (error && typeof error === "object") {
    if ("source" in error && ["DAYTONA_API", "DAYTONA_DAEMON", "DAYTONA_PROXY"].includes(String(error.source))) evidence.source = String(error.source);
    if ("headers" in error && error.headers && typeof error.headers === "object") {
      for (const key of ["x-request-id", "x-daytona-request-id"]) {
        const value: unknown = Reflect.get(error.headers, key);
        if (safeToken(value, /^[A-Za-z0-9_-]{1,128}$/)) { evidence.requestId = value; break; }
      }
    }
  }
  // Error.message survives the SDK redactor; own fields support direct clients.
  const cause = Object.assign(new Error(JSON.stringify(evidence)), evidence);
  return new SandboxError(`Daytona request failed (${code}). The provider could not complete the operation. Check the sandbox and provider configuration.`, {
    code, provider: "daytona", sandboxId, cause, retryable: ["quota", "unavailable", "timeout"].includes(code),
    hint: "Check Daytona credentials, quotas, sandbox state, and request options before retrying.",
  });
}
export function unsupported(message: string): never {
  throw new SandboxError(`${message}. Daytona cannot enforce this request. Choose supported settings.`, { code: "unsupported", provider: "daytona" });
}
