import { Redactor, SandboxError, describeNative, nativeDetail, reason, type ErrorCode } from "../../errors.js";

// Retain only scrubbed text, never native response/request objects (headers can hold keys).
const detail = (error: unknown, redact: (text: string) => string) => nativeDetail(error, redact) ?? "Native request failed";

export function upstashError(
  error: unknown,
  sandboxId?: string,
  file = false,
  operation = file ? "files" : "request",
  redact: (text: string) => string = text => {
    const redactor = new Redactor();
    redactor.add([process.env.UPSTASH_BOX_API_KEY ?? ""]);
    return redactor.text(text);
  },
): SandboxError {
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
  const evidence = `${operation}${typeof status === "number" ? ` HTTP ${status}` : ""}: ${detail(error, redact)}`;
  return new SandboxError(
    `Upstash Box ${operation} failed${typeof status === "number" ? ` (HTTP ${status})` : ""}: ${reason(code, describeNative(error, { code, status: status === undefined ? undefined : String(status), redact }).detail)}. Check credentials, limits, and sandbox state.`,
    {
      code,
      provider: "upstash",
      sandboxId,
      retryable: ["quota", "timeout", "unavailable"].includes(code),
      cause: evidence,
    },
  );
}
export function unsupported(message: string): never {
  throw new SandboxError(
    `${message}. Upstash Box cannot enforce this request. Choose supported settings.`,
    { code: "unsupported", provider: "upstash" },
  );
}
