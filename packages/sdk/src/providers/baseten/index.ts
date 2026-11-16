import { createBasetenProvider, type BasetenOptions, type BasetenProvider } from "./provider.js";

export type { BasetenNative, BasetenOptions, BasetenProvider } from "./provider.js";

export function baseten(options: BasetenOptions = {}): BasetenProvider {
  return createBasetenProvider(options, () => import("@basetenlabs/sandbox"));
}
