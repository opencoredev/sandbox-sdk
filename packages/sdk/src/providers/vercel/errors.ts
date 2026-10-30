import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";
import { decodeNative, type NativeError } from "../../shared/native-error.js";

/** The `error.code` of a Vercel API response body, which the SDK attaches as `json`. */
export function apiCode(cause: unknown): string | undefined {
  return decodeNative(cause).bodyCode;
}

function errorCode(native: NativeError): ErrorCode {
  const status = native.responseStatus;
  const nativeCode = native.code;
  const name = native.name;

  if (status === 401 || status === 403) return "auth";

  if (status === 404) return "not_found";

  if (status === 429) return "quota";

  if (status !== undefined && status >= 500) return "unavailable";

  if (nativeCode === "ENOENT") return "file_not_found";

  if (nativeCode === "ENOTEMPTY" || nativeCode === "ENOTDIR" || status === 400)
    return "invalid_argument";

  if (name === "AbortError") return "aborted";

  if (name === "TimeoutError") return "timeout";

  if (/credentials|OIDC|token/i.test(native.message)) return "auth";

  return "provider";
}

export function vercelError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;

  const native = decodeNative(cause);
  const status = native.responseStatus;

  // A snapshot that does not exist, or a session that cannot resume because its snapshot is gone.
  // Vercel answers 400 or 410 depending on the path, always with this body code.
  if (native.bodyCode === "snapshot_not_found")
    return new SandboxError(
      "Vercel snapshot not found. It was deleted, expired, or never existed. Check the snapshot ID, or create a new sandbox.",
      { code: "not_found", provider: "vercel", sandboxId, cause: "snapshot_not_found" },
    );

  const code = errorCode(native);

  // Native messages can contain bearer tokens or full HTTP requests; see describeNative for what is kept.
  const kept = describeNative(cause, {
    code,
    status: status === undefined ? undefined : `HTTP ${status}`,
    redact: redacting([process.env.VERCEL_TOKEN, process.env.VERCEL_OIDC_TOKEN]),
  });

  return new SandboxError(
    `Vercel request failed: ${reason(code, kept.detail)}. Check credentials, resource limits, and the sandbox state before retrying.`,
    {
      code,
      provider: "vercel",
      sandboxId,
      retryable: code === "quota" || code === "unavailable",
      cause: kept.cause,
    },
  );
}

export function unsupported(message: string): never {
  throw new SandboxError(
    `${message}. Vercel cannot enforce this request. Use the supported Vercel settings or another provider.`,
    { code: "unsupported", provider: "vercel" },
  );
}
