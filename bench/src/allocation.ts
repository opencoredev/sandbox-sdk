import type { Sample } from "./v2-model.js";
import { resources, verifyRestoredResources } from "./fingerprint.js";
import { provisionedAllocation } from "./provisioned-allocations.js";
import { distribution } from "./v2-stats.js";

const presets: Record<
  string,
  Record<"small" | "medium" | "large", { cpu: number; memoryGiB: number }>
> = {
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
};

const standardPresets = {
  small: { cpu: 1, memoryGiB: 1 },
  medium: { cpu: 2, memoryGiB: 4 },
  large: { cpu: 4, memoryGiB: 8 },
};

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
      : typeof size === "string"
        ? (presets[provider] ?? standardPresets)[size]
        : { cpu: size.cpu, memoryGiB: size.memoryMb / 1024 };

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

  if (
    new Set(rows.map((s) => JSON.stringify([s.requestedSize ?? null, s.template ?? null]))).size > 1
  )
    mismatches.push("Multiple requested allocations");

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

  const pricingAllocation =
    mismatches.length || (requested.template && !requestedCompute)
      ? null
      : requestedCompute && observed.length
        ? requestedCompute
        : measuredCompute;

  return {
    requested,
    requestedCompute,
    provisioned,
    measured,
    verified: mismatches.length ? false : observed.length && requestedCompute ? true : null,
    mismatches,
    pricingAllocation,
    equalSpec:
      !restoredMismatch &&
      observed.length > 0 &&
      observed.every((r) => r.cpu === 4 && r.memoryGiB >= 8 * 0.95 && r.memoryGiB <= 8 * 1.05),
  };
}
