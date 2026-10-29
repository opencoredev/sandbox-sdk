import type * as Daytona from "@daytonaio/sdk";
import {
  SandboxError,
  describeNative,
  evidenceCause,
  reason,
  redacting,
  type ErrorCode,
  type NativeEvidence,
} from "../../errors.js";
import { decodeNative } from "../../shared/native-error.js";
import { isString } from "../../shared/narrow.js";

// These codes are already recognized by this adapter. Unknown wire codes are
// omitted until verified; a spelling filter alone can admit reflected secrets.
const knownCodes = new Set(["FILE_NOT_FOUND", "QUOTA_EXCEEDED"]);

const requestIdPattern =
  /^(?:[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

const bundleHint =
  "The Daytona SDK requires some modules at runtime in a way bundlers cannot follow. Mark @daytonaio/sdk as external (Next.js: serverExternalPackages) and install it next to your app.";

/** The Daytona SDK error classes this module matches. */
export type DaytonaErrorClasses = Pick<
  typeof Daytona,
  | "DaytonaTimeoutError"
  | "DaytonaConnectionTimeoutError"
  | "DaytonaConnectionError"
  | "DaytonaInvalidArgumentError"
>;

/** Every copy of the Daytona SDK's error classes an adapter has loaded. The SDK names errors after
 * new.target.name, which bundlers rename with the class, so the class objects are the stable match.
 * Each factory can load its own copy, and an error from any of them is a Daytona error. */
const loaded = new Set<DaytonaErrorClasses>();

/** Match errors against the classes of a Daytona SDK copy an adapter loaded. */
export function rememberDaytonaErrors(classes: DaytonaErrorClasses): void {
  loaded.add(classes);
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

  const native = decodeNative(cause);
  const status = native.statusCode;
  const nativeCode = native.code;
  // Match the classes the adapter loaded first. The name checks remain for callers that never loaded the peer.
  const name = native.name;

  const is = (type: keyof DaytonaErrorClasses) =>
    [...loaded].some((classes) => cause instanceof classes[type]);

  const missingFile =
    file &&
    status === 400 &&
    /(?:\bENOENT\b|no such file or directory|\bnot found\b|\bdoes not exist\b)/i.test(
      native.message,
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
  const evidence: NativeEvidence = {
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

  const safe = (value: string | number | undefined, pattern: RegExp): value is string =>
    isString(value) && pattern.test(value) && !denied.some((secret) => value.includes(secret));

  if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599)
    evidence.status = status;

  if (safe(nativeCode, /^[A-Z_]{1,64}$/) && knownCodes.has(nativeCode))
    evidence.providerCode = nativeCode;

  if (safe(native.source, /^DAYTONA_(API|DAEMON|PROXY)$/)) evidence.source = native.source;

  const requestId = ["x-request-id", "x-daytona-request-id"]
    .map((key) => native.headers.get(key))
    .find((value) => safe(value, requestIdPattern));

  if (requestId !== undefined) evidence.requestId = requestId;

  const { detail } = describeNative(cause, {
    code,
    status: status === undefined ? undefined : String(status),
    redact: redacting(denied),
  });

  if (detail !== undefined) evidence.native = detail;
  const module = unloadedModule(cause);

  if (module !== undefined)
    return new SandboxError(
      `Daytona request failed: the Daytona SDK could not load "${module}" (${reason(code, evidence.native)}). ${bundleHint}`,
      {
        code: "unavailable",
        provider: "daytona",
        sandboxId,
        cause: evidenceCause(evidence),
        hint: bundleHint,
      },
    );

  return new SandboxError(
    `Daytona request failed: ${reason(code, evidence.native)}. Check the sandbox and provider configuration.`,
    {
      code,
      provider: "daytona",
      sandboxId,
      cause: evidenceCause(evidence),
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
