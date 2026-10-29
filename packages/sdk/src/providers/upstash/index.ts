import {
  createUpstashProvider,
  type UpstashBoxOptions,
  type UpstashEphemeralOptions,
  type UpstashEphemeralProvider,
  type UpstashOptions,
  type UpstashProvider,
} from "./provider.js";

export type {
  UpstashBoxOptions,
  UpstashCapability,
  UpstashEphemeralCapability,
  UpstashEphemeralOptions,
  UpstashEphemeralProvider,
  UpstashOptions,
  UpstashProvider,
} from "./provider.js";

export function upstash(options: UpstashEphemeralOptions): UpstashEphemeralProvider;
export function upstash(options?: UpstashBoxOptions): UpstashProvider;
/** Mode unknown at compile time: pause is not promised. */
export function upstash(options: UpstashOptions): UpstashEphemeralProvider;
export function upstash(options: UpstashOptions = {}): UpstashProvider | UpstashEphemeralProvider {
  return createUpstashProvider(options, () => import("@upstash/box"));
}
