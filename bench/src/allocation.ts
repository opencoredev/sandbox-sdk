import type { Sample } from "./v2-model.js";
import { resources, verifyRestoredResources } from "./fingerprint.js";
import { provisionedAllocation } from "./provisioned-allocations.js";
import { pricing } from "./pricing.js";
import { isSizePreset, type Size } from "./v2-config.js";
import { distribution } from "./v2-stats.js";

/** Each provider's named size presets. */
interface SizePresets {
  readonly [provider: string]: Record<
    "small" | "medium" | "large",
    { cpu: number; memoryGiB: number }
  >;
}

const presets: SizePresets = {
  upstash: {
    small: { cpu: 2, memoryGiB: 4 },
    medium: { cpu: 4, memoryGiB: 8 },
    large: { cpu: 8, memoryGiB: 16 },
  },
  boat: {
    small: { cpu: 2, memoryGiB: 4 },
    medium: { cpu: 4, memoryGiB: 8 },
    large: { cpu: 8, memoryGiB: 16 },
  },
  boxd: {
    small: { cpu: 1, memoryGiB: 4 },
    medium: { cpu: 2, memoryGiB: 8 },
    large: { cpu: 4, memoryGiB: 16 },
  },
  // The Modal adapter's presets, each pinning request and limit.
  modal: {
    small: { cpu: 1, memoryGiB: 2 },
    medium: { cpu: 2, memoryGiB: 4 },
    large: { cpu: 4, memoryGiB: 8 },
  },
  // The adapter's presets; Vercel gives 2 GB of memory per vCPU.
  vercel: {
    small: { cpu: 1, memoryGiB: 2 },
    medium: { cpu: 2, memoryGiB: 4 },
    large: { cpu: 4, memoryGiB: 8 },
  },
};

const standardPresets = {
  small: { cpu: 1, memoryGiB: 1 },
  medium: { cpu: 2, memoryGiB: 4 },
  large: { cpu: 4, memoryGiB: 8 },
};

/** The CPU and memory a `--size` request asks the provider for. */
export function requestedSize(provider: string, size: Size): { cpu: number; memoryGiB: number } {
  return isSizePreset(size)
    ? (presets[provider] ?? standardPresets)[size]
    : { cpu: size.cpu, memoryGiB: size.memoryMb / 1024 };
}

/**
 * What a request-billed provider (Modal) bills for one sandbox: the requested size, exactly, or
 * without a size the minimum request, a lower bound because usage above it is billed too. Null for
 * every other provider. The guest's own view is never used.
 */
export function requestBilledCompute(
  provider: string,
  size: Size | null,
): { compute: { cpu: number; memoryGiB: number }; bound: "exact" | "lower" } | null {
  const billed = pricing[provider]?.requestBilled;

  if (!billed) return null;

  return size === null
    ? { compute: { ...billed.minimum }, bound: "lower" }
    : { compute: requestedSize(provider, size), bound: "exact" };
}

type AllocationRow = Pick<
  Sample,
  "provider" | "scenario" | "fingerprint" | "requestedSize" | "template"
>;

/** Price explicit requests only after every observed allocation agrees with them. */
export function allocationEvidence(samples: readonly AllocationRow[], provider: string) {
  const rows = samples.filter((s) => s.provider === provider);
  const first = rows[0];
  const size = first?.requestedSize ?? null;
  const requested = { size, template: first?.template ?? null };
  const provisioned = size === null ? provisionedAllocation(provider, requested.template) : null;

  const requestedCompute =
    size === null
      ? provisioned && { cpu: provisioned.cpu, memoryGiB: provisioned.memoryGiB }
      : requestedSize(provider, size);

  const observed = rows
    .filter((s) => ["fingerprint", "restore-fingerprint"].includes(s.scenario))
    .flatMap((s) => (s.fingerprint ? [resources(s.fingerprint)] : []));

  const measured = [...new Map(observed.map((r) => [JSON.stringify(r), r])).values()];
  const mismatches: string[] = [];

  const source =
    rows.find((s) => s.scenario === "fingerprint" && s.fingerprint)?.fingerprint ?? null;

  const restoredMismatch = rows.some(
    (s) =>
      s.scenario === "restore-fingerprint" &&
      s.fingerprint &&
      verifyRestoredResources(source, s.fingerprint, { compareDisk: provider !== "boat" })
        .matches === false,
  );

  if (restoredMismatch) mismatches.push("Restored allocation differs from source");

  const multipleRequests =
    new Set(rows.map((s) => JSON.stringify([s.requestedSize ?? null, s.template ?? null]))).size >
    1;

  if (multipleRequests) mismatches.push("Multiple requested allocations");

  if (requestedCompute && observed.some((r) => r.cpu !== requestedCompute.cpu))
    mismatches.push("Measured vCPU differs from requested allocation");

  if (
    requestedCompute &&
    observed.some(
      (r) =>
        r.memoryGiB > requestedCompute.memoryGiB ||
        r.memoryGiB <
          requestedCompute.memoryGiB - Math.max(requestedCompute.memoryGiB * 0.05, 96 / 1024),
    )
  )
    mismatches.push(
      "Measured memory exceeds provisioned RAM or falls below it by more than max(5%, 96 MiB)",
    );

  if (new Set(observed.map((r) => r.cpu)).size > 1)
    mismatches.push("Measured vCPU varies across fingerprints");
  const cpu = observed[0]?.cpu;
  const memoryGiB = distribution(observed.map((r) => r.memoryGiB)).p50;
  const measuredCompute = cpu === undefined || memoryGiB === null ? null : { cpu, memoryGiB };

  const billed = requestBilledCompute(provider, size);

  // Request-billed providers price the request whatever the guest shows: Modal's default guest
  // shows the host's memory, which differs between a source and its restore. Guest mismatches stay
  // as caveats; only a request that varies leaves no price. Every other provider prices the
  // verified or measured allocation.
  const pricingAllocation = billed
    ? multipleRequests
      ? null
      : billed.compute
    : mismatches.length
      ? null
      : requested.template && !requestedCompute
        ? null
        : requestedCompute && observed.length
          ? requestedCompute
          : measuredCompute;

  /** How `pricingAllocation` relates to the bill: `lower` is a lower bound, never an estimate. */
  const pricingBound: "exact" | "lower" | "observed" | null =
    pricingAllocation === null
      ? null
      : billed
        ? billed.bound
        : requestedCompute && observed.length
          ? "exact"
          : "observed";

  return {
    requested,
    requestedCompute,
    provisioned,
    measured,
    verified: mismatches.length ? false : observed.length && requestedCompute ? true : null,
    mismatches,
    pricingAllocation,
    pricingBound,
    equalSpec:
      !restoredMismatch &&
      observed.length > 0 &&
      observed.every((r) => r.cpu === 4 && r.memoryGiB >= 8 * 0.95 && r.memoryGiB <= 8 * 1.05),
  };
}
