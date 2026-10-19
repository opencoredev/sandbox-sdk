import { statistics } from "./stats.js";
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
export function shuffle<T>(values: readonly T[], seed: number): T[] {
  const result = [...values],
    rng = random(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = result[i],
      b = result[j];
    if (a !== undefined && b !== undefined) {
      result[i] = b;
      result[j] = a;
    }
  }
  return result;
}
export function wilson(success: number, total: number) {
  if (!total) return null;
  const z = 1.959963984540054,
    p = success / total,
    d = 1 + (z * z) / total,
    c = (p + (z * z) / (2 * total)) / d,
    h = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / d;
  return { rate: p, low: Math.max(0, c - h), high: Math.min(1, c + h), total };
}
export function distribution(values: readonly number[], seed = 45) {
  const base = statistics(values),
    mean = base.mean;
  if (mean === null) return { ...base, stddev: null, p50CI: null, meanCI: null };
  const rng = random(seed),
    medians: number[] = [],
    means: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const sample = Array.from(
      { length: values.length },
      () => values[Math.floor(rng() * values.length)] ?? 0,
    );
    const s = statistics(sample);
    medians.push(s.p50 ?? 0);
    means.push(s.mean ?? 0);
  }
  const interval = (xs: number[]) => {
    xs.sort((a, b) => a - b);
    return { low: xs[49] ?? 0, high: xs[1949] ?? 0 };
  };
  return {
    ...base,
    stddev: Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length),
    p50CI: interval(medians),
    meanCI: interval(means),
  };
}
