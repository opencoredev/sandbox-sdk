import { createLuxorProvider, type LuxorOptions, type LuxorProvider } from "./provider.js";

export type { LuxorCapability, LuxorOptions, LuxorProvider } from "./provider.js";

export function luxor(options: LuxorOptions = {}): LuxorProvider {
  return createLuxorProvider(options, () => import("@luxorai/sandbox"));
}
