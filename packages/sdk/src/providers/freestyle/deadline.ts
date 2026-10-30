import { AsyncLocalStorage } from "node:async_hooks";
import { deadline as race } from "../../shared/deadline.js";
import { failure } from "./errors.js";

/** One signal/deadline follows every HTTP 202 poll in an SDK operation. */
export const operationSignal = new AsyncLocalStorage<AbortSignal>();

/** The shared deadline, with Freestyle's errors. The native client cannot take a
 * signal, so its fetch reads it from {@link operationSignal} instead.
 */
export function deadline<T>(
  action: () => Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  return race({
    action: (operation) => operationSignal.run(operation, action),
    timeoutMs: ms,
    signal,
    aborted: () => failure("Operation aborted", "aborted"),
    expired: () => failure("Native operation timed out", "timeout"),
  });
}
