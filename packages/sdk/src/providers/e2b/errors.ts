import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";
import { decodeNative } from "../../shared/native-error.js";

/** Native messages can contain API keys and command output. Only an unrecognized failure without a
 * status keeps its scrubbed text, with the API key redacted, as `cause` (see describeNative). */
export function e2bError(cause: unknown, sandboxId?: string, file = false): SandboxError {
  if (cause instanceof SandboxError) return cause;

  // e2b assigns each error class a literal name. Bundlers rename the classes (FileNotFoundError2, or a
  // minified letter), so constructor.name stops matching; the name field does not change.
  const native = decodeNative(cause);
  const name = native.name;
  const status = native.status;

  let code: ErrorCode = "provider";

  if (name === "AuthenticationError" || status === 401 || status === 403) code = "auth";
  else if (name === "FileNotFoundError") code = "file_not_found";
  else if (["NotFoundError", "SandboxNotFoundError"].includes(name) || status === 404)
    code = file ? "file_not_found" : "not_found";
  else if (
    ["RateLimitError", "NotEnoughSpaceError"].includes(name) ||
    status === 429 ||
    status === 507
  )
    code = "quota";
  else if (
    ["ServiceBusyError", "SandboxUnreachableError", "SandboxNotRunningError"].includes(name) ||
    (status !== undefined && status >= 500)
  )
    code = "unavailable";
  else if (name === "TimeoutError" || name === "TimeoutException") code = "timeout";
  else if (name === "AbortError") code = "aborted";
  else if (name === "InvalidArgumentError" || status === 400) code = "invalid_argument";

  const hint =
    code === "auth"
      ? "Check E2B_API_KEY and the E2B domain."
      : "Check the sandbox, template and E2B service, then retry.";

  const kept = describeNative(cause, {
    code,
    status: status === undefined ? undefined : `HTTP ${status}`,
    redact: redacting([process.env.E2B_API_KEY]),
  });

  return new SandboxError(`E2B request failed: ${reason(code, kept.detail)}. ${hint}`, {
    code,
    provider: "e2b",
    sandboxId,
    hint,
    retryable: ["quota", "unavailable", "timeout"].includes(code),
    cause: kept.cause,
  });
}
