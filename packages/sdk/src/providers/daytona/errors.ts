import { isPeerError } from "../../peer.js";
import { SandboxError, describeNative, reason, redacting, type ErrorCode } from "../../errors.js";

// These codes are already recognized by this adapter. Unknown wire codes are
// omitted until verified; a spelling filter alone can admit reflected secrets.
const knownCodes = new Set(["FILE_NOT_FOUND", "QUOTA_EXCEEDED"]);

const requestIdShape =
  /^(?:[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

const bundleHint =
  "The Daytona SDK requires some modules at runtime in a way bundlers cannot follow. Mark @daytonaio/sdk as external (Next.js: serverExternalPackages) and install it next to your app.";

/** The module named by the Daytona SDK's own "Module "x" is not available" / "didn't pass import validation" error, if this is one. */
export function unloadedModule(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;

  return /Module "([\w@./-]{1,64})" (?:is not available|didn't pass import validation)/.exec(
    error.message,
  )?.[1];
}

export function daytonaError(
  error: unknown,
  sandboxId?: string,
  file = false,
  operation = file ? "files" : "request",
  apiKey = process.env.DAYTONA_API_KEY,
  knownSecrets: Iterable<string> = [],
): SandboxError {
  if (error instanceof SandboxError) return error;

  const status =
    error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;

  const nativeCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  // The SDK names errors after new.target.name, which bundlers rename with the class, so match the
  // classes the adapter loaded first. The name checks remain for callers that never loaded the peer.
  const name = error instanceof Error ? error.name : "";
  const is = (type: string) => isPeerError(error, "@daytonaio/sdk", type);

  const missingFile =
    file &&
    status === 400 &&
    error instanceof Error &&
    /(?:\bENOENT\b|no such file or directory|\bnot found\b|\bdoes not exist\b)/i.test(
      error.message,
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
    (typeof status === "number" && status >= 500) ||
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
  const evidence: {
    status?: number;
    providerCode?: string;
    requestId?: string;
    operation: string;
    source?: string;
    native?: string;
  } = {
    operation:
      /^(request|create|restore|list|connect|destroy|exec|process|preview|snapshot|files)$/.test(
        operation,
      )
        ? operation
        : "request",
  };

  const denied = [...knownSecrets, apiKey, process.env.DAYTONA_API_KEY].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  const safeToken = (value: unknown, pattern: RegExp): value is string =>
    typeof value === "string" &&
    pattern.test(value) &&
    !denied.some((secret) => value.includes(secret));

  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
    evidence.status = status;

  if (safeToken(nativeCode, /^[A-Z_]{1,64}$/) && knownCodes.has(nativeCode))
    evidence.providerCode = nativeCode;

  if (error && typeof error === "object") {
    if ("source" in error && safeToken(error.source, /^DAYTONA_(API|DAEMON|PROXY)$/))
      evidence.source = error.source;

    if ("headers" in error && error.headers && typeof error.headers === "object") {
      for (const key of ["x-request-id", "x-daytona-request-id"]) {
        const value: unknown = Reflect.get(error.headers, key);

        if (safeToken(value, requestIdShape)) {
          evidence.requestId = value;
          break;
        }
      }
    }
  }

  const { detail } = describeNative(error, {
    code,
    status: status === undefined ? undefined : String(status),
    redact: redacting(denied),
  });

  if (detail !== undefined) evidence.native = detail;
  // Error.message survives the SDK redactor; own fields support direct clients.
  const cause = Object.assign(new Error(JSON.stringify(evidence)), evidence);
  const module = unloadedModule(error);

  if (module !== undefined)
    return new SandboxError(
      `Daytona request failed: the Daytona SDK could not load "${module}" (${reason(code, evidence.native)}). ${bundleHint}`,
      {
        code: "unavailable",
        provider: "daytona",
        sandboxId,
        cause,
        hint: bundleHint,
      },
    );

  return new SandboxError(
    `Daytona request failed: ${reason(code, evidence.native)}. Check the sandbox and provider configuration.`,
    {
      code,
      provider: "daytona",
      sandboxId,
      cause,
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
