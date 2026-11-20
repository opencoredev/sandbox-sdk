/**
 * Timed rounds for scenarios whose work alone takes well under a second.
 *
 * A single 10 to 100 ms window is mostly timer, scheduler and cache noise, so these scenarios
 * repeat their work in rounds until at least `minTimedSeconds` of timed work and a minimum round
 * count. Every round works on its own input: the guest's untimed `prepare(round)` derives it from
 * the seed and the round index, and the timed `work(input)` returns evidence of that round's
 * result (`proof`, plus scenario fields such as a gzip trailer). The verifier checks each round's
 * evidence against what the host expects for that round, so a round that reused another round's
 * work, or skipped it, fails, as does a missing round or a short window.
 *
 * Per-round inputs are a cheap change over a shared base (a salt line, a rotation, other
 * constants), so the host computes each round's expected evidence without redoing the guest's
 * work, except where the evidence is the work itself (SHA-256).
 *
 * The guest code is ours. Proofs exist to catch a workload that silently did less or wrong work
 * (a missing tool, a broken fallback, a bug), not to resist a malicious guest.
 */
import { z } from "zod";
import { digestSchema, secondsSchema } from "./guest-kit.js";

/** Timed work every rounds-based scenario accumulates before it stops. */
export const minTimedSeconds = 1;

/** Rounds a reply may carry: enough for a 1 ms round to fill the window, small enough to parse. */
const maxRounds = 5000;

const roundFields = { seconds: secondsSchema, proof: digestSchema };

/** A reply's rounds, each with its timing, its `proof` digest and the `extra` evidence fields. */
export function roundsWith<Extra extends Record<string, z.ZodType>>(extra: Extra) {
  return z
    .array(z.strictObject({ ...roundFields, ...extra }))
    .min(1)
    .max(maxRounds);
}

/** Rounds whose only evidence is `proof`. */
export const roundsSchema = roundsWith({});

export type Round = z.infer<typeof roundsSchema>[number];

export type RoundsCheck =
  | {
      readonly ok: true;
      readonly count: number;
      readonly totalSeconds: number;
      readonly medianSeconds: number;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Check that `rounds` covers the timed window and that every round's evidence is what the host
 * expects for that round: `check` returns why round `index` is wrong, or null.
 */
export function checkRounds<R extends Round>(input: {
  readonly rounds: readonly R[];
  readonly minRounds: number;
  readonly check: (round: R, index: number) => string | null;
}): RoundsCheck {
  const { rounds, minRounds, check } = input;

  if (rounds.length < minRounds)
    return { ok: false, reason: `ran ${rounds.length} rounds, want at least ${minRounds}` };

  const totalSeconds = rounds.reduce((sum, round) => sum + round.seconds, 0);

  if (totalSeconds < minTimedSeconds)
    return {
      ok: false,
      reason: `timed ${totalSeconds.toFixed(3)} s of work, want at least ${minTimedSeconds} s`,
    };

  for (const [index, round] of rounds.entries()) {
    const wrong = check(round, index);

    if (wrong !== null) return { ok: false, reason: `round ${index}: ${wrong}` };
  }

  const sorted = rounds.map((round) => round.seconds).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  const medianSeconds =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;

  return { ok: true, count: rounds.length, totalSeconds, medianSeconds };
}

/** A `check` for rounds whose `proof` must be `expected(index)`. */
export function proofIs(expected: (index: number) => string) {
  return (round: Round, index: number) =>
    round.proof === expected(index) ? null : "proof does not match the work for this round";
}

/**
 * `compute(seed, round)`, cached per seed (at most eight seeds), so a verifier that checks the
 * same rounds twice computes each round once.
 */
export function perRound<T>(
  compute: (seed: number, round: number) => T,
): (seed: number, round: number) => T {
  const cache = new Map<number, Map<number, T>>();

  return (seed, round) => {
    let rounds = cache.get(seed);

    if (rounds === undefined) {
      if (cache.size >= 8) cache.clear();
      rounds = new Map();
      cache.set(seed, rounds);
    }

    const hit = rounds.get(round);

    if (hit !== undefined) return hit;

    const value = compute(seed, round);
    rounds.set(round, value);

    return value;
  };
}

/**
 * Guest JavaScript: `await timedRounds(minRounds, prepare, work)` runs `prepare(round)` untimed,
 * then times `work(input)` (sync or async, returning the round's evidence object with `proof`),
 * until both minimums are met, and returns the rounds. `prepare` is the only place a round index
 * reaches the work, so every round's input, and its evidence, is its own.
 */
export const nodeRoundsSource = `async function timedRounds(minRounds, prepare, work) {
  const rounds = [];
  let spent = 0;
  while (rounds.length < minRounds || spent < ${minTimedSeconds}) {
    const input = await prepare(rounds.length);
    const started = performance.now();
    const evidence = await work(input);
    const seconds = (performance.now() - started) / 1000;
    spent += seconds;
    rounds.push({ seconds, ...evidence });
  }
  return rounds;
}`;

/** Guest Python twin of `nodeRoundsSource`: `rounds = timed_rounds(min_rounds, prepare, work)`. Needs `time`. */
export const pythonRoundsSource = `
def timed_rounds(min_rounds, prepare, work):
    rounds, spent = [], 0.0
    while len(rounds) < min_rounds or spent < ${minTimedSeconds}:
        data = prepare(len(rounds))
        t = time.perf_counter()
        evidence = work(data)
        s = time.perf_counter() - t
        spent += s
        rounds.append(dict(evidence, seconds=s))
    return rounds
`;
