import { createArchilProvider, type ArchilOptions, type ArchilProvider } from "./provider.js";

export type { ArchilNative, ArchilOptions, ArchilProvider } from "./provider.js";

export function archil(options: ArchilOptions = {}): ArchilProvider {
  return createArchilProvider(options, () => import("disk"));
}
