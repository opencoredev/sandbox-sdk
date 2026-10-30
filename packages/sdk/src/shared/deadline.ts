import type { SandboxError } from "../errors.js";

export interface Deadline<T> {
  /** Receives a signal that aborts when the deadline passes or `signal` aborts. */
  action: (signal: AbortSignal) => PromiseLike<T>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** The provider's own errors, so messages keep its name and advice. */
  aborted: () => SandboxError;
  expired: () => SandboxError;
}

/** Abort and race: an unresponsive transport that ignores the signal must not hold the caller. */
export async function deadline<T>(options: Deadline<T>): Promise<T> {
  const { action, timeoutMs, signal } = options;

  if (signal?.aborted) throw options.aborted();
  const controller = new AbortController();
  const abort = () => controller.abort(options.aborted());
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(options.expired()), timeoutMs);
  let rejectStopped = () => {};

  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectStopped, { once: true });
  });

  try {
    return await Promise.race([stopped, action(controller.signal)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectStopped);
  }
}
