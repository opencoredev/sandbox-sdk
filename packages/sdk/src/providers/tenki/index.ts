import {
  luxor,
  type LuxorCapability,
  type LuxorOptions,
  type LuxorProvider,
} from "../luxor/index.js";

/** @deprecated Luxor Agent Cloud was called Tenki. Use `LuxorCapability` from `@opencoredev/sandbox-sdk/luxor`. */
export type TenkiCapability = LuxorCapability;

/** @deprecated Luxor Agent Cloud was called Tenki. Use `LuxorOptions` from `@opencoredev/sandbox-sdk/luxor`. */
export type TenkiOptions = LuxorOptions;

/** @deprecated Luxor Agent Cloud was called Tenki. Use `LuxorProvider` from `@opencoredev/sandbox-sdk/luxor`. */
export type TenkiProvider = LuxorProvider;

/** @deprecated Luxor Agent Cloud was called Tenki. Use `luxor()` from `@opencoredev/sandbox-sdk/luxor`; it is the same adapter. */
export const tenki: (options?: TenkiOptions) => TenkiProvider = luxor;
