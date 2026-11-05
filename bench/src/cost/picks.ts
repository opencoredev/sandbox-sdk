/**
 * The pick for one profile and track: "lowest verified cost among eligible providers", "no clear
 * winner", or "no certified winner", with the eligible set and every lower unverified cost.
 *
 * 1. Only eligible providers with at least one completion are compared; a provider with zero
 *    completions gets no cost, just "did not complete".
 * 2. The frozen procedure compares all eligible providers at once. The cheapest is the pick only
 *    if it is separated, in its favour, from every other eligible provider.
 * 3. The accounting-sensitivity check then moves the winner up by its reconciliation residual
 *    plus monetary resolution and every rival down by theirs. If any rival matches or beats the
 *    winner, the verdict is "no clear winner" even though the intervals separated them.
 * 4. With no frozen procedure (none reached 95% simultaneous coverage), the verdict is "no
 *    certified winner" next to the lowest cost.
 */
import {
  compareAll,
  costPerCompleted,
  type BatchTotal,
  type ComparisonOptions,
  type PairComparison,
  type Procedure,
} from "./batch-stats.js";
import {
  describeIneligibility,
  reportedShiftFraction,
  type CostSourceAudit,
  type Eligibility,
} from "./eligibility.js";

export const PICK_LABEL = "lowest verified cost among eligible providers";

export interface Candidate {
  readonly provider: string;
  readonly batches: readonly BatchTotal[];
  readonly eligibility: Eligibility;
  readonly audit: CostSourceAudit;
}

export interface UnverifiedCost {
  readonly provider: string;
  readonly costPerCompletedUSD: number;
  readonly reasons: readonly string[];
}

interface VerdictContext {
  /** Providers compared, cheapest first. */
  readonly eligible: readonly string[];
  /** Ineligible providers with a cost below the reference, each with its reasons. */
  readonly lowerUnverified: readonly UnverifiedCost[];
  readonly didNotComplete: readonly string[];
  readonly comparisons: readonly PairComparison[];
}

export type Verdict =
  | (VerdictContext & {
      readonly kind: "lowest-verified-cost";
      readonly label: typeof PICK_LABEL;
      readonly provider: string;
      readonly costPerCompletedUSD: number;
    })
  | (VerdictContext & {
      readonly kind: "no-clear-winner";
      readonly label: "no clear winner";
      readonly cheapest: string;
      /** The cheapest provider and every provider that cannot be separated from it. */
      readonly inseparable: readonly string[];
      readonly cause: "intervals" | "accounting-sensitivity";
    })
  | (VerdictContext & {
      readonly kind: "no-certified-winner";
      readonly label: "no certified winner";
      /** Lowest cost among eligible providers, shown descriptively; null with none eligible. */
      readonly lowest: string | null;
      readonly reason: "no-eligible-provider" | "no-procedure-reached-coverage";
    });

export interface PickInput {
  readonly candidates: readonly Candidate[];
  /** The procedure frozen at A3.5, or null when none reached 95% simultaneous coverage. */
  readonly procedure: Procedure | null;
  readonly options?: Omit<ComparisonOptions, "procedure">;
}

/** Cost moved by the provider's residual and resolution: up for the winner, down for rivals. */
export function accountingBound(candidate: Candidate, direction: "up" | "down"): number {
  const theta = costPerCompleted(candidate.batches);
  const reconciliation = candidate.audit.reconciliation;

  const residual = reconciliation.kind === "reconciled" ? reportedShiftFraction(reconciliation) : 0;

  let attempts = 0,
    completions = 0;

  for (const batch of candidate.batches) {
    attempts += batch.attempts;
    completions += batch.completions;
  }

  const resolution = (candidate.audit.resolutionUSDPerAttempt * attempts) / completions;
  const shift = theta * residual + resolution;

  return direction === "up" ? theta + shift : theta - shift;
}

function unverified(candidates: readonly Candidate[], below: number): UnverifiedCost[] {
  return candidates
    .flatMap((c) => {
      const cost = costPerCompleted(c.batches);

      return c.eligibility.kind === "ineligible" && Number.isFinite(cost) && cost < below
        ? [
            {
              provider: c.provider,
              costPerCompletedUSD: cost,
              reasons: c.eligibility.reasons.map(describeIneligibility),
            },
          ]
        : [];
    })
    .sort((x, y) => x.costPerCompletedUSD - y.costPerCompletedUSD);
}

export type Decision =
  | { readonly kind: "certified"; readonly provider: string }
  | {
      readonly kind: "no-clear-winner";
      readonly inseparable: readonly string[];
      readonly cause: "intervals" | "accounting-sensitivity";
    };

/**
 * Steps 2 and 3 for eligible providers sorted cheapest first: the cheapest must be separated from
 * every rival, then survive the accounting-sensitivity check. Shared with the coverage simulation.
 */
export function decide(
  eligible: readonly [Candidate, ...Candidate[]],
  comparisons: readonly PairComparison[],
): Decision {
  const [cheapest] = eligible;

  const notSeparated = comparisons.flatMap((c) =>
    (c.a === cheapest.provider || c.b === cheapest.provider) && c.favours !== cheapest.provider
      ? [c.a === cheapest.provider ? c.b : c.a]
      : [],
  );

  if (notSeparated.length > 0)
    return {
      kind: "no-clear-winner",
      inseparable: [cheapest.provider, ...notSeparated],
      cause: "intervals",
    };

  const winnerHigh = accountingBound(cheapest, "up");

  const flipped = eligible
    .slice(1)
    .flatMap((rival) => (accountingBound(rival, "down") <= winnerHigh ? [rival.provider] : []));

  if (flipped.length > 0)
    return {
      kind: "no-clear-winner",
      inseparable: [cheapest.provider, ...flipped],
      cause: "accounting-sensitivity",
    };

  return { kind: "certified", provider: cheapest.provider };
}

export function pick(input: PickInput): Verdict {
  const didNotComplete = input.candidates
    .filter((c) => !Number.isFinite(costPerCompleted(c.batches)))
    .map((c) => c.provider);

  const eligible = input.candidates
    .filter(
      (c) => c.eligibility.kind === "eligible" && Number.isFinite(costPerCompleted(c.batches)),
    )
    .sort((x, y) => costPerCompleted(x.batches) - costPerCompleted(y.batches));

  const [cheapest, ...rest] = eligible;
  const names = eligible.map((c) => c.provider);

  if (!cheapest)
    return {
      kind: "no-certified-winner",
      label: "no certified winner",
      lowest: null,
      reason: "no-eligible-provider",
      eligible: names,
      lowerUnverified: unverified(input.candidates, Infinity),
      didNotComplete,
      comparisons: [],
    };

  const cheapestCost = costPerCompleted(cheapest.batches);
  const lowerUnverified = unverified(input.candidates, cheapestCost);

  if (input.procedure === null)
    return {
      kind: "no-certified-winner",
      label: "no certified winner",
      lowest: cheapest.provider,
      reason: "no-procedure-reached-coverage",
      eligible: names,
      lowerUnverified,
      didNotComplete,
      comparisons: [],
    };

  const comparisons =
    eligible.length > 1
      ? compareAll(eligible, { ...input.options, procedure: input.procedure })
      : [];

  const context = { eligible: names, lowerUnverified, didNotComplete, comparisons };
  const decision = decide([cheapest, ...rest], comparisons);

  if (decision.kind === "no-clear-winner")
    return {
      ...context,
      kind: "no-clear-winner",
      label: "no clear winner",
      cheapest: cheapest.provider,
      inseparable: decision.inseparable,
      cause: decision.cause,
    };

  return {
    ...context,
    kind: "lowest-verified-cost",
    label: PICK_LABEL,
    provider: cheapest.provider,
    costPerCompletedUSD: cheapestCost,
  };
}
