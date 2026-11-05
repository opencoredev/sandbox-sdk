/**
 * What drives a gap, only as far as the numbers go.
 *
 * Within one provider whose tariff is per unit: the whole-machine counterfactual minus the
 * reported cost is split into idle CPU, unused memory and an explicit residual (storage, minimums,
 * preparation, rounding). Reported = whole machine - idle CPU - unused memory - residual, exactly.
 *
 * The line builder writes only what those numbers support: a ratio against the provider's own
 * whole-machine price, the measured paced-to-dense change, and "mainly" only when a decomposition
 * that sums to the total shows one part above half of the difference. Between providers it states
 * the observed difference with each side's billing model, never a percentage split.
 */
import { pricing } from "../pricing.js";
import type { AttemptRecord } from "./attempt-record.js";
import { billingModelLabel, type BillingRule } from "./billing-rules.js";
import { billedTime, reportedCost, wholeMachineListPrice, type ExchangeRate } from "./columns.js";
import type { CostKind } from "./eligibility.js";

export type Decomposition =
  | {
      readonly kind: "decomposed";
      readonly reportedUSD: number;
      readonly wholeMachineUSD: number;
      readonly idleCpuUSD: number;
      readonly unusedMemoryUSD: number;
      /** Everything else: storage, minimums, per-start fees, preparation, rounding. */
      readonly residualUSD: number;
      readonly assumptions: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Relative tolerance for "the parts sum to the total" under floating point. */
const SUM_TOLERANCE = 1e-9;

/** Decompose one provider's attempts (one profile and track) against its whole-machine price. */
export function decompose(input: {
  readonly attempts: readonly AttemptRecord[];
  readonly rule: BillingRule;
  readonly fx: ExchangeRate;
}): Decomposition {
  const { rule, fx } = input;

  if (
    rule.tariff.kind !== "known" ||
    rule.tariff.value.kind !== "per-unit" ||
    rule.tariff.value.charges !== "usage"
  )
    return { kind: "unavailable", reason: "only for tariffs priced per unit of use" };
  const price = rule.pricingKey === null ? undefined : pricing[rule.pricingKey];

  if (!price) return { kind: "unavailable", reason: "no list rates" };
  const rate = price.currency === "EUR" ? fx.eurToUsd : 1;
  const assumptions = new Set<string>();

  let reportedUSD = 0,
    wholeMachineUSD = 0,
    idleCpuUSD = 0,
    unusedMemoryUSD = 0;

  for (const attempt of input.attempts) {
    if (attempt.completion.kind === "not-run") continue;
    const reported = reportedCost({ attempt, rule, fx });

    if (reported.kind === "unavailable")
      return { kind: "unavailable", reason: `reported cost unavailable: ${reported.reason}` };
    reportedUSD += reported.usd;

    if (reported.kind === "nothing-created") continue;
    const whole = wholeMachineListPrice({ attempt, rule, fx });

    if (whole.kind === "unavailable")
      return { kind: "unavailable", reason: `whole-machine price unavailable: ${whole.reason}` };
    const size = attempt.allocation.provisioned;
    const usage = attempt.usage;

    if (!size || !usage || !usage.validated)
      return { kind: "unavailable", reason: "validated usage needed on every attempt" };
    const time = billedTime(attempt, rule);

    for (const note of whole.assumptions) assumptions.add(note);
    wholeMachineUSD += whole.usd;
    idleCpuUSD += (size.cpu * time.seconds - usage.cpuSeconds) * price.cpuSecond * rate;
    unusedMemoryUSD +=
      (size.memoryGiB * time.seconds - usage.memoryGiBSeconds) * price.memoryGiBSecond * rate;
  }

  if (idleCpuUSD < 0 || unusedMemoryUSD < 0)
    assumptions.add("measured use exceeds the allocation for part of the run");

  return {
    kind: "decomposed",
    reportedUSD,
    wholeMachineUSD,
    idleCpuUSD,
    unusedMemoryUSD,
    residualUSD: wholeMachineUSD - reportedUSD - idleCpuUSD - unusedMemoryUSD,
    assumptions: [...assumptions],
  };
}

/** Whether whole machine - idle CPU - unused memory - residual equals the reported cost. */
export function sumsToReported(d: Extract<Decomposition, { kind: "decomposed" }>): boolean {
  const rebuilt = d.wholeMachineUSD - d.idleCpuUSD - d.unusedMemoryUSD - d.residualUSD;

  return Math.abs(rebuilt - d.reportedUSD) <= SUM_TOLERANCE * Math.max(1e-12, d.wholeMachineUSD);
}

function ratio(value: number): string {
  return value >= 10 ? value.toFixed(0) : Number(value.toPrecision(2)).toString();
}

export function formatUSD(value: number): string {
  return value >= 1 ? `$${value.toFixed(2)}` : `$${Number(value.toPrecision(2))}`;
}

/** The verb phrase for a cost kind; only bills are "charged". */
function costPhrase(kind: CostKind, provider: string, start: boolean): string {
  switch (kind) {
    case "billed":
      return `${provider} charged`;
    case "metered":
      return `${provider}'s usage meter showed`;
    case "estimate":
      return `${start ? "We" : "we"} estimate ${provider} at`;
    default: {
      const _exhaustive: never = kind;

      return _exhaustive;
    }
  }
}

export interface ProviderLineInput {
  readonly provider: string;
  readonly kind: CostKind;
  readonly reportedUSD: number;
  readonly wholeMachineUSD: number | null;
  readonly decomposition: Decomposition | null;
  /** Measured cost with the recorded gaps removed over the paced cost, or null when not run. */
  readonly denseOverPaced: number | null;
  readonly provisional: string | null;
}

/**
 * A decomposition explains a line only if it describes the same totals: its reported-to-whole
 * ratio must match the line's (the line is per completed task, the decomposition over attempts).
 */
function sameRatio(
  d: Extract<Decomposition, { kind: "decomposed" }>,
  input: ProviderLineInput,
): boolean {
  if (input.wholeMachineUSD === null || input.wholeMachineUSD <= 0 || d.wholeMachineUSD <= 0)
    return false;

  const shown = input.reportedUSD / input.wholeMachineUSD;
  const decomposed = d.reportedUSD / d.wholeMachineUSD;

  return Math.abs(shown - decomposed) <= 1e-9 * Math.max(1, Math.abs(shown));
}

/** One plain-language line for a provider, or null when no number supports one. */
export function providerLine(input: ProviderLineInput): string | null {
  const clauses: string[] = [];

  if (input.wholeMachineUSD !== null && input.wholeMachineUSD > 0)
    clauses.push(
      `${costPhrase(input.kind, input.provider, true)} ${ratio(input.reportedUSD / input.wholeMachineUSD)} of what the whole machine would cost at its own list price`,
    );

  if (input.denseOverPaced !== null) {
    const change =
      input.denseOverPaced >= 1
        ? `raised its cost ${ratio(input.denseOverPaced)}x`
        : `lowered its cost to ${ratio(input.denseOverPaced)} of the paced cost`;

    clauses.push(
      clauses.length > 0
        ? `removing the pauses ${change}`
        : `Removing the pauses ${change} for ${input.provider}`,
    );
  }

  if (clauses.length === 0) return null;
  let line = clauses.join(", and ");
  const d = input.decomposition;

  if (d?.kind === "decomposed" && sumsToReported(d) && sameRatio(d, input)) {
    const gap = d.wholeMachineUSD - d.reportedUSD;

    const parts = [
      { name: "idle CPU", usd: d.idleCpuUSD },
      { name: "unused memory", usd: d.unusedMemoryUSD },
    ];

    const main = parts.find((p) => gap > 0 && p.usd > gap / 2);

    if (main)
      line += `, mainly because of ${main.name} (${Math.round((main.usd / gap) * 100)}% of the difference)`;
  }

  line += ".";

  return input.provisional === null ? line : `${line} Provisional: ${input.provisional}.`;
}

/** The observed difference between two providers, each with its billing model; no causes. */
export function comparisonLine(
  a: {
    readonly provider: string;
    readonly kind: CostKind;
    readonly usd: number;
    readonly rule: BillingRule;
  },
  b: {
    readonly provider: string;
    readonly kind: CostKind;
    readonly usd: number;
    readonly rule: BillingRule;
  },
): string {
  const side = (s: typeof a, start: boolean) => {
    const model = billingModelLabel(s.rule);

    return `${costPhrase(s.kind, s.provider, start)} ${formatUSD(s.usd)} per completed task${model ? ` (${model})` : ""}`;
  };

  return `${side(a, true)}; ${side(b, false)}: a difference of ${formatUSD(Math.abs(a.usd - b.usd))}.`;
}
