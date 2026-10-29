import { createRailwayProvider, type RailwayOptions, type RailwayProvider } from "./provider.js";

export type { RailwayOptions, RailwayProvider } from "./provider.js";

export function railway(options: RailwayOptions = {}): RailwayProvider {
  return createRailwayProvider(options, () => import("railway"));
}
