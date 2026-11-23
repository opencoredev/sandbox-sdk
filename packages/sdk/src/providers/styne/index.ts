import { createStyneProvider, type StyneOptions, type StyneProvider } from "./provider.js";

export type {
  StyneCapability,
  StyneClientSdk,
  StyneNative,
  StyneOptions,
  StynePlane,
  StyneProvider,
  StyneSandboxSdk,
  StyneSdkModule,
} from "./provider.js";

/** Styne (https://styne.ai) through its REST API: no other package to install. */
export function styne(options: StyneOptions = {}): StyneProvider {
  return createStyneProvider(options);
}
