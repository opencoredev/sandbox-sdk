import { isPeerError } from "../../peer.js";
import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

// These codes are already recognized by this adapter. Unknown wire codes are
// omitted until verified; a spelling filter alone can admit reflected secrets.
const knownCodes = new Set(["FILE_NOT_FOUND", "QUOTA_EXCEEDED"]);

const requestIdPattern =
  /^(?:[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

const bundleHint =
  "The Daytona SDK requires some modules at runtime in a way bundlers cannot follow. Mark @daytonaio/sdk as external (Next.js: serverExternalPackages) and install it next to your app.";

/** Bounded machine fields copied from a native failure, never its message or body. */
type Evidence = {
  status?: number;
  providerCode?: string;
  requestId?: string;
  operation: string;
  source?: string;
  native?: string;
};

function hasStatusCode(cause: unknown): cause is { statusCode: number } {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "statusCode" in cause &&
    typeof cause.statusCode === "number"
  );
}

function hasCode(cause: unknown): cause is { code: string } {
  return (
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
  );
}

function hasSource(cause: unknown): cause is { source: unknown } {
  return typeof cause === "object" && cause !== null && "source" in cause;
}

function hasHeaders(
  cause: unknown,
): cause is { headers: { "x-request-id"?: unknown; "x-daytona-request-id"?: unknown } } {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "headers" in cause &&
    typeof cause.headers === "object" &&
    cause.headers !== null
  );
}

/** The module named by the Daytona SDK's own "Module "x" is not available" / "didn't pass import validation" error, if this is one. */
export function unloadedModule(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;

  return /Module "([\w@./-]{1,64})" (?:is not available|didn't pass import validation)/.exec(
    cause.message,
  )?.[1];
}

export function daytonaError(
  cause: unknown,
  sandboxId?: string,
  file = false,
  operation = file ? "files" : "request",
  apiKey = process.env.DAYTONA_API_KEY,
  knownSecrets: Iterable<string> = [],
): SandboxError {
  if (cause instanceof SandboxError) return cause;

  const status = hasStatusCode(cause) ? cause.statusCode : undefined;
  const nativeCode = hasCode(cause) ? cause.code : undefined;
  // The SDK names errors after new.target.name, which bundlers rename with the class, so match the
  // classes the adapter loaded first. The name checks remain for callers that never loaded the peer.
  const name = cause instanceof Error ? cause.name : "";
  const is = (type: string) => isPeerError(cause, "@daytonaio/sdk", type);

  const missingFile =
    file &&
    status === 400 &&
    cause instanceof Error &&
    /(?:\bENOENT\b|no such file or directory|\bnot found\b|\bdoes not exist\b)/i.test(
      cause.message,
    );

  let code: ErrorCode = "provider";

  if (status === 401 || status === 403) code = "auth";
  else if (nativeCode === "FILE_NOT_FOUND" || (file && status === 404) || missingFile)
    code = "file_not_found";
  else if (status === 404 || status === 410) code = "not_found";
  else if (status === 429 || status === 402 || nativeCode === "QUOTA_EXCEEDED") code = "quota";
  else if (
    status === 408 ||
    status === 504 ||
    is("DaytonaTimeoutError") ||
    is("DaytonaConnectionTimeoutError") ||
    name.includes("Timeout")
  )
    code = "timeout";
  else if (
    (status !== undefined && status >= 500) ||
    is("DaytonaConnectionError") ||
    name.includes("Connection")
  )
    code = "unavailable";
  else if (
    status === 400 ||
    status === 422 ||
    is("DaytonaInvalidArgumentError") ||
    name.includes("InvalidArgument")
  )
    code = "invalid_argument";

  // Copy only bounded machine fields; never a response's message or body. An unrecognized
  // failure without a status keeps its scrubbed message as `native` (see describeNative).
  const evidence: Evidence = {
    operation:
      /^(request|create|restore|list|connect|destroy|exec|process|preview|snapshot|files)$/.test(
        operation,
      )
        ? operation
        : "request",
  };

  const denied = [...knownSecrets, apiKey, process.env.DAYTONA_API_KEY].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );

  const safeToken = (value: unknown, pattern: RegExp): value is string =>
    typeof value === "string" &&
    pattern.test(value) &&
    !denied.some((secret) => value.includes(secret));

  if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599)
    evidence.status = status;

  if (safeToken(nativeCode, /^[A-Z_]{1,64}$/) && knownCodes.has(nativeCode))
    evidence.providerCode = nativeCode;

  if (hasSource(cause) && safeToken(cause.source, /^DAYTONA_(API|DAEMON|PROXY)$/))
    evidence.source = cause.source;

  if (hasHeaders(cause)) {
    for (const key of ["x-request-id", "x-daytona-request-id"] as const) {
      const value = cause.headers[key];

      if (safeToken(value, requestIdPattern)) {
        evidence.requestId = value;
        break;
      }
    }
  }

  const { detail } = describeNative(cause, {
    code,
    status: status === undefined ? undefined : String(status),
    redact: redacting(denied),
  });

  if (detail !== undefined) evidence.native = detail;
  // Error.message survives the SDK redactor; own fields support direct clients.
  const evidenceError = Object.assign(new Error(JSON.stringify(evidence)), evidence);
  const module = unloadedModule(cause);

  if (module !== undefined)
    return new SandboxError(
      `Daytona request failed: the Daytona SDK could not load "${module}" (${reason(code, evidence.native)}). ${bundleHint}`,
      {
        code: "unavailable",
        provider: "daytona",
        sandboxId,
        cause: evidenceError,
        hint: bundleHint,
      },
    );

  return new SandboxError(
    `Daytona request failed: ${reason(code, evidence.native)}. Check the sandbox and provider configuration.`,
    {
      code,
      provider: "daytona",
      sandboxId,
      cause: evidenceError,
      retryable: ["quota", "unavailable", "timeout"].includes(code),
      hint: "Check Daytona credentials, quotas, sandbox state, and request options before retrying.",
    },
  );
}

export function unsupported(message: string): never {
  throw new SandboxError(
    `${message}. Daytona cannot enforce this request. Choose supported settings.`,
    { code: "unsupported", provider: "daytona" },
  );
}
