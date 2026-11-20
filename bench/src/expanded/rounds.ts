/**
 * Timed rounds for scenarios whose work alone takes well under a second.
 *
 * A single 10 to 100 ms window is mostly timer, scheduler and cache noise, so these scenarios
 * repeat the same seeded work in rounds until at least `minTimedSeconds` of timed work and a
 * minimum round count. Every round redoes the work from scratch and reports its own timing and a
 * proof, `sha256(round:digest)`, of the digest that round produced. The verifier recomputes each
 * round's proof from the expected digest, so a missing round, a round that produced another
 * digest, or a short window fails.
 *
 * The guest code is ours. Proofs exist to catch a workload that silently did less or wrong work
 * (a missing tool, a broken fallback, a bug), not to resist a malicious guest.
 */
import { z } from "zod";
import { digestSchema, sha256Hex } from "./guest-kit.js";

/** Timed work every rounds-based scenario accumulates before it stops. */
export const minTimedSeconds = 1;

/** Rounds a reply may carry: enough for a 1 ms round to fill the window, small enough to parse. */
const maxRounds = 5000;

export const roundSchema = z.strictObject({
  seconds: z.number().finite().positive().max(3600),
  proof: digestSchema,
});

export type Round = z.infer<typeof roundSchema>;

export const roundsSchema = z.array(roundSchema).min(1).max(maxRounds);

/** The proof round `round` reports for a run of the work that produced `digest`. */
export function roundProof(round: number, digest: string): string {
  return sha256Hex(`${round}:${digest}`);
}

export type RoundsCheck =
  | {
      readonly ok: true;
      readonly count: number;
      readonly totalSeconds: number;
      readonly medianSeconds: number;
    }
  | { readonly ok: false; readonly reason: string };

/** Check that `rounds` covers the timed window and that every round produced `digest`. */
export function checkRounds(input: {
  readonly rounds: readonly Round[];
  readonly digest: string;
  readonly minRounds: number;
}): RoundsCheck {
  const { rounds, digest, minRounds } = input;

  if (rounds.length < minRounds)
    return { ok: false, reason: `ran ${rounds.length} rounds, want at least ${minRounds}` };

  const totalSeconds = rounds.reduce((sum, round) => sum + round.seconds, 0);

  if (totalSeconds < minTimedSeconds)
    return {
      ok: false,
      reason: `timed ${totalSeconds.toFixed(3)} s of work, want at least ${minTimedSeconds} s`,
    };

  const bad = rounds.findIndex((round, index) => round.proof !== roundProof(index, digest));

  if (bad !== -1) return { ok: false, reason: `round ${bad} proof does not match the digest` };

  const sorted = rounds.map((round) => round.seconds).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  const medianSeconds =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;

  return { ok: true, count: rounds.length, totalSeconds, medianSeconds };
}

/**
 * Guest JavaScript: `await timedRounds(minRounds, work)` runs `work(round)` (sync or async, returning
 * the round's digest) until both minimums are met, and returns `{ rounds, digest }` where `digest`
 * is round 0's. Needs `createHash` from `node:crypto` in scope. Only `work` is timed.
 */
export const nodeRoundsSource = `async function timedRounds(minRounds, work) {
  const rounds = [];
  let spent = 0;
  let first = null;
  while (rounds.length < minRounds || spent < ${minTimedSeconds}) {
    const round = rounds.length;
    const started = performance.now();
    const digest = await work(round);
    const seconds = (performance.now() - started) / 1000;
    spent += seconds;
    first ??= digest;
    rounds.push({ seconds, proof: createHash("sha256").update(round + ":" + digest).digest("hex") });
  }
  return { rounds, digest: first };
}`;

/** Guest Python twin of `nodeRoundsSource`: `rounds, digest = timed_rounds(min_rounds, work)`. Needs `sha` and `time`. */
export const pythonRoundsSource = `
def timed_rounds(min_rounds, work):
    rounds, spent, first = [], 0.0, None
    while len(rounds) < min_rounds or spent < ${minTimedSeconds}:
        r = len(rounds)
        t = time.perf_counter()
        d = work(r)
        s = time.perf_counter() - t
        spent += s
        first = d if first is None else first
        rounds.append({"seconds": s, "proof": sha("%d:%s" % (r, d))})
    return rounds, first
`;
