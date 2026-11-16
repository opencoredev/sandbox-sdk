import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";
import { decodeNative, type NativeError } from "../../shared/native-error.js";
import { isNumber } from "../../shared/narrow.js";

/**
 * Modal's own error classes, by `name`. The SDK sets each name as a string literal, so the mapping
 * survives a minifier that renames the classes.
 */
const byName: ReadonlyMap<string, ErrorCode> = new Map([
  ["NotFoundError", "not_found"],
  ["SandboxFilesystemNotFoundError", "file_not_found"],
  ["SandboxFilesystemNotADirectoryError", "invalid_argument"],
  ["SandboxFilesystemIsADirectoryError", "invalid_argument"],
  ["SandboxFilesystemDirectoryNotEmptyError", "invalid_argument"],
  ["SandboxFilesystemPathAlreadyExistsError", "invalid_argument"],
  ["SandboxFilesystemFileTooLargeError", "invalid_argument"],
  ["SandboxFilesystemPermissionError", "invalid_argument"],
  ["AlreadyExistsError", "invalid_argument"],
  ["ConflictError", "invalid_argument"],
  ["InvalidError", "invalid_argument"],
  ["ResourceExhaustedError", "quota"],
  ["InternalFailure", "unavailable"],
  ["TimeoutError", "timeout"],
  ["SandboxTimeoutError", "timeout"],
  ["AbortError", "aborted"],
]);

/** gRPC status codes, as nice-grpc's `ClientError.code` carries them. */
const byGrpcStatus: ReadonlyMap<number, ErrorCode> = new Map([
  [1, "aborted"],
  [3, "invalid_argument"],
  [4, "timeout"],
  [5, "not_found"],
  [7, "auth"],
  [8, "quota"],
  [14, "unavailable"],
  [16, "auth"],
]);

function errorCode(native: NativeError): ErrorCode {
  // Modal answers a malformed or unknown sandbox ID with INVALID_ARGUMENT; no such sandbox can exist.
  if (/is not a valid sandbox ID/.test(native.message)) return "not_found";

  const named = byName.get(native.name);

  if (named) return named;

  const status = isNumber(native.code) ? byGrpcStatus.get(native.code) : undefined;

  if (status) return status;

  if (/token|credential|unauthenticated/i.test(native.message)) return "auth";

  return "provider";
}

export function modalError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;

  const native = decodeNative(cause);
  const code = errorCode(native);

  // Native messages can echo request fields; describeNative keeps only scrubbed, bounded text.
  const kept = describeNative(cause, {
    code,
    status: isNumber(native.code) ? `gRPC ${native.code}` : undefined,
    redact: redacting([process.env.MODAL_TOKEN_ID, process.env.MODAL_TOKEN_SECRET]),
  });

  return new SandboxError(
    `Modal request failed: ${reason(code, kept.detail)}. Check credentials, resource limits, and the sandbox state before retrying.`,
    {
      code,
      provider: "modal",
      sandboxId,
      retryable: code === "quota" || code === "unavailable",
      cause: kept.cause,
    },
  );
}

export function unsupported(message: string): never {
  throw new SandboxError(
    `${message}. Modal cannot enforce this request. Use the supported Modal settings or another provider.`,
    { code: "unsupported", provider: "modal" },
  );
}

export function invalid(message: string): never {
  throw new SandboxError(message, { code: "invalid_argument", provider: "modal" });
}
