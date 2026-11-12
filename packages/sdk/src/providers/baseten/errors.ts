import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";
import { decodeNative } from "../../shared/native-error.js";

export function failure(
  message: string,
  code: ErrorCode = "provider",
  sandboxId?: string,
  cause?: string,
) {
  return new SandboxError(
    code === "auth" ? message : `${message}. Check the Baseten sandbox and retry.`,
    {
      code,
      provider: "baseten",
      sandboxId,
      cause,
    },
  );
}

const names = new Map<string, ErrorCode>([
  ["TimeoutError", "timeout"],
  ["AbortError", "aborted"],
]);

/** Maps anything thrown at the adapter boundary to a SandboxError; HTTP failures are already mapped. */
export function basetenError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const native = decodeNative(cause);
  const status = native.statusCode ?? native.status;
  const code = status === undefined ? (names.get(native.name) ?? "provider") : "provider";

  // Response text can echo the request; see describeNative for what is kept.
  const kept = describeNative(cause, {
    code,
    status: status === undefined ? undefined : `HTTP ${status}`,
    redact: redacting([process.env.BASETEN_API_KEY]),
  });

  return failure(
    `Baseten request failed: ${reason(code, kept.detail)}`,
    code,
    sandboxId,
    kept.cause,
  );
}
