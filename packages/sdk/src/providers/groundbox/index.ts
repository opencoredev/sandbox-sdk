import {
  createGroundboxProvider,
  type GroundboxOptions,
  type GroundboxProvider,
} from "./provider.js";

export type {
  GroundboxCapability,
  GroundboxClientSdk,
  GroundboxExtension,
  GroundboxNative,
  GroundboxOptions,
  GroundboxProvider,
  GroundboxSandboxSdk,
  GroundboxSdkModule,
} from "./provider.js";

export type { GroundboxPlane } from "./api.js";

/** Groundbox (https://groundbox.dev) through its REST API: no other package to install. */
export function groundbox(options: GroundboxOptions = {}): GroundboxProvider {
  return createGroundboxProvider(options);
}
