import { createTenkiProvider, type TenkiOptions, type TenkiProvider } from "./provider.js";

export type { TenkiCapability, TenkiOptions, TenkiProvider } from "./provider.js";

export function tenki(options: TenkiOptions = {}): TenkiProvider {
  return createTenkiProvider(options, () => import("@tenkicloud/sandbox"));
}
