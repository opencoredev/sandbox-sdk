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

// A plan's concurrent-sandbox cap (Free 5, Developer 20, Team 250) is an account limit, not a bad
// key, whatever status carries it. Archil does not document the code, so any quota or limit code
// on 402, 403 or 429 counts; a 400 such as an out-of-range size keeps its own meaning.
const accountLimit = /quota|limit/i;

function isAccountLimit(status: number | undefined, code: string | undefined) {
  return (
    status !== undefined &&
    [402, 403, 429].includes(status) &&
    code !== undefined &&
    accountLimit.test(code)
  );
}

/**
 * `disk` loads its HTTP transport, undici, with a computed `import()` on first use, so a bundle
 * that inlines `disk` cannot resolve it (undici is `disk`'s own dependency, not a top-level one).
 * Nothing was sent when this fails.
 */
export function isTransportMissing(cause: unknown): boolean {
  for (let current = cause, depth = 0; isObject(current) && depth < 3; depth++) {
    if (
      "code" in current &&
      current.code === "ERR_MODULE_NOT_FOUND" &&
      current instanceof Error &&
      current.message.includes("'undici'")
    )
      return true;
    current = "cause" in current ? current.cause : undefined;
  }

  return false;
}

const transportHint =
  "Keep disk external when bundling (it loads undici at run time), or install undici next to the bundle.";

/** An Archil failure as a SandboxError, keeping only the error's name, HTTP status and code. */
export function archilError(cause: unknown, sandboxId?: string): SandboxError {
  if (cause instanceof SandboxError) return cause;

  if (isTransportMissing(cause))
    return new SandboxError(
      `disk could not load its undici dependency in this bundle. ${transportHint}`,
      { code: "unavailable", provider: "archil", sandboxId, hint: transportHint },
    );
  const status = nativeStatus(cause);
  const code = nativeCode(cause);
  const name = cause instanceof Error ? cause.name : undefined;

  const mapped: ErrorCode =
    code !== undefined && planRequired.test(code)
      ? "unsupported"
      : isAccountLimit(status, code)
        ? "quota"
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
