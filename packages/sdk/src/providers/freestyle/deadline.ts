import { AsyncLocalStorage } from "node:async_hooks";
import { createDeadline, type Deadline } from "../../http.js";
import { failure } from "./errors.js";

/** One deadline follows every request and HTTP 202 poll in an adapter operation. */
export const operationSignal = new AsyncLocalStorage<Deadline>();
export async function deadline<T>(
  action: () => Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw failure("Operation aborted", "aborted");
  const shared = createDeadline(ms, signal);
  const reason = () =>
    shared.parent?.aborted && !shared.timeout.aborted
      ? failure("Operation aborted", "aborted")
      : failure("Native operation timed out", "timeout");
  // Settle on the deadline itself, before a request's own failure (a POST's outcome_unknown) can.
  let rejectAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(reason());
    shared.signal.addEventListener("abort", rejectAbort, { once: true });
    if (shared.signal.aborted) rejectAbort();
  });
  try {
    if (shared.signal.aborted) throw reason();
    return await Promise.race([operationSignal.run(shared, action), stopped]);
  } finally {
    shared.signal.removeEventListener("abort", rejectAbort);
  }
}
