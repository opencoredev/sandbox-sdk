import { createBriqProvider } from "./provider.js";
import type { BriqOptions, BriqProvider } from "./types.js";

export type { BriqNative, BriqOptions, BriqProvider } from "./types.js";

/** Sandboxes on [Briq](https://briq.cloud), through the optional peer `@briq-cloud/sdk`. */
export function briq(options: BriqOptions = {}): BriqProvider {
  return createBriqProvider(options, () => import("@briq-cloud/sdk"));
}
