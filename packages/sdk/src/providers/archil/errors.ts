import { SandboxError, describeNative, reason, statusCode, type ErrorCode } from "../../errors.js";
import { isNumber, isObject, isString } from "../../shared/narrow.js";

export function failure(message: string, code: ErrorCode = "provider", sandboxId?: string) {
  return new SandboxError(
    code === "auth" || code === "file_not_found" ? message : `${message}. Check Archil and retry.`,
    { code, provider: "archil", sandboxId },
  );
}

/** The HTTP status of an `ArchilError` from `disk` (API, file transfer, pause or image errors). */
export function nativeStatus(cause: unknown): number | undefined {
  if (!(cause instanceof Error) || !("status" in cause)) return undefined;

  return isNumber(cause.status) ? cause.status : undefined;
}

/** Archil's machine-readable error code, such as `sandbox_name_conflict`. Never its message. */
export function nativeCode(cause: unknown): string | undefined {
  if (!isObject(cause) || !("code" in cause) || !isString(cause.code)) return undefined;

  // Only short identifiers: a code is a slug, and anything else could carry request text.
  return /^[A-Za-z0-9_.-]{1,64}$/.test(cause.code) ? cause.code : undefined;
}

// Archil answers a free-plan request for a feature the plan lacks with 403 and a *_plan_required
// code (sandbox_network_plan_required, measured from the API reference 2026-11-21): the key works,
// the account cannot do that.
const planRequired = /_plan_required$/;

/** An Archil failure as a SandboxError, keeping only the error's name, HTTP status and code. */
export function archilError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const status = nativeStatus(cause);
  const code = nativeCode(cause);
  const name = cause instanceof Error ? cause.name : undefined;

  const mapped: ErrorCode =
    code !== undefined && planRequired.test(code)
      ? "unsupported"
      : status !== undefined
        ? statusCode(status)
        : name === "AbortError"
          ? "aborted"
          : cause instanceof TypeError
            ? "unavailable"
            : "provider";

  // Archil's messages can echo paths and commands (file transfer errors quote the guest's
  // stderr), so only the name, status and code survive.
  const kept = describeNative(cause, {
    code: mapped,
    known: true,
    status:
      status === undefined ? undefined : `HTTP ${status}${code === undefined ? "" : ` ${code}`}`,
  });

  return new SandboxError(
    `Archil request failed: ${reason(mapped, kept.detail)}. Check Archil and retry.`,
    { code: mapped, provider: "archil", sandboxId, cause: kept.cause },
  );
}

/** Whether Archil refused because the sandbox is not running (paused, stopped or still starting). */
export function notRunning(cause: unknown): boolean {
  return nativeStatus(cause) === 409;
}
