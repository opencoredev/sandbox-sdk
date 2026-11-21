import { SandboxError, invalid } from "./errors.js";

/** Options for {@link withRetry}. */
export interface RetryOptions {
  /** Attempts in total, including the first. Default: 3. */
  attempts?: number;
  /** The backoff before the first retry. It doubles for each later retry, with full jitter. Default: 500. */
  baseDelayMs?: number;
  /** The longest wait between attempts, including one the provider asked for. Default: 30000. */
  maxDelayMs?: number;
  /** Stops retrying. A wait in progress ends at once and `withRetry` throws `aborted`. */
  signal?: AbortSignal;
  /**
   * Whether to retry after this error. Default: `error.retryable`, which is `false` for
   * `outcome_unknown`, so a write that may have landed is never repeated blindly.
   */
  retryIf?: (error: SandboxError, attempt: number) => boolean;
}

/**
 * Runs `action` and retries it when it throws a retryable {@link SandboxError}. Each wait is the
 * longer of the jittered exponential backoff and the provider's `retryAfterMs`, capped at
 * `maxDelayMs`. Anything that is not a SandboxError is rethrown at once, as is the last error.
 *
 * ```ts
 * const box = await withRetry(() => createSandbox(e2b(), { key: "user:123" }));
 * ```
 */
export async function withRetry<T>(
  action: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const retryIf = options.retryIf ?? ((error: SandboxError) => error.retryable);

  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    ![baseDelayMs, maxDelayMs].every((value) => Number.isFinite(value) && value >= 0)
  )
    invalid("withRetry needs attempts of at least 1 and finite, non-negative delays");

  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted)
      throw new SandboxError("Retry aborted. The signal was cancelled.", { code: "aborted" });

    try {
      return await action(attempt);
    } catch (error) {
      if (!(error instanceof SandboxError) || attempt >= attempts || !retryIf(error, attempt))
        throw error;

      const backoff = Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));

      await pause(Math.min(maxDelayMs, Math.max(backoff, error.retryAfterMs ?? 0)), options.signal);
    }
  }
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, ms);

    signal?.addEventListener("abort", done, { once: true });

    if (signal?.aborted) done();
  });
}
