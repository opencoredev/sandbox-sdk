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
export type ErrorCode = "auth" | "not_found" | "quota" | "unavailable" | "unsupported" | "timeout" | "aborted" | "outcome_unknown" | "process_exited" | "port_not_ready" | "edit_not_found" | "edit_not_unique" | "file_not_found" | "invalid_argument" | "provider";
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
  process_exited: "Read the exit code and log tail in the message, fix the command, and start it again.",
  port_not_ready: "Check that the server listens on 0.0.0.0 and the right port, then read its logs.",
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
}
/** @internal Redacts registered secrets from text and errors. */
export class Redactor {
  private values = new Set<string>();
  add(values: Iterable<string>) { for (const value of values) if (value) this.values.add(value); }
  text(value: string): string {
    for (const secret of [...this.values].sort((a, b) => b.length - a.length)) value = value.split(secret).join("[REDACTED]");
    return value;
  }
  get secrets() { return [...this.values].sort((a, b) => b.length - a.length); }
  get maxLength() { return Math.max(1, ...[...this.values].map(value => value.length)); }
  error(error: unknown, provider: string, sandboxId?: string): SandboxError {
    const detail = error instanceof Error ? error.message : String(error);
    const message = error instanceof SandboxError ? detail : `${detail}. Provider request failed. Check the provider settings and retry.`;
    const options: ErrorOptions = error instanceof SandboxError ? error : { code: "provider" };
    return new SandboxError(this.text(message), {
      code: options.code, retryable: options.retryable, hint: this.text(options.hint ?? hints[options.code] ?? hints.provider), provider, sandboxId,
      // Do not preserve arbitrary native objects: they may contain credentials in fields or cycles.
      cause: error instanceof Error && error.cause !== undefined ? this.text(String(error.cause instanceof Error ? error.cause.message : error.cause)) : undefined,
    });
  }
}
/** @internal Throws an `invalid_argument` SandboxError. */
export function invalid(message: string): never {
  throw new SandboxError(`${message}. The request is invalid. Check the supplied options.`, { code: "invalid_argument" });
}
