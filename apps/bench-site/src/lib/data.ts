import raw from "@/data/benchmark.json";

import type { Unit } from "@/lib/format";
import { isProviderId } from "@/lib/providers";
import type { ProviderId } from "@/lib/providers";

/**
 * The generated benchmark data, without the local Docker baseline: the site
 * only compares providers someone can sign up for. Regenerate with
 * `bun run data` after `bun bench merge`.
 */
type RawProvider = (typeof raw.providers)[number];
type RawMetric = (typeof raw.metrics)[number];
type RawValue = RawMetric["values"][number];

export type Provider = Omit<RawProvider, "id" | "pauseSplit"> & {
  id: ProviderId;
  // Null in data generated before pause and resume were recorded apart (bench/src/site-data.ts pauseSplit).
  pauseSplit: { pause: number; resume: number; n: number } | null;
};
export type MetricValue = Omit<RawValue, "provider"> & { provider: ProviderId };
export type Metric = Omit<RawMetric, "values" | "unit" | "better"> & {
  // The generator only writes these unit and direction strings (bench/src/site-data.ts).
  unit: Unit;
  better: "lower" | "higher";
  values: MetricValue[];
};

const hasProviderId = <T extends { id: string }>(p: T): p is T & { id: ProviderId } => isProviderId(p.id);
const hasProvider = <T extends { provider: string }>(v: T): v is T & { provider: ProviderId } =>
  isProviderId(v.provider);
const isUnit = (u: string): u is Unit => ["s", "ms", "ops/s", "MB/s", "IOPS"].includes(u);
const isBetter = (b: string): b is Metric["better"] => b === "lower" || b === "higher";

export const providers: Provider[] = raw.providers.filter(hasProviderId);

const metrics: Metric[] = raw.metrics.flatMap((m) =>
  isUnit(m.unit) && isBetter(m.better)
    ? [{ ...m, unit: m.unit, better: m.better, values: m.values.filter(hasProvider) }]
    : [],
);

export function metric(id: string): Metric {
  const found = metrics.find((m) => m.id === id);
  if (!found) throw new Error(`Unknown metric ${id}`);
  return found;
}

export const provider = (id: ProviderId) => providers.find((p) => p.id === id);

export const coldSamples: Partial<Record<ProviderId, readonly number[]>> = Object.fromEntries(
  Object.entries(raw.coldSamples).filter(([id]) => isProviderId(id)),
);

/** Every timed operation against the providers on the page, failures included. */
export const timedOperations = providers.reduce(
  (sum, p) => sum + p.reliability.successes + p.reliability.failures,
  0,
);

export const runWindow = raw.window;
export const runs = raw.runs;
