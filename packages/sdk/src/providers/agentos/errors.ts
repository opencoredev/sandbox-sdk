import { SandboxError, describeNative, reason, type ErrorCode } from "../../errors.js";

export function failure(
  message: string,
  code: ErrorCode = "provider",
  sandboxId?: string,
  cause?: string,
): SandboxError {
  return new SandboxError(`${message}. Check the agentOS runtime or use local() with Docker.`, {
    code,
    provider: "agentos",
    sandboxId,
    cause,
  });
}

/** Native errors may include file contents or environment variables. Only an unrecognized failure keeps
 * its text (see describeNative), scrubbed here; the core redacts registered secrets from it too. */
export function agentosError(cause: unknown, sandboxId?: string, file = false): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const message = cause instanceof Error ? cause.message : "";

  const code: ErrorCode = /ENOENT|not found|no such file/i.test(message)
    ? file
      ? "file_not_found"
      : "not_found"
    : /limit|quota|ENOSPC/i.test(message)
      ? "quota"
      : /sidecar.*(exit|closed|missing)|cannot find package|module not found/i.test(message)
        ? "unavailable"
        : /EACCES|EPERM|invalid|EINVAL/i.test(message)
          ? "invalid_argument"
          : "provider";

  const native = describeNative(cause, { code });

  return failure(
    `agentOS operation failed: ${reason(code, native.detail)}`,
    code,
    sandboxId,
    native.cause,
  );
}
