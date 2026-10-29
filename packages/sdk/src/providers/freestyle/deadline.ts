import { AsyncLocalStorage } from "node:async_hooks";
import { failure } from "./errors.js";

/** One signal/deadline follows every HTTP 202 poll in an SDK operation. */
export const operationSignal = new AsyncLocalStorage<AbortSignal>();

export async function deadline<T>(
  action: () => Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw failure("Operation aborted", "aborted");
  const controller = new AbortController();
  const abort = () => controller.abort(failure("Operation aborted", "aborted"));
  signal?.addEventListener("abort", abort, { once: true });

  const timer = setTimeout(
    () => controller.abort(failure("Native operation timed out", "timeout")),
    ms,
  );

  let rejectAbort = () => {};

  const stopped = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });

    if (controller.signal.aborted) rejectAbort();
  });

  try {
    if (controller.signal.aborted) throw controller.signal.reason;

    return await Promise.race([operationSignal.run(controller.signal, action), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}
