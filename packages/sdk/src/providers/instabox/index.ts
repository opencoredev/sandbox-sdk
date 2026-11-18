import { createInstaboxProvider, type InstaboxOptions, type InstaboxProvider } from "./provider.js";

export type {
  InstaboxCapability,
  InstaboxNative,
  InstaboxOptions,
  InstaboxProvider,
} from "./provider.js";

/** Instabox (https://instabox.sh) through its REST API: no other package to install. */
export function instabox(options: InstaboxOptions = {}): InstaboxProvider {
  return createInstaboxProvider(options);
}
