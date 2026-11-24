import {
  createMicrosandboxProvider,
  type MicrosandboxOptions,
  type MicrosandboxProvider,
} from "./provider.js";

export type {
  MicrosandboxCapability,
  MicrosandboxClientSdk,
  MicrosandboxComputeType,
  MicrosandboxHooks,
  MicrosandboxNative,
  MicrosandboxOptions,
  MicrosandboxPlane,
  MicrosandboxProvider,
  MicrosandboxSandboxSdk,
  MicrosandboxSdkModule,
} from "./provider.js";

/**
 * Microsandbox Cloud (https://microsandbox.dev) microVM sandboxes. The control plane is plain REST; commands
 * and files go through the optional peer `microsandbox`, which `create` loads before allocating anything.
 */
export function microsandbox(options: MicrosandboxOptions = {}): MicrosandboxProvider {
  return createMicrosandboxProvider(options, () => import("microsandbox"));
}
