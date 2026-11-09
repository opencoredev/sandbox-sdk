import { requestedSize } from "./allocation.js";
import { resources, type Fingerprint } from "./fingerprint.js";
import { fallbackResources, pricing, type Resources } from "./pricing.js";
import type { Size } from "./v2-config.js";

/**
 * Resources a cost estimate prices, and how they relate to the bill. `exact`: the requested
 * allocation of a provider that bills it. `lower`: a request-billed provider's minimum, when usage
 * above it is also billed. `observed`: what the guest reported, for every other provider.
 */
export interface PricedResources {
  resources: Resources;
  bound: "exact" | "lower" | "observed";
}

/** The resources to price for one sandbox. A request-billed provider never prices the guest's view. */
export function pricedResources(
  provider: string,
  fp: Fingerprint | null,
  size: Size | null,
): PricedResources | null {
  const price = pricing[provider];

  if (price?.requestBilled) {
    // Disk is not billed separately by request-billed providers.
    if (size !== null)
      return { resources: { ...requestedSize(provider, size), diskGiB: 0 }, bound: "exact" };

    return { resources: { ...price.requestBilled.minimum, diskGiB: 0 }, bound: "lower" };
  }

  if (fp) return { resources: resources(fp), bound: "observed" };

  return price?.fixed ? { resources: price.fixed, bound: "exact" } : null;
}

/**
 * Resources the admission guard reserves for one iteration. A request-billed default can burst
 * above its request, so it reserves the conservative fallback rather than the lower bound.
 */
export function reservationResources(
  provider: string,
  fp: Fingerprint | null,
  size: Size | null,
): Resources {
  // Unchanged for every other provider: the guest's view, else the conservative fallback.
  if (!pricing[provider]?.requestBilled) return fp ? resources(fp) : fallbackResources;
  const priced = pricedResources(provider, fp, size);

  if (!priced || priced.bound === "lower") return { ...fallbackResources, diskGiB: 0 };

  return priced.resources;
}
