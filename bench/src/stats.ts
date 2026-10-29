/** Nearest-rank percentiles. Empty distributions have null statistics, never NaN. */
export function statistics(samples: readonly number[]) {
  if (samples.some((value) => !Number.isFinite(value))) throw new Error("Samples must be finite");
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;

  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}
