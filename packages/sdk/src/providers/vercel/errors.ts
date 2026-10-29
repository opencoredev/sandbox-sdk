import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

/** The `error.code` of a Vercel API response body, which the SDK attaches as `json`. */
export function apiCode(error: unknown): unknown {
  const body =
    typeof error === "object" && error !== null && "json" in error ? error.json : undefined;

  const detail =
    typeof body === "object" && body !== null && "error" in body ? body.error : undefined;

  return typeof detail === "object" && detail !== null && "code" in detail
    ? detail.code
    : undefined;
}

export function vercelError(error: unknown, sandboxId?: string): SandboxError {
  if (error instanceof SandboxError) return error;

  const status =
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    error.response instanceof Response
      ? error.response.status
      : undefined;

  const nativeCode =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

  // A snapshot that does not exist, or a session that cannot resume because its snapshot is gone.
  // Vercel answers 400 or 410 depending on the path, always with this body code.
  if (apiCode(error) === "snapshot_not_found")
    return new SandboxError(
      "Vercel snapshot not found. It was deleted, expired, or never existed. Check the snapshot ID, or create a new sandbox.",
      { code: "not_found", provider: "vercel", sandboxId, cause: "snapshot_not_found" },
    );

  const code: ErrorCode =
    status === 401 || status === 403
      ? "auth"
      : status === 404
        ? "not_found"
        : status === 429
          ? "quota"
          : status !== undefined && status >= 500
            ? "unavailable"
            : nativeCode === "ENOENT"
              ? "file_not_found"
              : nativeCode === "ENOTEMPTY" || nativeCode === "ENOTDIR" || status === 400
                ? "invalid_argument"
                : error instanceof Error && error.name === "AbortError"
                  ? "aborted"
                  : error instanceof Error && error.name === "TimeoutError"
                    ? "timeout"
                    : error instanceof Error && /credentials|OIDC|token/i.test(error.message)
                      ? "auth"
                      : "provider";

  // Native messages can contain bearer tokens or full HTTP requests; see describeNative for what is kept.
  const native = describeNative(error, {
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
