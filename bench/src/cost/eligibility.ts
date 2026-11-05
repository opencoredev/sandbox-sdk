/**
 * Who can be a pick: the plan's single eligibility table, and no other rules.
 *
 * | Cost evidence                                                                 | Pick? |
 * | ----------------------------------------------------------------------------- | ----- |
 * | Billed, settled, attributable to our sandbox IDs                              | Yes   |
 * | Metered, reconciled with settled charges, attributable                        | Yes   |
 * | Estimate with rules confirmed in writing and an isolated profile-and-track    | Yes   |
 * |   window whose settled charge reconciles within 10%                           |       |
 * | Anything else: unverified estimate, provisional, unsettled, not attributable  | Shown |
 *
 * Every pick also needs at most one incomplete run in its profile and track, and a same-machine
 * pick needs a verified 4 vCPU / 8 GiB sandbox. Reconciliation is per profile and track; a window
 * that mixes profiles counts only when every charge is attributable to its own sandbox.
 */
import type { CostedAttempt } from "./attempt-input.js";
import type { BillingRule } from "./billing-rules.js";

/** Usage at published rates against settled charges, |usage - settled| / settled. */
export const MAX_RECONCILIATION_RESIDUAL = 0.1;

/** Keeps "within 10%" true at exactly 10% despite floating-point division. */
const FLOAT_SLACK = 1e-12;

/** At most this many incomplete runs per profile and track for a pick. */
export const MAX_INCOMPLETE_RUNS = 1;

/** The harness manifest's track id for the same-machine comparison. */
export const SAME_MACHINE_TRACK = "same-machine";

/** The same-machine track's frozen target. */
export const SAME_MACHINE = { cpu: 4, memoryGiB: 8, memoryTolerance: 0.1 } as const;

export type Reconciliation =
  | {
      readonly kind: "reconciled";
      /** "profile-track": the window held only this profile's runs on this track. */
      readonly window: "profile-track" | "mixed-profiles";
      /** Our figure for the window: usage at published rates, or our estimate. */
      readonly reportedUSD: number;
      /** The provider's settled charge for the same window. */
      readonly settledUSD: number;
    }
  | { readonly kind: "not-reconciled"; readonly reason: string };

/** Accounting evidence for one provider, profile and track, also used by the sensitivity check. */
export interface CostSourceAudit {
  readonly reconciliation: Reconciliation;
  /** Meter rounding, settlement granularity and per-start minimums, in USD per attempt. */
  readonly resolutionUSDPerAttempt: number;
  /** A release-level reason to hold the figure as provisional, such as an unexplained rate change. */
  readonly provisional: string | null;
}

/** "same-machine" is the strict 4 vCPU / 8 GiB pick; "tested-size" is each provider's size on that track. */
export type Comparison = "same-machine" | "tested-size";

export type SizeCompliance =
  | { readonly kind: "compliant" }
  | { readonly kind: "non-compliant"; readonly detail: string }
  | { readonly kind: "unverified"; readonly detail: string };

export type Ineligibility =
  | { readonly kind: "no-attempts" }
  | { readonly kind: "did-not-complete" }
  | { readonly kind: "too-many-incomplete"; readonly incomplete: number }
  | { readonly kind: "cost-unavailable"; readonly attempts: number }
  | { readonly kind: "mixed-cost-kinds" }
  | { readonly kind: "unsettled"; readonly attempts: number }
  | { readonly kind: "not-attributable"; readonly attempts: number }
  | { readonly kind: "provisional"; readonly reason: string }
  | {
      readonly kind: "unverified-estimate";
      readonly missing: readonly (
        | "rules-confirmed-in-writing"
        | "isolated-window-reconciliation"
      )[];
    }
  | { readonly kind: "size"; readonly compliance: Exclude<SizeCompliance, { kind: "compliant" }> };

export type CostKind = "billed" | "metered" | "estimate";

/** Labels that travel with every published number. */
export interface FigureStatus {
  readonly costKind: CostKind | null;
  readonly settled: boolean;
  readonly provisional: string | null;
}

export type Eligibility =
  | { readonly kind: "eligible"; readonly status: FigureStatus }
  | {
      readonly kind: "ineligible";
      readonly reasons: readonly [Ineligibility, ...Ineligibility[]];
      readonly status: FigureStatus;
    };

export interface EligibilityInput {
  readonly rule: BillingRule;
  readonly comparison: Comparison;
  /** Headline attempts of one provider, profile and track. */
  readonly attempts: readonly CostedAttempt[];
  readonly audit: CostSourceAudit;
}

/** Exactly 4 vCPUs by quota and usable memory within 10% of 8 GiB, on every measured attempt. */
export function sameMachineCompliance(attempts: readonly CostedAttempt[]): SizeCompliance {
  const measured = attempts.map((a) => a.allocation.measured);

  if (measured.some((m) => m.cpuQuota === null || m.memoryGiB === null))
    return { kind: "unverified", detail: "CPU quota or memory not measured on every attempt" };

  if (measured.length === 0) return { kind: "unverified", detail: "no attempts" };

  for (const m of measured) {
    if (m.cpuQuota !== SAME_MACHINE.cpu)
      return { kind: "non-compliant", detail: `${m.cpuQuota} vCPU quota, not ${SAME_MACHINE.cpu}` };

    if (
      m.memoryGiB === null ||
      Math.abs(m.memoryGiB - SAME_MACHINE.memoryGiB) >
        SAME_MACHINE.memoryGiB * SAME_MACHINE.memoryTolerance
    )
      return {
        kind: "non-compliant",
        detail: `${m.memoryGiB} GiB memory, not within 10% of ${SAME_MACHINE.memoryGiB} GiB`,
      };
  }

  return { kind: "compliant" };
}

export interface CompletionCounts {
  /** Attempts in the denominator: completed plus incomplete. "not-run" attempts are excluded. */
  readonly attempts: number;
  readonly completed: number;
  readonly incomplete: number;
}

export function completionCounts(attempts: readonly CostedAttempt[]): CompletionCounts {
  let completed = 0,
    incomplete = 0;

  for (const attempt of attempts)
    if (attempt.outcome === "completed") completed++;
    else if (attempt.outcome === "incomplete") incomplete++;

  return { attempts: completed + incomplete, completed, incomplete };
}

function assertOneGroup(input: EligibilityInput) {
  const first = input.attempts[0];

  if (!first) return;

  for (const a of input.attempts)
    if (
      a.record.provider !== first.record.provider ||
      a.product !== first.product ||
      a.record.profile !== first.record.profile ||
      a.record.track !== first.record.track ||
      a.record.variant !== "headline"
    )
      throw new Error("Eligibility needs headline attempts of one provider, profile and track");

  if (first.record.provider !== input.rule.provider || first.product !== input.rule.product)
    throw new Error("Billing rule does not match the attempts' provider");

  if (input.comparison === "same-machine" && first.record.track !== SAME_MACHINE_TRACK)
    throw new Error(`Same-machine picks use the ${SAME_MACHINE_TRACK} track`);
}

type Reconciled = Extract<Reconciliation, { kind: "reconciled" }>;

/** How far our figure misses the settled charge, as a share of the settled charge (the 10% gate). */
export function residualFraction(r: Reconciled): number {
  return r.settledUSD > 0
    ? Math.abs(r.reportedUSD - r.settledUSD) / r.settledUSD
    : r.reportedUSD === 0
      ? 0
      : Infinity;
}

/**
 * The same miss as a share of our figure, which is what the published cost is built from, so the
 * sensitivity check moves a cost by exactly the discrepancy found in its window.
 */
export function reportedShiftFraction(r: Reconciled): number {
  return r.reportedUSD > 0
    ? Math.abs(r.reportedUSD - r.settledUSD) / r.reportedUSD
    : r.settledUSD === 0
      ? 0
      : Infinity;
}

function reconciles(reconciliation: Reconciliation, attributable: boolean): boolean {
  return (
    reconciliation.kind === "reconciled" &&
    residualFraction(reconciliation) <= MAX_RECONCILIATION_RESIDUAL + FLOAT_SLACK &&
    (reconciliation.window === "profile-track" || attributable)
  );
}

function reconciliationGap(reconciliation: Reconciliation, attributable: boolean): string {
  if (reconciliation.kind === "not-reconciled")
    return `not reconciled with settled charges: ${reconciliation.reason}`;

  if (residualFraction(reconciliation) > MAX_RECONCILIATION_RESIDUAL + FLOAT_SLACK)
    return `settled charges differ by ${(residualFraction(reconciliation) * 100).toFixed(1)}%`;

  return attributable ? "" : "reconciled only across a window that mixes profiles";
}

/** Why a billed or metered total may miss storage, or null when storage is covered. */
function storageGap(input: EligibilityInput): string | null {
  const storage = input.rule.storage;

  if (storage.kind !== "known") return "storage coverage of the billing source unknown";

  if (
    storage.value === "excluded" &&
    input.attempts.some((a) => a.charge.kind !== "no-sandbox" && a.allocation.provisioned === null)
  )
    return "billing source leaves storage out and the disk size is unknown";

  return null;
}

/** Apply the eligibility table to one provider's headline attempts in one profile and track. */
export function eligibility(input: EligibilityInput): Eligibility {
  assertOneGroup(input);
  const reasons: Ineligibility[] = [];
  const counts = completionCounts(input.attempts);

  if (input.attempts.length === 0) reasons.push({ kind: "no-attempts" });
  else if (counts.completed === 0) reasons.push({ kind: "did-not-complete" });

  if (counts.incomplete > MAX_INCOMPLETE_RUNS)
    reasons.push({ kind: "too-many-incomplete", incomplete: counts.incomplete });

  const evidence = input.attempts.flatMap((a) =>
    a.charge.kind === "no-sandbox" ? [] : [a.charge],
  );

  const unavailable = evidence.filter((e) => e.kind === "unavailable").length;

  if (unavailable > 0) reasons.push({ kind: "cost-unavailable", attempts: unavailable });
  const kinds = new Set(evidence.flatMap((e) => (e.kind === "unavailable" ? [] : [e.kind])));

  if (kinds.size > 1) reasons.push({ kind: "mixed-cost-kinds" });
  const [costKind = null] = kinds.size === 1 ? [...kinds] : [];
  let settled = true;
  let provisional = input.audit.provisional;

  const reported = input.attempts.flatMap((a) =>
    a.charge.kind === "billed" || a.charge.kind === "metered"
      ? [{ settled: a.charge.settled, attribution: a.attribution }]
      : [],
  );

  const unsettled = reported.filter((e) => !e.settled).length;
  const unattributable = reported.filter((e) => e.attribution === "none").length;

  if (unsettled > 0) {
    settled = false;
    reasons.push({ kind: "unsettled", attempts: unsettled });
  }

  if (unattributable > 0) reasons.push({ kind: "not-attributable", attempts: unattributable });

  const attributable =
    reported.length > 0 &&
    reported.every((e) => e.attribution === "per-sandbox" || e.attribution === "per-machine");

  if (costKind === "metered" && !reconciles(input.audit.reconciliation, attributable))
    provisional ??= `meter ${reconciliationGap(input.audit.reconciliation, attributable)}`;

  // The frozen cost scope includes storage: a total that may leave it out is not final.
  if (reported.length > 0) provisional ??= storageGap(input);

  if (costKind === "estimate") {
    const missing: ("rules-confirmed-in-writing" | "isolated-window-reconciliation")[] = [];

    if (input.rule.confirmation.kind !== "confirmed-in-writing")
      missing.push("rules-confirmed-in-writing");

    const isolated =
      input.audit.reconciliation.kind === "reconciled" &&
      input.audit.reconciliation.window === "profile-track" &&
      reconciles(input.audit.reconciliation, false);

    if (!isolated) missing.push("isolated-window-reconciliation");

    if (missing.length > 0) reasons.push({ kind: "unverified-estimate", missing });
  }

  if (provisional !== null) reasons.push({ kind: "provisional", reason: provisional });

  if (input.comparison === "same-machine") {
    const compliance = sameMachineCompliance(input.attempts);

    if (compliance.kind !== "compliant") reasons.push({ kind: "size", compliance });
  }

  const status: FigureStatus = { costKind, settled, provisional };
  const [first, ...rest] = reasons;

  return first
    ? { kind: "ineligible", reasons: [first, ...rest], status }
    : { kind: "eligible", status };
}

/** One line per reason, for the "shown, never a pick" flags next to a pick. */
export function describeIneligibility(reason: Ineligibility): string {
  switch (reason.kind) {
    case "no-attempts":
      return "no attempts";
    case "did-not-complete":
      return "did not complete";
    case "too-many-incomplete":
      return `${reason.incomplete} incomplete runs (at most ${MAX_INCOMPLETE_RUNS})`;
    case "cost-unavailable":
      return `cost unavailable for ${reason.attempts} attempts`;
    case "mixed-cost-kinds":
      return "attempts mix cost kinds";
    case "unsettled":
      return `unsettled (${reason.attempts} attempts)`;
    case "not-attributable":
      return `not attributable to our sandbox IDs (${reason.attempts} attempts)`;
    case "provisional":
      return `provisional: ${reason.reason}`;
    case "unverified-estimate":
      return `unverified estimate: missing ${reason.missing.join(" and ")}`;
    case "size":
      return reason.compliance.kind === "non-compliant"
        ? `wrong machine size: ${reason.compliance.detail}`
        : `machine size unverified: ${reason.compliance.detail}`;
    default: {
      const _exhaustive: never = reason;

      return _exhaustive;
    }
  }
}
