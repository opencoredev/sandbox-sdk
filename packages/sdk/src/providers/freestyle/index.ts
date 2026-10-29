import {
  createFreestyleProvider,
  type FreestyleOptions,
  type FreestyleProvider,
} from "./provider.js";

export type { FreestyleOptions, FreestyleProvider } from "./provider.js";

export function freestyle(options: FreestyleOptions = {}): FreestyleProvider {
  return createFreestyleProvider(options, () => import("freestyle"));
}
