import type { InspectOptionsStylized, inspect as nodeInspect } from "node:util";
import { isString } from "./shared/narrow.js";

/**
 * Why a {@link SandboxError} was thrown. A non-zero exit, a command timeout, or an
 * aborted `run` is never an error; those resolve with `ok: false`.
 *
 * - `auth`: credentials are missing or rejected.
 * - `not_found`: the sandbox or handle no longer exists, or the handle was closed.
 * - `quota`: a provider limit or billing stopped the request. Usually retryable.
 * - `unavailable`: the provider is down or unreachable. Usually retryable.
 * - `unsupported`: the provider cannot do what was asked (size, network policy, lifetime).
 * - `timeout`: a provider operation or a readiness check took too long.
 * - `aborted`: your `AbortSignal` fired.
 * - `outcome_unknown`: the request may or may not have happened.
 * - `process_exited`: a background process exited before it was ready.
 * - `port_not_ready`: a preview did not answer with a 2xx before `waitMs` ran out.
 * - `edit_not_found` / `edit_not_unique`: `files.edit` matched zero or several times.
 * - `file_not_found`: the path does not exist.
 * - `invalid_argument`: the input is invalid. Retrying will not help.
 * - `provider`: any other provider or adapter failure.
 */
export type ErrorCode =
  | "auth"
  | "not_found"
  | "quota"
  | "unavailable"
  | "unsupported"
  | "timeout"
  | "aborted"
  | "outcome_unknown"
  | "process_exited"
  | "port_not_ready"
  | "edit_not_found"
  | "edit_not_unique"
  | "file_not_found"
  | "invalid_argument"
  | "provider";

/** Second argument to the {@link SandboxError} constructor. */
export interface ErrorOptions {
  code: ErrorCode;
  /** Provider name. Default: `"unknown"`. */
  provider?: string;
  sandboxId?: string;
  /** Whether the same call can succeed on retry. Default: `false`. */
  retryable?: boolean;
  /** The next step, on its own. Default: a generic step for `code`. */
  hint?: string;
  cause?: unknown;
}

const hints: Record<ErrorCode, string> = {
  auth: "Set the provider's API key environment variable or pass it to the provider factory.",
  not_found: "Create a new sandbox, or pass a key to createSandbox so it recreates one for you.",
  quota: "Wait and retry, destroy unused sandboxes with reapSandboxes, or raise the provider plan.",
  unavailable: "Retry with backoff. Check the provider's status page if it persists.",
  unsupported: "Remove the option or choose a provider that supports it. Check box.capabilities.",
  timeout: "Retry, or raise the relevant timeout option.",
  aborted: "Retry with a fresh AbortSignal if you still need the result.",
  outcome_unknown: "Check the sandbox state before retrying. If in doubt, destroy it.",
  process_exited:
    "Read the exit code and log tail in the message, fix the command, and start it again.",
  port_not_ready:
    "Check that the server listens on 0.0.0.0 and the right port, then read its logs.",
  edit_not_found: "Read the file again and use text that is in it.",
  edit_not_unique: "Add surrounding lines to find so it matches exactly once.",
  file_not_found: "Check the path. Relative paths resolve against /workspace.",
  invalid_argument: "Fix the input. Retrying the same call will not help.",
  provider: "Read the message and cause. Report it if it looks like an SDK bug.",
};

/**
 * The only error type the SDK throws. Branch on `code` and `retryable`; show `hint` to users.
 * Secrets registered with the sandbox are redacted from `message`, `hint`, and `cause`.
 */
export class SandboxError extends Error {
  /** What kind of failure this is. */
  readonly code: ErrorCode;
  /** Whether the same call can succeed if you retry it. */
  readonly retryable: boolean;
  /** The next step, on its own, for logs and UIs. */
  readonly hint: string;
  /** Provider name, or `"unknown"`. */
  readonly provider: string;
  /** The sandbox involved, when there is one. */
  readonly sandboxId?: string;
  constructor(message: string, options: ErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "SandboxError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.hint = options.hint ?? hints[options.code] ?? hints.provider;
    this.provider = options.provider ?? "unknown";
    this.sandboxId = options.sandboxId;
  }
  static {
    // The published build is minified, so the class itself is named something like `e`. Node prints
    // the constructor name next to `name`, which showed uncaught errors as `e [SandboxError]`.
    Object.defineProperty(this, "name", { value: "SandboxError" });
  }
  /** How Node prints the error (console.log, uncaught): `SandboxError [code]: message`, the stack, then the fields. */
  [Symbol.for("nodejs.util.inspect.custom")](
    _depth: number,
    options: InspectOptionsStylized,
    inspect: typeof nodeInspect,
  ): string {
    const stack = this.stack ?? "";
    const frames = stack.indexOf("\n    at ") >= 0 ? stack.slice(stack.indexOf("\n    at ")) : "";

    const fields = {
      code: this.code,
      provider: this.provider,
      sandboxId: this.sandboxId,
      retryable: this.retryable,
      hint: this.hint,
      cause: this.cause,
    };

    return `SandboxError [${this.code}]: ${this.message}${frames} ${inspect(fields, options)}`;
  }
}

/** @internal Whether an error says the path or the sandbox does not exist. */
export function isNotFound(
  error: unknown,
): error is SandboxError & { code: "file_not_found" | "not_found" } {
  return (
    error instanceof SandboxError && (error.code === "file_not_found" || error.code === "not_found")
  );
}

/** @internal Redacts registered secrets from text and errors. */
export class Redactor {
  private values = new Set<string>();
  add(values: Iterable<string>) {
    for (const value of values) if (value) this.values.add(value);
  }
  text(value: string): string {
    for (const secret of [...this.values].sort((a, b) => b.length - a.length))
      value = value.split(secret).join("[REDACTED]");

    return value;
  }
  get secrets() {
    return [...this.values].sort((a, b) => b.length - a.length);
  }
  get maxLength() {
    return Math.max(1, ...[...this.values].map((value) => value.length));
  }
  /** Map any thrown value to a scrubbed SandboxError. */
  error(cause: unknown, provider: string, sandboxId?: string): SandboxError {
    if (cause instanceof SandboxError) {
      // Adapters build these from native text, so scrub them too. Messages keep their lines and length: log tails live there.
      return new SandboxError(scrubCredentials(this.text(cause.message)), {
        code: cause.code,
        retryable: cause.retryable,
        hint: scrubCredentials(this.text(cause.hint)),
        provider,
        // Create paths know no ID yet; keep the one an adapter named, such as a box it could not delete.
        sandboxId: sandboxId ?? cause.sandboxId,
        // Do not preserve arbitrary native objects: they may contain credentials in fields or cycles.
        // Adapter evidence (see evidenceCause) keeps its fields as the JSON in its message.
        cause:
          cause.cause === undefined
            ? undefined
            : scrub(
                this.text(cause.cause instanceof Error ? cause.cause.message : String(cause.cause)),
              ),
      });
    }

    // A raw failure reached the core, usually an SDK or adapter bug. Its scrubbed text is the only clue, so keep it in both places.
    const message = scrub(
      this.text(
        cause instanceof Error ? cause.message : isString(cause) ? cause : "Non-Error value thrown",
      ),
    );

    return new SandboxError(
      `${message}. Provider request failed. Check the provider settings and retry.`,
      {
        code: "provider",
        hint: hints.provider,
        provider,
        sandboxId,
        cause: nativeDetail(cause, (text) => this.text(text)),
      },
    );
  }
}

/** Credential-shaped text in native messages: URLs (which can carry tokens), auth headers, and key=value pairs. */
const credentialPatterns: [RegExp, string][] = [
  [/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]"],
  [
    /(\bauthorization["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n;]+)/gi,
    "$1[REDACTED]",
  ],
  [/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]"],
  [
    /((?:["']?(?:api[-_]?key|access[-_]?token|token|password|secret)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
    "$1[REDACTED]",
  ],
];

function scrubCredentials(text: string): string {
  for (const [pattern, replacement] of credentialPatterns)
    text = text.replace(pattern, replacement);

  return text;
}

/** @internal Removes credential-shaped text (URLs, auth headers, key=value secrets, control characters) and bounds the length. */
export function scrub(text: string): string {
  return scrubCredentials(text)
    .replace(/\p{Cc}+/gu, " ")
    .slice(0, 1000);
}

/**
 * `Name: message` of a native failure, redacted, scrubbed and bounded, with up to two nested causes.
 * Undefined for thrown values that are not Errors, which carry no message to keep.
 */
export function nativeDetail(
  cause: unknown,
  redact: (text: string) => string = (text) => text,
  depth = 0,
): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const text = scrub(redact(cause.message ? `${cause.name}: ${cause.message}` : cause.name));
  const nested = depth < 2 ? nativeDetail(cause.cause, redact, depth + 1) : undefined;

  return nested === undefined ? text : `${text}; caused by ${nested}`;
}

const meanings: Record<ErrorCode, string> = {
  auth: "the credentials are missing or were rejected",
  not_found: "the sandbox does not exist",
  quota: "a provider limit or billing stopped the request",
  unavailable: "the service is down or unreachable",
  unsupported: "the provider cannot do what was asked",
  timeout: "the operation took too long",
  aborted: "the request was aborted",
  outcome_unknown: "the request may or may not have happened",
  process_exited: "the process exited before it was ready",
  port_not_ready: "the port did not become ready",
  edit_not_found: "the text to replace was not found",
  edit_not_unique: "the text to replace matched more than once",
  file_not_found: "the path does not exist",
  invalid_argument: "the provider rejected the request as invalid",
  provider: "the provider returned an unexpected error",
};

/** What {@link describeNative} keeps: text for the message, and the error's cause. */
export interface NativeDescription {
  detail?: string;
  cause?: string;
}

/**
 * What an adapter keeps from a native failure. Only a failure the adapter did not recognize
 * (`code` is `provider`, unless `known` says otherwise) and that carries no `status` keeps its text:
 * that is an SDK bug or a network error, and the text is the only clue. A recognized error type or a response may carry server text that
 * echoes the request, so it keeps only its name and status. `detail` is the kept text, for the message;
 * `cause` is the detail, or else the name and status.
 */
export function describeNative(
  cause: unknown,
  options: { code: ErrorCode; known?: boolean; status?: string; redact?: (text: string) => string },
): NativeDescription {
  const known = options.known ?? options.code !== "provider";

  const detail =
    !known && options.status === undefined ? nativeDetail(cause, options.redact) : undefined;

  const label = [cause instanceof Error ? cause.name : undefined, options.status]
    .filter((part) => part !== undefined)
    .join(" ");

  return { detail, cause: detail ?? (label || undefined) };
}

/**
 * @internal Bounded machine fields an adapter copies from a native failure, each already checked
 * against an allowlist and the secrets it knows. Never a response's message, body, headers or URL;
 * `native` is at most the scrubbed text {@link describeNative} keeps.
 */
export interface NativeEvidence {
  operation?: string;
  status?: number;
  providerCode?: string | number;
  requestId?: string;
  source?: string;
  nativeName?: string;
  native?: string;
  /** Tenki create: the session this call created, and how far it got. */
  admittedByThisCall?: true;
  stage?: string;
  sandboxId?: string;
  state?: string;
  cleanupCode?: ErrorCode;
}

/**
 * @internal The one form an adapter passes {@link NativeEvidence} to the core in: the `cause` of its
 * SandboxError, an Error whose message is the fields as JSON. {@link Redactor.error} reduces every
 * cause to its message, so the JSON is what reaches users; the fields stay readable on the adapter's
 * own error.
 */
export function evidenceCause(evidence: NativeEvidence): Error & NativeEvidence {
  return Object.assign(new Error(JSON.stringify(evidence)), evidence);
}

/** A redact function for values an adapter knows, such as its API key. Empty values are skipped. */
export function redacting(values: Iterable<string | undefined>): (text: string) => string {
  const redactor = new Redactor();

  for (const value of values) if (value) redactor.add([value]);

  return (text) => redactor.text(text);
}

/** Why an adapter request failed, as a clause, never the code itself: the kept detail, or what `code` means. */
export function reason(code: ErrorCode, detail?: string): string {
  return detail ?? meanings[code];
}

/**
 * @internal The shared HTTP status mapper. Provider hooks refine it (a 404 for a missing file, a stale route).
 * A 504 is a timeout; the HTTP client turns it into `outcome_unknown` for a request that may have had an effect.
 */
export function statusCode(status: number): ErrorCode {
  if (status === 400 || status === 422) return "invalid_argument";

  if (status === 401 || status === 403) return "auth";

  if (status === 402 || status === 429) return "quota";

  if (status === 404 || status === 410) return "not_found";

  if (status === 408 || status === 504) return "timeout";

  if (status === 413) return "unsupported";

  if (status >= 500 && status <= 599) return "unavailable";

  return "provider";
}

/** @internal Throws an `invalid_argument` SandboxError. */
export function invalid(message: string): never {
  throw new SandboxError(`${message}. The request is invalid. Check the supplied options.`, {
    code: "invalid_argument",
  });
}
