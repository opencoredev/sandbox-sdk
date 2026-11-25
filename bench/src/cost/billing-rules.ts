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
 * allocation while the sandbox exists, the resources actually in use, CPU time in use with the
 * whole memory allocation (Vercel), or a size per active hour.
 */
export type Tariff =
  | { readonly kind: "per-unit"; readonly charges: "allocation" | "usage" | "active-cpu" }
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
  upstashBilling:
    "https://us-east-1.box.upstash.com/v2/box/billing (the account's monthly Box billing, one line per box)",
  boat: "https://docs.boat.dev/machines",
  boxd: "https://boxd.sh/pricing",
  boxdActivity: "boxd orgs.billingActivityPage (org-wide 15-minute charges)",
  superserve: "https://www.superserve.ai/pricing",
  superserveUsage: "https://api.superserve.ai/billing/usage-series",
  freestyle: "https://www.freestyle.sh/pricing",
  tenki: "https://luxor.ai/pricing",
  baseten: "https://www.baseten.co/pricing/",
  instabox: "https://instabox.sh/docs/account/pricing.md",
  instaboxBilling: "https://instabox.sh/docs/account/billing.md",
  instaboxUsage: "https://api.instabox.sh/v1/machines/{id}/usage",
  beam: "https://www.beam.cloud/pricing",
  archil: "https://docs.archil.com/administration/billing.md",
  archilUsage:
    "GET /api/sandboxes/{id}/usage on Archil's control plane (docs.archil.com/administration/billing.md)",
  maritime: "https://maritime.sh/docs/billing",
  maritimeUsage: "https://api.maritime.sh/v1/usage?sandbox={id} and /v1/sandboxes/{id}/info",
  microsandbox: "https://microsandbox.dev/pricing",
  microsandboxUsage:
    "https://api.microsandbox.dev/v1/billing/usage/sandbox (per-sandbox daily rows) and /v1/billing/usage (costs.workloads)",
  modal: "https://modal.com/pricing",
  modalResources: "https://modal.com/docs/guide/sandbox-resources",
  modalRegions: "https://modal.com/docs/guide/region-selection",
  modalBilling: "https://modal.com/docs/guide/billing (workspace billing report, per App)",
  vercel: "https://vercel.com/docs/sandbox/pricing",
  vercelSdk:
    "@vercel/sandbox Sandbox.get (totalActiveCpuDurationMs, totalDurationMs, memory, totalIngressBytes, totalEgressBytes)",
} as const;

/**
 * Microsandbox Cloud's rule for one compute tier. Both tiers bill the same way at their own rates, and
 * both stay provisional: the usage rows meter running intervals only, deletion is asynchronous, and no
 * field says a sandbox's charge is final. Neither tier is in the held-open idle diagnostic.
 */
function microsandboxRule(
  provider: "microsandbox" | "microsandbox-shared",
  tier: string,
): BillingRule {
  return {
    provider,
    product: null,
    pricingKey: provider,
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.microsandbox),
    billingStarts: unknown(
      "Usage rows meter running time; when a created sandbox's first billed second falls is not documented",
    ),
    billingStops: unknown(
      "CPU and memory stop when the sandbox stops; its root disk keeps billing until the delete completes, which is asynchronous",
    ),
    incrementSeconds: unknown("Rows are in seconds of running time; rounding is not documented"),
    minimumSeconds: unknown("No minimum listed; absence is not confirmation"),
    perStartFeeUSD: unknown("No creation fee listed; absence is not confirmation"),
    keepsCharging: known(
      ["disk", "snapshots"],
      `${docs.microsandbox} (a stopped persistent sandbox keeps billing its root disk until deleted; managed snapshots bill $0.08/GiB-month)`,
    ),
    countsFileCacheAsMemory: allocationCache,
    storage: known(
      "included",
      `${docs.microsandbox} (provisioned root disk is a per-GiB-hour line, $0.0000625, in the running usage rows as disk_mib_seconds)`,
    ),
    settledChargeSource: known(
      "Per-sandbox daily usage rows (vCPU-, memory- and disk-seconds) rated at the row's compute type, cross-checked against costs.workloads",
      docs.microsandboxUsage,
    ),
    reportedKind: "metered",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      `${tier} tier, pinned by the bench's adapter options and checked on every create.`,
      "Always provisional: the usage rows cover running intervals only (a stopped sandbox's retained disk is missing), deletion is asynchronous, and costs.incomplete only flags older events, so no cost is marked complete.",
      "A sandbox with no usage row and no workloads entry is unavailable, never $0.",
      "Plan fees, credits, volumes ($0.15/GiB-month) and tax excluded.",
    ],
  };
}

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
    storage: known(
      "included",
      "https://analytics.app.daytona.io/organization/{org}/usage/aggregated (totalPrice is totalCPUPrice + totalRAMPrice + totalDiskPrice; /usage/sandbox totalPrice sums to it; read 2026-11-16 for 2026-11-06 01:00-03:00 UTC) and https://www.daytona.io/docs/analytics-openapi.json (UsageChartPoint.diskPrice)",
    ),
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
    // Its billing lines price compute and storage at the Box rates (notes).
    pricingKey: "upstash",
    tariff: unknown("Ephemeral pricing not recorded"),
    billingStarts: unknown("Not stated"),
    billingStops: unknown("Not stated"),
    incrementSeconds: unknown("Not stated"),
    minimumSeconds: unknown("Not stated"),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Not stated"),
    countsFileCacheAsMemory: unknown("Not stated"),
    storage: known(
      "excluded",
      `${docs.upstashBilling}: ephemeral box artistic-bird-65151 (2026-11-16, 6 GiB written and held 45 minutes) has storage_bytes 6442459136, storage_gb_hours 6.442 and storage_cost_usd 0.000894786 on its line, apart from compute_cost_usd 0.000746683, which equals the box's total_compute_cost_usd`,
    ),
    settledChargeSource: known(
      "Per-box cumulative compute charge, final after deletion; equals the box's compute_cost_usd billing line",
      `${docs.upstashBox}; ${docs.upstashBilling} (all 58 Upstash boxes of SBX-100 and the 2026-11-16 boxes match to 1e-9 USD)`,
    ),
    reportedKind: "billed",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "Plan section 6 lists Upstash Ephemeral as per-sandbox; its tariff is not yet recorded.",
      "Billing lines observed 2026-11-16: compute is the medium tier price ($0.20) times CPU-seconds / 3600, as on Box, and storage is $0.10 per GB-month of bytes written (0.000894786 / 6.442 GB-hours), Box's disk rate. Storage posted as one hour of the bytes held at a single reading 25 minutes after creation. Unconfirmed by Upstash.",
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
    provider: "vercel",
    product: null,
    pricingKey: "vercel",
    tariff: known(
      { kind: "per-unit", charges: "active-cpu" },
      `${docs.vercel} (Active CPU excludes I/O wait; Provisioned Memory is allocation x run time)`,
    ),
    billingStarts: unknown("Not stated; the meter counts session wall time"),
    billingStops: unknown("Not stated; a session's meter is final once it stops"),
    incrementSeconds: unknown(
      'Memory is "billed in 1 minute minimum increments"; whole minutes assumed (the dearer reading); CPU increment not stated',
    ),
    minimumSeconds: known(60, `${docs.vercel} (provisioned memory, 1-minute minimum)`),
    perStartFeeUSD: known(0.6 / 1_000_000, `${docs.vercel} (Sandbox Creations $0.60 per million)`),
    keepsCharging: known(
      ["snapshots"],
      `${docs.vercel} (snapshot storage $0.08/GB-month; snapshots expire 30 days after last use)`,
    ),
    countsFileCacheAsMemory: notApplicable(
      "Memory is billed on the allocation, so memory use does not change the charge",
    ),
    storage: known(
      "excluded",
      `${docs.vercelSdk} (meters CPU, wall time and network bytes; disk is not billed separately)`,
    ),
    settledChargeSource: unknown(
      "Team usage and invoices need a Vercel account token with billing access; the project OIDC token the bench uses reads only sandboxes",
    ),
    reportedKind: "metered",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "Pro, iad1 rates: Active CPU $0.128 per vCPU-hour, Provisioned Memory $0.0212 per GB-hour; rates vary by region.",
      "The meter appears only after a session stops and is gone once the sandbox is deleted, so the bench stops each sandbox and reads it just before deletion.",
      "Data transfer is billed on Pro despite the pricing page's \"Included in Flat Rate CDN\": the team's charges show $0.15/GB (2026-11-09). The bench prices ingress plus egress bytes at that rate; meters saved before 2026-11-16 have no byte counters, so those costs are understated and never final.",
      "Pro's $20 monthly credit, snapshot storage and tax are excluded.",
    ],
  },
  {
    provider: "instabox",
    product: null,
    pricingKey: "instabox",
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.instabox),
    billingStarts: unknown(
      "Runtime is billed while the machine is running, not while it starts; the event is not named",
    ),
    billingStops: unknown("Runtime stops with the running state; the delete event is not named"),
    incrementSeconds: known(1, `${docs.instabox} (metered by the second)`),
    minimumSeconds: unknown("No minimum stated"),
    perStartFeeUSD: unknown("No creation fee listed; absence is not confirmation"),
    keepsCharging: known(["disk"], `${docs.instaboxBilling} (paused or stopped: disk only)`),
    countsFileCacheAsMemory: allocationCache,
    storage: known(
      "excluded",
      `${docs.instaboxBilling} (paid plans include disk across machines; snapshots are free)`,
    ),
    settledChargeSource: known(
      "Per-machine usage meter, readable after deletion",
      docs.instaboxUsage,
    ),
    reportedKind: "metered",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "The usage API is a meter (running seconds at published rates), not an invoice; the account ledger is rated hourly and is not split per machine.",
      "Plan fee, monthly credits and egress within the plan's allowance excluded.",
    ],
  },
  {
    provider: "maritime",
    product: null,
    pricingKey: "maritime",
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.maritime),
    billingStarts: unknown(
      "Billed per second while the virtual machine is awake; its first usage interval starts once it runs, a second or so after the create",
    ),
    billingStops: unknown(
      "Running time stops when the sandbox ends or pauses; the interval ends a little before the end is confirmed",
    ),
    incrementSeconds: known(1, `${docs.maritime} (billed per second, no minimum)`),
    minimumSeconds: known(0, `${docs.maritime} (no minimum)`),
    perStartFeeUSD: unknown("No creation fee listed; absence is not confirmation"),
    keepsCharging: known(
      ["disk"],
      `${docs.maritime} (a paused virtual machine is billed $0.08 per GB-month of disk, a 730-hour month, and no compute; an ended one nothing)`,
    ),
    countsFileCacheAsMemory: allocationCache,
    storage: known(
      "not-charged",
      // The billed time is running time, when disk is in the rate: adding disk at list price would count it
      // twice. Paused disk is a real, separate charge outside the intervals: see `keepsCharging`.
      `${docs.maritime} (disk is included in the running rate, so no storage fee accrues while awake; a paused sandbox's disk, $0.08/GB-month, is billed separately and is not in the usage intervals)`,
    ),
    settledChargeSource: known(
      "Per-sandbox usage intervals with their cost, readable for 7 days after the sandbox ends",
      docs.maritimeUsage,
    ),
    reportedKind: "metered",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "The usage intervals are Maritime's meter of running time (compute, disk included while awake), not an invoice.",
      "Paused-disk charges ($0.08/GB-month) are not in the usage intervals, so Maritime is left out of the held-open idle diagnostic until paused disk is accounted for separately.",
      "Plan fee, its equal monthly usage credit and tax excluded.",
    ],
  },
  microsandboxRule("microsandbox", "Standard (dedicated CPU)"),
  microsandboxRule("microsandbox-shared", "Shared (shared CPU, dedicated memory and disk)"),
  {
    provider: "baseten",
    product: null,
    pricingKey: "baseten",
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.baseten),
    billingStarts: unknown("Not stated"),
    billingStops: unknown("Not stated"),
    incrementSeconds: unknown("Not stated; one second assumed in estimates"),
    minimumSeconds: unknown("Not stated"),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Not stated"),
    countsFileCacheAsMemory: allocationCache,
    storage: unknown(
      "Files are held in sandbox memory; a mounted volume is billed as volume storage ($0.16/GB-month), which the realistic runs' estimate includes",
    ),
    settledChargeSource: unknown("No billing data we can read"),
    reportedKind: "estimate",
    attribution: "none",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "Published runtime rates; the free promotional period is excluded.",
      "A sandbox on standby (idle, no requests) is billed for storage only (docs.baseten.co/sandboxes/lifecycle); estimates price the whole lifetime at the runtime rates, an upper bound.",
    ],
  },
  {
    provider: "beam",
    product: null,
    pricingKey: "beam",
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.beam),
    billingStarts: unknown("Not stated"),
    billingStops: unknown("Not stated"),
    incrementSeconds: known(0.001, docs.beam),
    minimumSeconds: unknown("Not stated"),
    perStartFeeUSD: unknown("Not stated"),
    keepsCharging: unknown("Not stated"),
    countsFileCacheAsMemory: allocationCache,
    storage: unknown("Sandbox disk is not billed; memory snapshot storage is not stated"),
    settledChargeSource: unknown("No billing data we can read per sandbox"),
    reportedKind: "estimate",
    attribution: "none",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "Published Sandboxes rates on the Performance tier, the default; credits excluded.",
      "Billed per millisecond while the sandbox runs (beam.cloud/pricing).",
    ],
  },
  {
    provider: "archil",
    product: null,
    pricingKey: "archil",
    tariff: known({ kind: "per-unit", charges: "allocation" }, docs.archil),
    billingStarts: unknown("Compute is billed while running; the starting event is not named"),
    billingStops: unknown(
      "Compute stops when the sandbox stops or pauses; the delete event is not named",
    ),
    incrementSeconds: unknown(
      "Compute is sampled each minute; the billing increment is not stated, one second assumed in estimates",
    ),
    minimumSeconds: unknown("No minimum stated"),
    perStartFeeUSD: unknown("No per-start fee stated; absence is not confirmation"),
    keepsCharging: known(
      ["disk"],
      `${docs.archil} (stopped and paused: no compute; disk data is storage)`,
    ),
    countsFileCacheAsMemory: allocationCache,
    storage: known(
      "excluded",
      `${docs.archil} (disk data is billed as storage, $0.20/GiB-month active)`,
    ),
    settledChargeSource: known(
      "Per-sandbox usage and cost, updated about once a minute, readable for 90 days",
      docs.archilUsage,
    ),
    reportedKind: "billed",
    attribution: "per-sandbox",
    settlementMs: null,
    confirmation: unconfirmed,
    notes: [
      "$0.055/vCPU-hour and $0.020/GiB-hour while running; the usage endpoint's cost is before included allowances and prepaid credit.",
      "Lifetime expiry and the idle timeout pause a sandbox rather than delete it, so a leaked sandbox stops accruing compute but keeps its storage.",
      "Egress ($0.07/GB) and plan minimums (Developer $10/month, Team $500/month) excluded.",
    ],
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
    case "active-cpu":
      return "bills active CPU and the whole memory allocation";
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
