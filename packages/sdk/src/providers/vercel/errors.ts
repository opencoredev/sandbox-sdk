import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

export function vercelError(error: unknown, sandboxId?: string): SandboxError {
  if (error instanceof SandboxError) return error;
  const status = typeof error === "object" && error !== null && "response" in error && error.response instanceof Response ? error.response.status : undefined;
  const nativeCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const code: ErrorCode = status === 401 || status === 403 ? "auth" : status === 404 ? "not_found" : status === 429 ? "quota" : status !== undefined && status >= 500 ? "unavailable" : nativeCode === "ENOENT" ? "file_not_found" : nativeCode === "ENOTEMPTY" || nativeCode === "ENOTDIR" || status === 400 ? "invalid_argument" : error instanceof Error && error.name === "AbortError" ? "aborted" : error instanceof Error && error.name === "TimeoutError" ? "timeout" : error instanceof Error && /credentials|OIDC|token/i.test(error.message) ? "auth" : "provider";
  // Native messages can contain bearer tokens or full HTTP requests; see describeNative for what is kept.
  const native = describeNative(error, { code, status: status === undefined ? undefined : `HTTP ${status}`, redact: redacting([process.env.VERCEL_TOKEN, process.env.VERCEL_OIDC_TOKEN]) });
  return new SandboxError(`Vercel request failed: ${reason(code, native.detail)}. Check credentials, resource limits, and the sandbox state before retrying.`, {
    code, provider: "vercel", sandboxId, retryable: code === "quota" || code === "unavailable", cause: native.cause,
  });
}
export function unsupported(message: string): never {
  throw new SandboxError(`${message}. Vercel cannot enforce this request. Use the supported Vercel settings or another provider.`, { code: "unsupported", provider: "vercel" });
}
