import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

/** A Vercel API error, which the SDK gives the response and its parsed body as `json`. */
function hasApiError(cause: unknown): cause is { json: { error: { code: string } } } {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "json" in cause &&
    typeof cause.json === "object" &&
    cause.json !== null &&
    "error" in cause.json &&
    typeof cause.json.error === "object" &&
    cause.json.error !== null &&
    "code" in cause.json.error &&
    typeof cause.json.error.code === "string"
  );
}

function hasResponse(cause: unknown): cause is { response: Response } {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "response" in cause &&
    cause.response instanceof Response
  );
}

function hasCode(cause: unknown): cause is { code: string } {
  return (
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
  );
}

/** The `error.code` of a Vercel API response body, which the SDK attaches as `json`. */
export function apiCode(cause: unknown): string | undefined {
  return hasApiError(cause) ? cause.json.error.code : undefined;
}

function errorCode(cause: unknown, status: number | undefined): ErrorCode {
  const nativeCode = hasCode(cause) ? cause.code : undefined;
  const name = cause instanceof Error ? cause.name : "";

  if (status === 401 || status === 403) return "auth";

  if (status === 404) return "not_found";

  if (status === 429) return "quota";

  if (status !== undefined && status >= 500) return "unavailable";

  if (nativeCode === "ENOENT") return "file_not_found";

  if (nativeCode === "ENOTEMPTY" || nativeCode === "ENOTDIR" || status === 400)
    return "invalid_argument";

  if (name === "AbortError") return "aborted";

  if (name === "TimeoutError") return "timeout";

  if (cause instanceof Error && /credentials|OIDC|token/i.test(cause.message)) return "auth";

  return "provider";
}

export function vercelError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;

  const status = hasResponse(cause) ? cause.response.status : undefined;

  // A snapshot that does not exist, or a session that cannot resume because its snapshot is gone.
  // Vercel answers 400 or 410 depending on the path, always with this body code.
  if (apiCode(cause) === "snapshot_not_found")
    return new SandboxError(
      "Vercel snapshot not found. It was deleted, expired, or never existed. Check the snapshot ID, or create a new sandbox.",
      { code: "not_found", provider: "vercel", sandboxId, cause: "snapshot_not_found" },
    );

  const code = errorCode(cause, status);

  // Native messages can contain bearer tokens or full HTTP requests; see describeNative for what is kept.
  const native = describeNative(cause, {
    code,
    status: status === undefined ? undefined : `HTTP ${status}`,
    redact: redacting([process.env.VERCEL_TOKEN, process.env.VERCEL_OIDC_TOKEN]),
  });

  return new SandboxError(
    `Vercel request failed: ${reason(code, native.detail)}. Check credentials, resource limits, and the sandbox state before retrying.`,
    {
      code,
      provider: "vercel",
      sandboxId,
      retryable: code === "quota" || code === "unavailable",
      cause: native.cause,
    },
  );
}

export function unsupported(message: string): never {
  throw new SandboxError(
    `${message}. Vercel cannot enforce this request. Use the supported Vercel settings or another provider.`,
    { code: "unsupported", provider: "vercel" },
  );
}
