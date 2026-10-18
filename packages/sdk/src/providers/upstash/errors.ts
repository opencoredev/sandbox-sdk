import { SandboxError, type ErrorCode } from "../../errors.js";

export function upstashError(error: unknown, sandboxId?: string, file = false): SandboxError {
  if (error instanceof SandboxError) return error;
  const status =
    error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
  let code: ErrorCode = "provider";
  if (status === 401 || status === 403) code = "auth";
  else if (status === 404) code = file ? "file_not_found" : "not_found";
  else if (status === 410) code = "not_found";
  else if (status === 429 || status === 402) code = "quota";
  else if (status === 408 || status === 504) code = "timeout";
  else if (typeof status === "number" && status >= 500) code = "unavailable";
  else if (status === 400 || status === 422) code = "invalid_argument";
  return new SandboxError(
    `Upstash Box request failed (${code}). The provider could not complete the operation. Check credentials, limits, and sandbox state.`,
    {
      code,
      provider: "upstash",
      sandboxId,
      retryable: ["quota", "timeout", "unavailable"].includes(code),
    },
  );
}
export function unsupported(message: string): never {
  throw new SandboxError(
    `${message}. Upstash Box cannot enforce this request. Choose supported settings.`,
    { code: "unsupported", provider: "upstash" },
  );
}
