/**
 * The three cost columns for one attempt, plus the smallest-sufficient-size counterfactual, all in
 * one frozen cost scope: every charge from the create request to confirmed deletion (compute,
 * memory, disk, standby storage). Charges after deletion, such as retained snapshots, stay out.
 *
 * - Reported cost: the best evidence, with its kind (billed, metered, estimate). Parts we add at
 *   list price, such as disk a billing source leaves out, are marked estimated.
 * - Whole machine at list price: allocation x billed time x published rate. A counterfactual for
 *   providers that charge less than the allocation.
 * - Usage at list price: only for tariffs priced per unit of use (per active vCPU-hour, per GiB
 *   in use); "not applicable" for bundles and allocation pricing, and
 *   "unavailable" when usage was not measured or not validated.
 */
import { computeHourly, priceAtSize, pricing, type Price } from "../pricing.js";
import type { Attribution } from "../realistic/record.js";
import type { CostedAttempt } from "./attempt-input.js";
import { chargesBelowAllocation, type BillingRule } from "./billing-rules.js";

/** EUR to USD rate frozen and published per release, with its date. */
export interface ExchangeRate {
  readonly eurToUsd: number;
  readonly date: string;
}

export interface CostPart {
  readonly label: string;
  readonly usd: number;
  /** Added by us at list price rather than reported by the provider. */
  readonly estimated: boolean;
}

export interface BilledTime {
  readonly seconds: number;
  /** "billing-events" when the rule's start and stop events were both observed. */
  readonly basis: "billing-events" | "elapsed-envelope";
  readonly assumptions: readonly string[];
}

export type StorageTreatment = "included" | "not-charged" | "added-at-list-price" | "unknown";

export type ReportedCost =
  | {
      readonly kind: "billed" | "metered";
      readonly usd: number;
      readonly parts: readonly CostPart[];
      readonly settled: boolean;
      readonly attribution: Attribution;
      readonly storage: StorageTreatment;
      readonly assumptions: readonly string[];
    }
  | {
      readonly kind: "estimate";
      readonly usd: number;
      readonly parts: readonly CostPart[];
      readonly assumptions: readonly string[];
    }
  | { readonly kind: "nothing-created"; readonly usd: 0 }
  | { readonly kind: "unavailable"; readonly reason: string };

export type ListPrice =
  | {
      readonly kind: "list-price";
      readonly usd: number;
      /** True when the provider charges less than the allocation, so this is "if billed for the whole machine". */
      readonly counterfactual: boolean;
      readonly assumptions: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export type UsagePrice =
  | { readonly kind: "list-price"; readonly usd: number; readonly assumptions: readonly string[] }
  | { readonly kind: "not-applicable"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export type SmallestSizePrice =
  | {
      readonly kind: "counterfactual";
      readonly usd: number;
      readonly size: SmallestSufficientSize;
      readonly assumptions: readonly string[];
    }
  | { readonly kind: "not-applicable"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** From the fit check: the smallest offered size that completes the profile within 1.25x of the reference time. */
export interface SmallestSufficientSize {
  readonly cpu: number;
  readonly memoryGiB: number;
  /** Measured elapsed time at that size. */
  readonly seconds: number;
}

export interface AttemptCostInput {
  readonly attempt: CostedAttempt;
  readonly rule: BillingRule;
  readonly fx: ExchangeRate;
}

function priceFor(rule: BillingRule): Price | null {
  return rule.pricingKey === null ? null : (pricing[rule.pricingKey] ?? null);
}

function toUSD(amount: number, price: Price, fx: ExchangeRate): number {
  return price.currency === "EUR" ? amount * fx.eurToUsd : amount;
}

interface EventTime {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly observed: boolean;
}

function eventTime(
  observed: number | null,
  fallback: number,
  name: string,
  assumptions: string[],
): EventTime {
  if (observed !== null) return { at: observed, observed: true };
  assumptions.push(`${name} not observed; envelope edge used`);

  return { at: fallback, observed: false };
}

/** Round raw seconds by the rule's increment and minimum, stating every assumption made. */
export function roundBilledSeconds(
  rule: BillingRule,
  rawSeconds: number,
  assumptions: string[],
): number {
  let increment = 1;

  if (rule.incrementSeconds.kind === "known") increment = rule.incrementSeconds.value;
  else assumptions.push("billing increment unknown; one second assumed");
  let minimum = 0;

  if (rule.minimumSeconds.kind === "known") minimum = rule.minimumSeconds.value;
  else assumptions.push("billing minimum unknown; none assumed");

  return Math.max(minimum, Math.ceil(Math.max(0, rawSeconds) / increment) * increment);
}

/** Billed time under the provider's start and stop rules, falling back to the elapsed envelope. */
export function billedTime(attempt: CostedAttempt, rule: BillingRule): BilledTime {
  const { record, lifecycle } = attempt;
  const assumptions: string[] = [];
  let start: EventTime = { at: record.startedAt, observed: false };

  if (rule.billingStarts.kind !== "known")
    assumptions.push("billing start event unknown; create request used");
  else if (rule.billingStarts.value === "create-request")
    start = { at: record.startedAt, observed: true };
  else start = eventTime(lifecycle.createdAt, record.startedAt, "sandbox-created", assumptions);
  let stop: EventTime = { at: record.endedAt, observed: false };

  if (rule.billingStops.kind !== "known")
    assumptions.push("billing stop event unknown; confirmed deletion used");
  else if (rule.billingStops.value === "delete-request")
    stop = eventTime(lifecycle.deleteRequestedAt, record.endedAt, "delete-request", assumptions);
  else stop = eventTime(lifecycle.deletedAt, record.endedAt, "deletion", assumptions);

  const raw = (stop.at - start.at) / 1000;

  return {
    seconds: roundBilledSeconds(rule, raw, assumptions),
    basis: start.observed && stop.observed ? "billing-events" : "elapsed-envelope",
    assumptions,
  };
}

function diskUSD(price: Price, diskGiB: number, seconds: number, fx: ExchangeRate): number {
  return toUSD(Math.max(0, diskGiB - price.freeDiskGiB) * price.diskGiBSecond * seconds, price, fx);
}

function perStartFee(rule: BillingRule, assumptions: string[]): CostPart[] {
  if (rule.perStartFeeUSD.kind === "known")
    return rule.perStartFeeUSD.value > 0
      ? [{ label: "per-start fee", usd: rule.perStartFeeUSD.value, estimated: true }]
      : [];
  assumptions.push("per-start fee unknown; none added");

  return [];
}

function sumParts(parts: readonly CostPart[]): number {
  return parts.reduce((sum, part) => sum + part.usd, 0);
}

/** Whole allocation at list price for the billed time: compute, disk beyond the free amount, per-start fee. */
function wholeMachineParts(input: AttemptCostInput): {
  parts: CostPart[];
  assumptions: string[];
} | null {
  const price = priceFor(input.rule);
  const size = input.attempt.allocation.provisioned;

  if (!price || !size) return null;
  const hourly = computeHourly(price, size);

  if (hourly === null) return null;
  const time = billedTime(input.attempt, input.rule);
  const assumptions = [...time.assumptions];

  const parts: CostPart[] = [
    {
      label: "compute and memory",
      usd: toUSD((hourly / 3600) * time.seconds, price, input.fx),
      estimated: true,
    },
    {
      label: "disk",
      usd: diskUSD(price, size.diskGiB, time.seconds, input.fx),
      estimated: true,
    },
    ...perStartFee(input.rule, assumptions),
  ];

  return { parts, assumptions };
}

export function wholeMachineListPrice(input: AttemptCostInput): ListPrice {
  const counterfactual = chargesBelowAllocation(input.rule);

  if (counterfactual === null) return { kind: "unavailable", reason: "tariff unknown" };
  const whole = wholeMachineParts(input);

  if (!whole) return { kind: "unavailable", reason: "no list price for the provisioned size" };

  return {
    kind: "list-price",
    usd: sumParts(whole.parts),
    counterfactual,
    assumptions: whole.assumptions,
  };
}

export function reportedCost(input: AttemptCostInput): ReportedCost {
  const evidence = input.attempt.charge;

  switch (evidence.kind) {
    case "no-sandbox":
      return { kind: "nothing-created", usd: 0 };
    case "unavailable":
      return { kind: "unavailable", reason: evidence.reason };
    case "estimate": {
      if (chargesBelowAllocation(input.rule) !== false)
        return { kind: "unavailable", reason: "estimates need a known whole-allocation tariff" };
      const whole = wholeMachineParts(input);

      if (!whole) return { kind: "unavailable", reason: "no list price for the provisioned size" };

      return {
        kind: "estimate",
        usd: sumParts(whole.parts),
        parts: whole.parts,
        assumptions: whole.assumptions,
      };
    }

    case "billed":
    case "metered": {
      const assumptions: string[] = [];
      const parts: CostPart[] = [{ label: "provider charge", usd: evidence.usd, estimated: false }];
      let storage: StorageTreatment = "unknown";

      if (input.rule.storage.kind !== "known")
        assumptions.push("storage coverage of the billing source unknown; nothing added");
      else if (input.rule.storage.value !== "excluded") storage = input.rule.storage.value;
      else {
        const price = priceFor(input.rule);
        const size = input.attempt.allocation.provisioned;

        if (price && size) {
          const time = billedTime(input.attempt, input.rule);
          assumptions.push(...time.assumptions);

          parts.push({
            label: "disk at list price",
            usd: diskUSD(price, size.diskGiB, time.seconds, input.fx),
            estimated: true,
          });
          storage = "added-at-list-price";
        } else assumptions.push("billing source leaves storage out and the disk size is unknown");
      }

      return {
        kind: evidence.kind,
        usd: sumParts(parts),
        parts,
        settled: evidence.settled,
        attribution: input.attempt.attribution,
        storage,
        assumptions,
      };
    }

    default: {
      const _exhaustive: never = evidence;

      return _exhaustive;
    }
  }
}

export function usageListPrice(input: AttemptCostInput): UsagePrice {
  const tariff = input.rule.tariff;

  if (tariff.kind !== "known") return { kind: "unavailable", reason: "tariff unknown" };

  if (tariff.value.kind === "bundle")
    return { kind: "not-applicable", reason: "sold as a fixed bundle; no per-unit price" };

  if (tariff.value.charges !== "usage")
    return { kind: "not-applicable", reason: "priced on the allocation, not on use" };
  const usage = input.attempt.usage;

  if (!usage) return { kind: "unavailable", reason: "usage not measured" };

  if (!usage.validated) return { kind: "unavailable", reason: "usage scope not validated" };
  const price = priceFor(input.rule);

  if (!price) return { kind: "unavailable", reason: "no list rates" };
  const time = billedTime(input.attempt, input.rule);
  const assumptions = [...time.assumptions];
  let diskGiBSeconds = usage.diskGiBSeconds;

  if (diskGiBSeconds === null) {
    const disk = input.attempt.allocation.provisioned?.diskGiB;

    if (disk === undefined) return { kind: "unavailable", reason: "disk use and size unknown" };
    diskGiBSeconds = disk * time.seconds;
    assumptions.push("disk use not measured; provisioned disk used");
  }

  const native =
    usage.cpuSeconds * price.cpuSecond +
    usage.memoryGiBSeconds * price.memoryGiBSecond +
    Math.max(0, diskGiBSeconds - price.freeDiskGiB * time.seconds) * price.diskGiBSecond;

  return { kind: "list-price", usd: toUSD(native, price, input.fx), assumptions };
}

/** List price at the fit check's smallest sufficient size x its measured time. Never a pick. */
export function smallestSizeListPrice(
  input: AttemptCostInput & { readonly size: SmallestSufficientSize },
): SmallestSizePrice {
  if (chargesBelowAllocation(input.rule) !== false)
    return { kind: "not-applicable", reason: "only for providers that bill the whole allocation" };
  const price = priceFor(input.rule);

  if (!price || input.rule.pricingKey === null)
    return { kind: "unavailable", reason: "no list rates" };
  const hourly = priceAtSize(input.rule.pricingKey, input.size);

  if (hourly === null) return { kind: "unavailable", reason: "size not offered" };
  const assumptions: string[] = [];
  const seconds = roundBilledSeconds(input.rule, input.size.seconds, assumptions);
  const disk = input.attempt.allocation.provisioned?.diskGiB ?? 0;

  if (input.attempt.allocation.provisioned === null)
    assumptions.push("disk size unknown; no disk added");

  return {
    kind: "counterfactual",
    usd:
      toUSD((hourly / 3600) * seconds, price, input.fx) +
      diskUSD(price, disk, seconds, input.fx) +
      sumParts(perStartFee(input.rule, assumptions)),
    size: input.size,
    assumptions,
  };
}

export interface AttemptCosts {
  readonly attemptId: string;
  readonly reported: ReportedCost;
  readonly wholeMachine: ListPrice;
  readonly usage: UsagePrice;
}

export function attemptCosts(input: AttemptCostInput): AttemptCosts {
  return {
    attemptId: input.attempt.record.attemptId,
    reported: reportedCost(input),
    wholeMachine: wholeMachineListPrice(input),
    usage: usageListPrice(input),
  };
}
