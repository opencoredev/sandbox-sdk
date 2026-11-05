/**
 * Simultaneous comparisons of cost per completed task across providers, with the batch as the
 * independent unit. Batches pair up across providers (every provider ran the same profile and
 * track in the same slot), so every resample or permutation acts on whole batches for all
 * providers at once.
 *
 * Three candidate procedures, chosen between by the coverage simulation (`coverage.ts`):
 * - centred max-absolute-deviation bootstrap: c = 95th percentile over replicates of
 *   max over pairs |d*_ij - d_ij|; every pair gets d_ij ± c;
 * - studentised max-deviation bootstrap: the same with each deviation divided by its
 *   delete-one-batch jackknife standard error; pair intervals are d_ij ± c_t · se_ij;
 * - batch sign-flip permutation: within a batch, swap the two providers' totals; single-step
 *   Westfall-Young min-p over all pairs gives family-wise adjusted p-values (no intervals).
 *
 * A provider with zero completions in a replicate has infinite cost there, so its deviations are
 * infinite: missing completions widen every interval rather than vanish. This file is committed
 * before any provider result is examined.
 */
import type { AttemptRecord } from "./attempt-record.js";

/** Published seed for every bootstrap and permutation draw in a release. */
export const BOOTSTRAP_SEED = 20_261_202;

export const BOOTSTRAP_REPLICATES = 10_000;

export const CONFIDENCE_LEVEL = 0.95;

/** Up to this many batches, all 2^B sign flips are enumerated; above it they are sampled. */
const EXACT_FLIP_BATCHES = 12;

const SAMPLED_FLIPS = 4096;

export const procedures = [
  "centred-max-deviation",
  "studentised-max-deviation",
  "sign-flip-permutation",
] as const;

export type Procedure = (typeof procedures)[number];

/** One provider's totals in one batch: all attempts' cost, failures included, and completions. */
export interface BatchTotal {
  readonly costUSD: number;
  readonly attempts: number;
  readonly completions: number;
}

/** A provider's batch totals, index-aligned with every other provider's in the comparison. */
export interface ProviderBatches {
  readonly provider: string;
  readonly batches: readonly BatchTotal[];
}

export interface PairComparison {
  readonly a: string;
  readonly b: string;
  /** Cost per completed task of a minus b, in USD. */
  readonly difference: number;
  readonly interval: { readonly low: number; readonly high: number } | null;
  readonly adjustedP: number | null;
  /** The cheaper provider when the procedure separates the pair, else null. */
  readonly favours: string | null;
}

export interface ComparisonOptions {
  readonly procedure: Procedure;
  readonly replicates?: number;
  readonly seed?: number;
  readonly level?: number;
  /** Sign-flip permutations to sample when there are too many batches to enumerate. */
  readonly flips?: number;
}

/** sfc32 seeded through splitmix32: fast, 128-bit state, reproducible from one published seed. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;

  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;

    return (z ^ (z >>> 16)) >>> 0;
  };

  let a = next(),
    b = next(),
    c = next(),
    d = next();

  return () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;

    return t / 4294967296;
  };
}

/** Upper nearest-rank quantile; Infinity sorts last and is a valid answer. */
export function upperQuantile(values: Float64Array, level: number): number {
  const sorted = Float64Array.from(values).sort();

  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(level * sorted.length) - 1))] ?? 0
  );
}

/** Total cost over total completions; Infinity with zero completions. */
export function costPerCompleted(batches: readonly BatchTotal[]): number {
  let cost = 0,
    done = 0;

  for (const batch of batches) {
    cost += batch.costUSD;
    done += batch.completions;
  }

  return done > 0 ? cost / done : Infinity;
}

/** Group attempts into index-aligned batch totals. Every provider must have every batch. */
export function pairedBatches(
  groups: readonly {
    readonly provider: string;
    readonly attempts: readonly AttemptRecord[];
    /** Reported cost of each attempt in the denominator, by attempt ID. */
    readonly costUSD: ReadonlyMap<string, number>;
  }[],
): ProviderBatches[] {
  const counted = groups.map((g) => ({
    provider: g.provider,
    costUSD: g.costUSD,
    attempts: g.attempts.filter((a) => a.completion.kind !== "not-run"),
  }));

  const numbers = [...new Set(counted.flatMap((g) => g.attempts.map((a) => a.batch)))].sort(
    (x, y) => x - y,
  );

  return counted.map((group) => ({
    provider: group.provider,
    batches: numbers.map((batch) => {
      const inBatch = group.attempts.filter((a) => a.batch === batch);

      if (inBatch.length === 0)
        throw new Error(`${group.provider} has no attempt in batch ${batch}`);
      let costUSD = 0;

      for (const attempt of inBatch) {
        const cost = group.costUSD.get(attempt.attemptId);

        if (cost === undefined) throw new Error(`No cost for attempt ${attempt.attemptId}`);
        costUSD += cost;
      }

      return {
        costUSD,
        attempts: inBatch.length,
        completions: inBatch.filter((a) => a.completion.kind === "completed").length,
      };
    }),
  }));
}

/** Dense provider-by-batch arrays for the inner loops. */
interface Matrix {
  readonly providers: number;
  readonly batches: number;
  readonly cost: Float64Array;
  readonly done: Float64Array;
}

function toMatrix(input: readonly ProviderBatches[]): Matrix {
  const batches = input[0]?.batches.length ?? 0;

  if (input.some((p) => p.batches.length !== batches))
    throw new Error("Every provider needs the same batches");
  const cost = new Float64Array(input.length * batches);
  const done = new Float64Array(input.length * batches);

  input.forEach((p, i) =>
    p.batches.forEach((b, k) => {
      cost[i * batches + k] = b.costUSD;
      done[i * batches + k] = b.completions;
    }),
  );

  return { providers: input.length, batches, cost, done };
}

function pairsOf(n: number): [number, number][] {
  const pairs: [number, number][] = [];

  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);

  return pairs;
}

/** Difference that is infinite whenever either side is, never NaN. */
function gap(x: number, y: number): number {
  return Number.isFinite(x) && Number.isFinite(y) ? x - y : Infinity;
}

/** Ratios for a resample `index` (batch positions), plus delete-one jackknife ratios when asked. */
function ratios(m: Matrix, index: Int32Array, out: Float64Array, loo: Float64Array | null) {
  const { batches } = m;

  for (let p = 0; p < m.providers; p++) {
    let s = 0,
      n = 0;

    for (let k = 0; k < batches; k++) {
      const at = p * batches + (index[k] ?? 0);
      s += m.cost[at] ?? 0;
      n += m.done[at] ?? 0;
    }

    out[p] = n > 0 ? s / n : Infinity;

    if (loo)
      for (let k = 0; k < batches; k++) {
        const at = p * batches + (index[k] ?? 0);
        const rest = n - (m.done[at] ?? 0);
        loo[p * batches + k] = rest > 0 ? (s - (m.cost[at] ?? 0)) / rest : Infinity;
      }
  }
}

/** Jackknife standard error of θ_i − θ_j from delete-one ratios. */
function jackknifeSE(loo: Float64Array, batches: number, i: number, j: number): number {
  let mean = 0;

  for (let k = 0; k < batches; k++) {
    const d = gap(loo[i * batches + k] ?? 0, loo[j * batches + k] ?? 0);

    if (!Number.isFinite(d)) return Infinity;
    mean += d;
  }

  mean /= batches;
  let sum = 0;

  for (let k = 0; k < batches; k++)
    sum += (gap(loo[i * batches + k] ?? 0, loo[j * batches + k] ?? 0) - mean) ** 2;

  return Math.sqrt(((batches - 1) / batches) * sum);
}

function standardised(deviation: number, se: number): number {
  if (!Number.isFinite(deviation) || !Number.isFinite(se)) return Infinity;

  if (se === 0) return deviation === 0 ? 0 : Infinity;

  return deviation / se;
}

/** Observed ratios, pair differences and jackknife errors. */
function observed(m: Matrix) {
  const identity = Int32Array.from({ length: m.batches }, (_, k) => k);
  const theta = new Float64Array(m.providers);
  const loo = new Float64Array(m.providers * m.batches);
  ratios(m, identity, theta, loo);
  const pairs = pairsOf(m.providers);
  const difference = Float64Array.from(pairs, ([i, j]) => gap(theta[i] ?? 0, theta[j] ?? 0));
  const se = Float64Array.from(pairs, ([i, j]) => jackknifeSE(loo, m.batches, i, j));

  return { theta, pairs, difference, se };
}

/** Max deviations per replicate for both bootstrap variants, from one shared set of resamples. */
function bootstrapMaxima(
  m: Matrix,
  base: ReturnType<typeof observed>,
  replicates: number,
  random: () => number,
) {
  const centred = new Float64Array(replicates);
  const studentised = new Float64Array(replicates);
  const index = new Int32Array(m.batches);
  const theta = new Float64Array(m.providers);
  const loo = new Float64Array(m.providers * m.batches);

  for (let r = 0; r < replicates; r++) {
    for (let k = 0; k < m.batches; k++) index[k] = Math.floor(random() * m.batches);
    ratios(m, index, theta, loo);

    let maxDev = 0,
      maxT = 0;

    base.pairs.forEach(([i, j], q) => {
      const deviation = Math.abs(gap(gap(theta[i] ?? 0, theta[j] ?? 0), base.difference[q] ?? 0));
      maxDev = Math.max(maxDev, deviation);
      maxT = Math.max(maxT, standardised(deviation, jackknifeSE(loo, m.batches, i, j)));
    });

    centred[r] = maxDev;
    studentised[r] = maxT;
  }

  return { centred, studentised };
}

/** |θ_i − θ_j| after swapping the pair's totals in every batch whose flip bit is set. */
function flippedGap(m: Matrix, i: number, j: number, flip: Uint8Array): number {
  let si = 0,
    ni = 0,
    sj = 0,
    nj = 0;

  for (let k = 0; k < m.batches; k++) {
    const a = i * m.batches + k,
      b = j * m.batches + k;

    const swap = flip[k] === 1;
    si += (swap ? m.cost[b] : m.cost[a]) ?? 0;
    ni += (swap ? m.done[b] : m.done[a]) ?? 0;
    sj += (swap ? m.cost[a] : m.cost[b]) ?? 0;
    nj += (swap ? m.done[a] : m.done[b]) ?? 0;
  }

  return Math.abs(gap(ni > 0 ? si / ni : Infinity, nj > 0 ? sj / nj : Infinity));
}

function flipVectors(batches: number, count: number, random: () => number): Uint8Array[] {
  if (batches <= EXACT_FLIP_BATCHES)
    return Array.from({ length: 2 ** batches }, (_, v) =>
      Uint8Array.from({ length: batches }, (_, k) => (v >> k) & 1),
    );

  return Array.from({ length: count }, (_, v) =>
    v === 0
      ? new Uint8Array(batches)
      : Uint8Array.from({ length: batches }, () => (random() < 0.5 ? 1 : 0)),
  );
}

/** Westfall-Young single-step min-p adjusted p-values over all pairs, by batch sign flips. */
function signFlipAdjusted(
  m: Matrix,
  base: ReturnType<typeof observed>,
  flips: number,
  random: () => number,
): Float64Array {
  const vectors = flipVectors(m.batches, flips, random);
  const count = vectors.length;
  // stats[q][f]: the pair's |difference| under flip f; flip 0 is the identity.

  const stats = base.pairs.map(([i, j]) =>
    Float64Array.from(vectors, (v) => flippedGap(m, i, j, v)),
  );

  const sorted = stats.map((s) => Float64Array.from(s).sort());

  /** Share of flips with a statistic at least `value`: the pair's raw permutation p-value. */
  const pValue = (q: number, value: number) => {
    const row = sorted[q] ?? new Float64Array();

    let lo = 0,
      hi = row.length;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;

      if ((row[mid] ?? 0) < value) lo = mid + 1;
      else hi = mid;
    }

    return (row.length - lo) / count;
  };

  const minP = new Float64Array(count);

  for (let f = 0; f < count; f++) {
    let least = 1;

    stats.forEach((s, q) => {
      least = Math.min(least, pValue(q, s[f] ?? 0));
    });
    minP[f] = least;
  }

  return Float64Array.from(base.pairs, (_, q) => {
    const raw = pValue(q, Math.abs(base.difference[q] ?? 0));
    let atMost = 0;

    for (const p of minP) if (p <= raw) atMost++;

    return atMost / count;
  });
}

export interface ProcedureComparison {
  readonly procedure: Procedure;
  readonly pairs: readonly PairComparison[];
}

/**
 * Run several procedures on the same data. The two bootstrap variants share one set of resamples
 * and the permutation test draws from the same seeded stream after them.
 */
export function compareWith(
  input: readonly ProviderBatches[],
  chosen: readonly Procedure[],
  options: Omit<ComparisonOptions, "procedure">,
): ProcedureComparison[] {
  const m = toMatrix(input);
  const base = observed(m);
  const level = options.level ?? CONFIDENCE_LEVEL;
  const random = seededRandom(options.seed ?? BOOTSTRAP_SEED);
  const names = input.map((p) => p.provider);

  const result = (
    q: number,
    interval: PairComparison["interval"],
    adjustedP: number | null,
  ): PairComparison => {
    const [i = 0, j = 0] = base.pairs[q] ?? [];
    const difference = base.difference[q] ?? 0;

    const separated =
      interval !== null
        ? interval.high < 0 || interval.low > 0
        : adjustedP !== null && adjustedP <= 1 - level && difference !== 0;

    return {
      a: names[i] ?? "",
      b: names[j] ?? "",
      difference,
      interval,
      adjustedP,
      favours: separated ? ((difference < 0 ? names[i] : names[j]) ?? null) : null,
    };
  };

  const needsBootstrap = chosen.some((p) => p !== "sign-flip-permutation");

  const maxima = needsBootstrap
    ? bootstrapMaxima(m, base, options.replicates ?? BOOTSTRAP_REPLICATES, random)
    : null;

  return chosen.map((procedure) => {
    if (procedure === "sign-flip-permutation") {
      const adjusted = signFlipAdjusted(m, base, options.flips ?? SAMPLED_FLIPS, random);

      return { procedure, pairs: base.pairs.map((_, q) => result(q, null, adjusted[q] ?? 1)) };
    }

    if (!maxima) throw new Error("Bootstrap maxima missing");

    if (procedure === "centred-max-deviation") {
      const c = upperQuantile(maxima.centred, level);

      return {
        procedure,
        pairs: base.pairs.map((_, q) => {
          const d = base.difference[q] ?? 0;

          return result(q, { low: d - c, high: d + c }, null);
        }),
      };
    }

    const c = upperQuantile(maxima.studentised, level);

    return {
      procedure,
      pairs: base.pairs.map((_, q) => {
        const d = base.difference[q] ?? 0;
        const se = base.se[q] ?? Infinity;
        const half = se === 0 ? (c === Infinity ? Infinity : 0) : c * se;

        return result(q, { low: d - half, high: d + half }, null);
      }),
    };
  });
}

/** Compare every pair of providers at once with the chosen procedure. */
export function compareAll(
  input: readonly ProviderBatches[],
  options: ComparisonOptions,
): readonly PairComparison[] {
  return compareWith(input, [options.procedure], options)[0]?.pairs ?? [];
}

/** Percentile interval of one provider's statistic by resampling whole batches. */
export function batchPercentileInterval<T>(input: {
  readonly batches: readonly T[];
  readonly statistic: (batches: readonly T[]) => number;
  readonly replicates?: number;
  readonly seed?: number;
  readonly level?: number;
}): { readonly low: number; readonly high: number } | null {
  const count = input.batches.length;

  if (count === 0) return null;
  const replicates = input.replicates ?? BOOTSTRAP_REPLICATES;
  const level = input.level ?? CONFIDENCE_LEVEL;
  const random = seededRandom(input.seed ?? BOOTSTRAP_SEED);
  const values = new Float64Array(replicates);

  for (let r = 0; r < replicates; r++) {
    const sample: T[] = [];

    for (let k = 0; k < count; k++) {
      const batch = input.batches[Math.floor(random() * count)];

      if (batch !== undefined) sample.push(batch);
    }

    values[r] = input.statistic(sample);
  }

  return {
    low: upperQuantile(values, (1 - level) / 2),
    high: upperQuantile(values, 1 - (1 - level) / 2),
  };
}

/** Median of values; null when empty. */
export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];

  if (upper === undefined) return null;

  return sorted.length % 2 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}
