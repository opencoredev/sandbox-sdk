import {
  Redactor,
  SandboxError,
  describeNative,
  nativeDetail,
  reason,
  type ErrorCode,
} from "../../errors.js";
import { decodeNative } from "../../shared/native-error.js";

// Retain only scrubbed text, never native response/request objects (headers can hold keys).
const detail = (cause: unknown, redact: (text: string) => string) =>
  nativeDetail(cause, redact) ?? "Native request failed";

export function upstashError(
  cause: unknown,
  sandboxId?: string,
  file = false,
  operation = file ? "files" : "request",
  redact: (text: string) => string = (text) => {
    const redactor = new Redactor();
    redactor.add([process.env.UPSTASH_BOX_API_KEY ?? ""]);

    return redactor.text(text);
  },
): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const httpStatus = decodeNative(cause).statusCode;

  let code: ErrorCode = "provider";

  if (httpStatus === 401 || httpStatus === 403) code = "auth";
  else if (httpStatus === 404) code = file ? "file_not_found" : "not_found";
  else if (httpStatus === 410) code = "not_found";
  else if (httpStatus === 429 || httpStatus === 402) code = "quota";
  else if (httpStatus === 408 || httpStatus === 504) code = "timeout";
  else if (httpStatus !== undefined && httpStatus >= 500) code = "unavailable";
  else if (httpStatus === 400 || httpStatus === 422) code = "invalid_argument";
  const evidence = `${operation}${httpStatus === undefined ? "" : ` HTTP ${httpStatus}`}: ${detail(cause, redact)}`;

  return new SandboxError(
    `Upstash Box ${operation} failed${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}: ${reason(code, describeNative(cause, { code, status: httpStatus === undefined ? undefined : String(httpStatus), redact }).detail)}. Check credentials, limits, and sandbox state.`,
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
