import raw from "@/data/benchmark.json";

import type { Unit } from "@/lib/format";

/** The generated benchmark data. Regenerate with `bun run data` after `bun bench merge`. */
export const data = raw;

export type Metric = (typeof data.metrics)[number] & { unit: Unit; better: "lower" | "higher" };
export type MetricValue = Metric["values"][number];
export type Provider = (typeof data.providers)[number];

export function metric(id: string): Metric {
  const found = data.metrics.find((m) => m.id === id);
  if (!found) throw new Error(`Unknown metric ${id}`);
  // The generator only writes these unit and direction strings (bench/src/site-data.ts).
  return found as Metric;
}

export const cloudProviders = data.providers.filter((p) => p.id !== "local");
