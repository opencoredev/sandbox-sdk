import { failure } from "./errors.js";

/** Race as well as abort: an unresponsive transport must not hold the caller. */
export async function deadline<T>(
  action: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let cancel = () => {};

  const stopped = new Promise<never>((_, reject) => {
    cancel = () => {
      const error = failure(
        signal?.aborted ? "Request aborted" : "Request deadline exceeded",
        signal?.aborted ? "aborted" : "timeout",
      );

      controller.abort(error);
      reject(error);
    };
  });

  const timer = setTimeout(cancel, timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    if (signal?.aborted) cancel();

    return await Promise.race([
      stopped,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();

        return action(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
