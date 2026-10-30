import {
  createSuperserveProvider,
  type SuperserveOptions,
  type SuperserveProvider,
} from "./provider.js";

export type { SuperserveOptions, SuperserveProvider } from "./provider.js";

export function superserve(options: SuperserveOptions = {}): SuperserveProvider {
  return createSuperserveProvider(options, () => import("@superserve/sdk"));
}
