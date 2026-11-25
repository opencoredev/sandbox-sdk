import { createBuddyProvider, type BuddyOptions, type BuddyProvider } from "./provider.js";

export type {
  BuddyCapability,
  BuddyNative,
  BuddyOptions,
  BuddyPlane,
  BuddyProvider,
  BuddyRegion,
} from "./provider.js";

/** Buddy (https://buddy.works) Sandboxes through its REST API: no other package to install. */
export function buddy(options: BuddyOptions = {}): BuddyProvider {
  return createBuddyProvider(options);
}
