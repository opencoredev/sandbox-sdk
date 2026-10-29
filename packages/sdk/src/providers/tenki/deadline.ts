import { deadline as race } from "../../shared/deadline.js";
import { failure } from "./errors.js";

/** The shared deadline, with Tenki's errors. The native client takes the signal as an argument. */
export function deadline<T>(
  action: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return race({
    action,
    timeoutMs,
    signal,
    aborted: () => failure("Request aborted", "aborted"),
    expired: () => failure("Request deadline exceeded", "timeout"),
  });
}
