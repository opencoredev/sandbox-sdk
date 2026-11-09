/**
 * The public billing-rules table: per provider, what starts and stops billing, rounding and
 * minimums, per-start fees, what keeps charging, whether file cache counts as memory, where the
 * settled charge comes from and how charges are attributed to our sandboxes.
 *
 * Every cell is a `Fact`: known with its source, unknown with a note, or not applicable. Unknown
 * cells are never filled with a guess; cost code that needs one states the assumption it used.
 * Filled from `src/billing/providers.ts`, `src/pricing.ts` and plan section 6. Every row is
 * "unconfirmed, from docs" until the provider confirms it in writing.
 */
import type { Attribution } from "../realistic/record.js";

export type Fact<T> =
  | { readonly kind: "known"; readonly value: T; readonly source: string }
  | { readonly kind: "unknown"; readonly note: string }
  | { readonly kind: "not-applicable"; readonly note: string };

/**
 * `per-unit` prices vCPU, memory and disk separately (rates in `src/pricing.ts`). `bundle` sells a
 * fixed size at one hourly price. `charges` says what the price is applied to: the whole
 * allocation while the sandbox exists, the resources actually in use, or a size per active hour.
 */
export type Tariff =
  | { readonly kind: "per-unit"; readonly charges: "allocation" | "usage" }
  | { readonly kind: "bundle"; readonly charges: "allocation" | "active-time" };

/** Event that starts billing, matched to attempt timestamps by the cost module. */
export type BillingStart = "create-request" | "sandbox-created";

/** Event that stops billing. */
export type BillingStop = "delete-request" | "delete-confirmed";

/** Charges that continue after the stop event or while a sandbox is paused. */
export type Lingering = "disk" | "standby" | "snapshots";

/** Whether the provider's settled charge includes storage. "not-charged" means no storage fee exists. */
export type StorageCoverage = "included" | "excluded" | "not-charged";

/**
 * How a provider's charges can be tied to our sandboxes (plan section 6): per sandbox, per
 * machine from a meter, account totals over an isolated window, or not at all. The harness record
 * owns the enum; this table owns each provider's value, and the scheduler reads it from here.
 */
export type { Attribution } from "../realistic/record.js";

export type Confirmation =
  | { readonly kind: "confirmed-in-writing"; readonly date: string; readonly reference: string }
  | { readonly kind: "unconfirmed-from-docs" };

export interface BillingRule {
  readonly provider: string;
  readonly product: string | null;
  /** Key into `pricing` for list rates, null when no list rates are known. */
  readonly pricingKey: string | null;
  readonly tariff: Fact<Tariff>;
  readonly billingStarts: Fact<BillingStart>;
  readonly billingStops: Fact<BillingStop>;
  readonly incrementSeconds: Fact<number>;
  readonly minimumSeconds: Fact<number>;
  readonly perStartFeeUSD: Fact<number>;
  readonly keepsCharging: Fact<readonly Lingering[]>;
  readonly countsFileCacheAsMemory: Fact<boolean>;
  readonly storage: Fact<StorageCoverage>;
  readonly settledChargeSource: Fact<string>;
  /** Kind of today's best evidence: the provider's bill, its usage meter, or our estimate. */
  readonly reportedKind: "billed" | "metered" | "estimate";
  readonly attribution: Attribution;
  /** Settlement edge the scheduler pads billing windows to, in ms (boxd: 15 minutes), or null. */
  readonly settlementMs: number | null;
  readonly confirmation: Confirmation;
  readonly notes: readonly string[];
}

const unknown = (note: string) => ({ kind: "unknown", note }) as const;

const known = <T>(value: T, source: string) => ({ kind: "known", value, source }) as const;

const notApplicable = (note: string) => ({ kind: "not-applicable", note }) as const;

const allocationCache = notApplicable(
  "Bills the allocation, so memory use does not change the charge",
);

const cachePending = unknown("File-cache check (2 GiB write, read, 2 min idle) not run yet");

const unconfirmed = { kind: "unconfirmed-from-docs" } as const;

const settledPending = unknown(
  "No invoice or billing export identified; requested in the billing-rules request",
);

const docs = {
  e2b: "https://e2b.dev/pricing",
  e2bEvents: "https://api.e2b.app/events/sandboxes/{id} (lifecycle execution segments)",
  daytona: "https://www.daytona.io/pricing",
  daytonaAnalytics: "https://analytics.app.daytona.io/organization/{org}/usage/sandbox",
  upstash: "https://upstash.com/pricing/box",
  upstashBox: "https://us-east-1.box.upstash.com/v2/box/{id}",
  boat: "https://docs.boat.dev/machines",
  boxd: "https://boxd.sh/pricing",
  boxdActivity: "boxd orgs.billingActivityPage (org-wide 15-minute charges)",
  superserve: "https://www.superserve.ai/pricing",
  superserveUsage: "https://api.superserve.ai/billing/usage-series",
  freestyle: "https://www.freestyle.sh/pricing",
  tenki: "https://tenki.cloud/pricing",
  modal: "https://modal.com/pricing",
  modalResources: "https://modal.com/docs/guide/sandbox-resources",
  modalRegions: "https://modal.com/docs/guide/region-selection",
  modalBilling: "https://modal.com/docs/guide/billing (workspace billing report, per App)",
} as const;

export const billingRules: readonly BillingRule[] = [
  {
    provider: "e2b",
    product: null,
    pricingKey: "e2b",
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.e2b),
    billingStarts: unknown("Usage events meter execution segments; the billed start is not stated"),
    billingStops: unknown("Usage events meter execution segments; the billed stop is not stated"),
    incrementSeconds: known(1, `${docs.e2b} (per-second billing)`),
    minimumSeconds: unknown("No minimum stated"),
    perStartFeeUSD: unknown("No creation fee listed; absence is not confirmation"),
    keepsCharging: unknown("Paused-sandbox and snapshot charges not stated"),
    countsFileCacheAsMemory: allocationCache,
    storage: known("not-charged", `${docs.e2b} (disk included in plan, no disk rate)`),
    settledChargeSource: settledPending,
    reportedKind: "metered",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "Usage API is a meter (execution segments at published rates), not an invoice.",
      "Subscription excluded.",
    ],
  },
  {
    provider: "daytona",
    product: null,
    pricingKey: "daytona",
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.daytona),
    billingStarts: unknown("Not stated"),
    billingStops: unknown("Not stated"),
    incrementSeconds: unknown("Not stated; one second assumed in estimates"),
    minimumSeconds: unknown("Not stated"),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Stopped-sandbox disk and snapshot storage not confirmed"),
    countsFileCacheAsMemory: allocationCache,
    storage: unknown("Not known whether the analytics price includes disk"),
    settledChargeSource: known(
      "Per-sandbox price in a fixed window, final 48 hours after the window ends",
      docs.daytonaAnalytics,
    ),
    reportedKind: "billed",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: ["5 GiB disk free; credits and tax separate."],
  },
  {
    provider: "upstash",
    product: null,
    pricingKey: "upstash",
    tariff: known({ kind: "bundle", charges: "active-time" }, docs.upstash),
    billingStarts: unknown("What makes a box-hour active is not defined"),
    billingStops: unknown("Not stated"),
    incrementSeconds: unknown("Not stated"),
    minimumSeconds: unknown("Not stated"),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Disk is billed per GB-month; behaviour after deletion not stated"),
    countsFileCacheAsMemory: notApplicable(
      "Memory is not metered; a size is priced per active hour",
    ),
    storage: known("excluded", `${docs.upstashBox} (total_compute_cost_usd is compute only)`),
    settledChargeSource: known(
      "Per-box cumulative compute charge, final after deletion",
      docs.upstashBox,
    ),
    reportedKind: "billed",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "Tier price per active box-hour (size table, engineer confirmation over the FAQ example).",
      "Observed 2026-11-05 (SBX-100, 20 headline attempts): the per-box charge equals the tier price times the CPU-seconds measured in the box's cgroup / 3600 ($0.2001 per CPU-hour on medium, $0.1001 on small). A busy 4 vCPU box costs up to 4x the tier price per wall-hour, which the per-box-hour list price understates. Unconfirmed by Upstash.",
    ],
  },
  {
    // The harness runs Upstash's ephemeral product as its own provider name.
    provider: "upstash-ephemeral",
    product: null,
    pricingKey: null,
    tariff: unknown("Ephemeral pricing not recorded"),
    billingStarts: unknown("Not stated"),
    billingStops: unknown("Not stated"),
    incrementSeconds: unknown("Not stated"),
    minimumSeconds: unknown("Not stated"),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Not stated"),
    countsFileCacheAsMemory: unknown("Not stated"),
    storage: unknown("Not stated"),
    settledChargeSource: unknown(
      "The collector reads the Box API for this product too; not confirmed for Ephemeral",
    ),
    reportedKind: "billed",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "Plan section 6 lists Upstash Ephemeral as per-sandbox; its tariff is not yet recorded.",
    ],
  },
  {
    provider: "boat",
    product: null,
    pricingKey: "boat",
    tariff: known({ kind: "bundle", charges: "allocation" }, docs.boat),
    billingStarts: unknown("Not stated"),
    billingStops: unknown("Not stated"),
    incrementSeconds: known(1, `${docs.boat} (billed per second)`),
    minimumSeconds: unknown("Not stated per sandbox"),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Not stated"),
    countsFileCacheAsMemory: allocationCache,
    storage: known("included", `${docs.boat} (50 GB disk in the default bundle)`),
    settledChargeSource: settledPending,
    reportedKind: "metered",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "Per-sandbox usage API reports list-price dollars, not an invoice.",
      "$20/month plan minimum is outside the per-task cost and stated next to the bar.",
    ],
  },
  {
    provider: "boxd",
    product: null,
    pricingKey: "boxd",
    tariff: known({ kind: "per-unit", charges: "usage" }, docs.boxd),
    billingStarts: unknown("Not stated"),
    billingStops: unknown("Not stated"),
    incrementSeconds: known(1, `${docs.boxd} (metered per second)`),
    minimumSeconds: unknown("Not stated"),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Standby and written-disk charges after idle not confirmed"),
    countsFileCacheAsMemory: cachePending,
    storage: known("included", `${docs.boxdActivity} (vCPU, RAM and disk parts)`),
    settledChargeSource: known("Org-wide charges posted per 15-minute bucket", docs.boxdActivity),
    reportedKind: "metered",
    attribution: "per-machine",
    settlementMs: 15 * 60_000,
    confirmation: unconfirmed,
    notes: [
      "Prices in EUR; each release freezes the EUR to USD rate and its date.",
      "Settlement every 15 minutes is not a rounding increment.",
    ],
  },
  {
    provider: "superserve",
    product: null,
    pricingKey: "superserve",
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.superserve),
    billingStarts: unknown("Not stated"),
    billingStops: unknown("Not stated"),
    incrementSeconds: unknown("One-second rounding assumed, not stated"),
    minimumSeconds: unknown("Not stated"),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Snapshot storage not stated"),
    countsFileCacheAsMemory: allocationCache,
    storage: known("not-charged", `${docs.superserveUsage} (storage tracked, not billed)`),
    settledChargeSource: known(
      "Account charge over a time range (billed_total_usd), before credits and tax",
      docs.superserveUsage,
    ),
    reportedKind: "billed",
    attribution: "account-window",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: ["Attributable only through isolated windows: one attempt per window."],
  },
  {
    provider: "tenki",
    product: null,
    pricingKey: "tenki",
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.tenki),
    billingStarts: unknown("Not stated"),
    billingStops: unknown("Not stated"),
    incrementSeconds: known(1, `${docs.tenki} (per-second)`),
    minimumSeconds: known(0, `${docs.tenki} (no minimum)`),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Separate persistent storage exists; after-deletion charges not stated"),
    countsFileCacheAsMemory: allocationCache,
    storage: unknown("No billing source to check"),
    settledChargeSource: unknown("No billing data we can read"),
    reportedKind: "estimate",
    attribution: "none",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: ["5 GiB disk free. Credits excluded."],
  },
  {
    provider: "freestyle",
    product: null,
    pricingKey: "freestyle",
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.freestyle),
    billingStarts: unknown("Not stated"),
    billingStops: unknown("Not stated"),
    incrementSeconds: unknown("Not stated; one second assumed in estimates"),
    minimumSeconds: unknown("Not stated"),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Not stated"),
    countsFileCacheAsMemory: allocationCache,
    storage: unknown("No billing source to check"),
    settledChargeSource: unknown("No billing data we can read"),
    reportedKind: "estimate",
    attribution: "none",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: ["Overage rates; allowances and $0.02/GB transfer excluded."],
  },
  {
    provider: "modal",
    product: null,
    pricingKey: "modal",
    // max(request, usage) per second: a sized sandbox pins request = limit, so it pays for its
    // allocation; the unsized default also pays for usage above its 0.125 CPU / 128 MiB request.
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.modalResources),
    billingStarts: unknown("Not stated"),
    billingStops: unknown(
      "Not stated; destroy waits for Modal's confirmed stop, and the App charge includes any lag",
    ),
    incrementSeconds: known(1, `${docs.modal} (per second)`),
    minimumSeconds: unknown("Not stated; minimum request is 0.125 CPU, not a minimum time"),
    perStartFeeUSD: unknown("No creation fee listed; absence is not confirmation"),
    keepsCharging: unknown("Snapshot image storage not stated"),
    countsFileCacheAsMemory: unknown(
      "Memory is billed at max(request, usage); whether page cache counts as usage is not stated",
    ),
    storage: known("not-charged", `${docs.modal} (no disk rate for sandboxes)`),
    settledChargeSource: known(
      "Per-App metered cost per hour, before credits; one sandbox per App in the bench",
      docs.modalBilling,
    ),
    reportedKind: "metered",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "Sandbox rates are three times Function rates (non-preemptible). A pinned narrow region such as us-east is 1.75x, a broad one such as us 1.15x.",
      "One Modal CPU is a physical core per the docs; measured as about one thread of throughput per unit (MODAL.md).",
      "Plan credits ($30 Starter, $100 Team per month) excluded.",
    ],
  },
];

/** The rule for a provider and product, or null when the provider has no row. */
export function billingRule(provider: string, product: string | null): BillingRule | null {
  // The bench's older form: Upstash with the "ephemeral" product.
  const [name, item] =
    provider === "upstash" && product === "ephemeral"
      ? ["upstash-ephemeral", null]
      : [provider, product];

  return billingRules.find((r) => r.provider === name && r.product === item) ?? null;
}

/** The phrase printed on a provider's bar, or null when its tariff is not known. */
export function billingModelLabel(rule: BillingRule): string | null {
  if (rule.tariff.kind !== "known") return null;
  const tariff = rule.tariff.value;

  switch (tariff.charges) {
    case "allocation":
      return "bills the whole machine while it exists";
    case "usage":
      return "bills active CPU and memory in use";
    case "active-time":
      return "bills a fixed size per active hour";
    default: {
      const _exhaustive: never = tariff;

      return _exhaustive;
    }
  }
}

/** True when the provider charges for less than the whole allocation, so a whole-machine price is a counterfactual. */
export function chargesBelowAllocation(rule: BillingRule): boolean | null {
  return rule.tariff.kind === "known" ? rule.tariff.value.charges !== "allocation" : null;
}
