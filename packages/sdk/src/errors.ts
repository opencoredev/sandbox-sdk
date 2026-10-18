export type ErrorCode = "auth" | "not_found" | "quota" | "unavailable" | "unsupported" | "timeout" | "aborted" | "outcome_unknown" | "process_exited" | "port_not_ready" | "edit_not_found" | "edit_not_unique" | "file_not_found" | "invalid_argument" | "provider";
export interface ErrorOptions {
  code: ErrorCode;
  provider?: string;
  sandboxId?: string;
  retryable?: boolean;
  hint?: string;
  cause?: unknown;
}
export class SandboxError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint: string;
  readonly provider: string;
  readonly sandboxId?: string;
  constructor(message: string, options: ErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "SandboxError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.hint = options.hint ?? "Check the request and try again.";
    this.provider = options.provider ?? "unknown";
    this.sandboxId = options.sandboxId;
  }
}
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
      code: options.code, retryable: options.retryable, hint: this.text(options.hint ?? "Check the provider and retry."), provider, sandboxId,
      // Do not preserve arbitrary native objects: they may contain credentials in fields or cycles.
      cause: error instanceof Error && error.cause !== undefined ? this.text(String(error.cause instanceof Error ? error.cause.message : error.cause)) : undefined,
    });
  }
}
export function invalid(message: string): never {
  throw new SandboxError(`${message}. The request is invalid. Check the supplied options.`, { code: "invalid_argument" });
}
