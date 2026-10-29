import { createE2BProvider, type E2BOptions, type E2BProvider } from "./provider.js";

export type { E2BOptions, E2BProvider } from "./provider.js";

/** E2B's template fixes CPU, RAM and disk; explicit size requests fail closed.
 * Cloud modules are loaded only on first provider I/O, never by importing core.
 */
export function e2b(options: E2BOptions = {}): E2BProvider {
  return createE2BProvider(options, () => import("e2b"));
}
