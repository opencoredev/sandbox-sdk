import { createTenkiProvider, type TenkiOptions, type TenkiProvider } from "./provider.js";

export { resolveConfig } from "./provider.js";

export type {
  TenkiCapability,
  TenkiConfig,
  TenkiConnection,
  TenkiOptions,
  TenkiProvider,
} from "./provider.js";

export function tenki(options: TenkiOptions = {}): TenkiProvider {
  return createTenkiProvider(options, () => import("@luxorai/sandbox"));
}
