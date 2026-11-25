import { createMaritimeProvider, type MaritimeOptions, type MaritimeProvider } from "./provider.js";

export type {
  MaritimeCapability,
  MaritimeClientSdk,
  MaritimeNative,
  MaritimeOptions,
  MaritimePlane,
  MaritimeProvider,
  MaritimeSandboxSdk,
  MaritimeSdkModule,
} from "./provider.js";

/** Maritime (https://maritime.sh) virtual machines through its REST API: no other package to install. */
export function maritime(options: MaritimeOptions = {}): MaritimeProvider {
  return createMaritimeProvider(options);
}
