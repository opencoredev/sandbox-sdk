/**
 * The settled-charge audit a realistic summary reads (`bun bench realistic summary --audit FILE`):
 * per provider, and per profile and track for a reconciliation, what the provider's settled
 * charges say about our metered totals.
 *
 * A "reconciled" entry names the billing source, the period it covers, the provider's settled
 * charge for it and how we know the account had no other activity then. Our side of the
 * comparison is never typed in: `auditFor` recomputes it from the loaded billing and refuses the
 * entry when the period does not hold exactly the attempts it claims, when any of them has no
 * cost, or when `reportedUSD` differs from that total. A "not-reconciled" entry records why, and
 * what would unblock it. With no entry, a provider stays not reconciled.
 *
 * The eligibility rule itself (`eligibility.ts`, `MAX_RECONCILIATION_RESIDUAL`) is unchanged: the
 * file only supplies its `Reconciliation` input.
 */
import { z } from "zod";
import type { CostedAttempt } from "./attempt-input.js";
import type { CostSourceAudit, Reconciliation } from "./eligibility.js";

export const AUDIT_SCHEMA = "realistic-cost-audit/1";

/** Float noise only: our recomputed total must equal `reportedUSD` to a billionth of a dollar. */
const REPORTED_TOLERANCE_USD = 1e-9;

const usd = z.number().finite().nonnegative();
const text = z.string().trim().min(1);

const period = z
  .object({ start: z.iso.datetime(), end: z.iso.datetime() })
  .refine((p) => Date.parse(p.start) < Date.parse(p.end), "period.start must be before period.end");

const reconciledSchema = z.object({
  kind: z.literal("reconciled"),
  provider: text,
  profile: text,
  track: text,
  /** "profile-track": only this profile's runs on this track were in the period. */
  window: z.enum(["profile-track", "mixed-profiles"]),
  /** Our metered total for the period, checked against the loaded billing. */
  reportedUSD: usd,
  /** The provider's settled charge for the same period. */
  settledUSD: usd,
  /** Where the settled charge was read: an invoice, a charges API, a billing export. */
  source: text,
  period,
  /** The evidence that the account had no other activity in the period. */
  isolation: text,
  checkedAt: z.iso.date(),
});

const notReconciledSchema = z.object({
  kind: z.literal("not-reconciled"),
  provider: text,
  /** Null: every profile and track of the provider. */
  profile: text.nullable(),
  track: text.nullable(),
  reason: text,
  /** The billing source that was checked, when there is one. */
  source: text.nullable(),
  /** What would unblock a reconciliation, or null when nothing would. */
  blocked: text.nullable(),
  checkedAt: z.iso.date(),
});

const entrySchema = z.discriminatedUnion("kind", [reconciledSchema, notReconciledSchema]);

/** A duplicate entry for one provider, profile and track is an error, not a silent override. */
export const auditFileSchema = z
  .object({ schema: z.literal(AUDIT_SCHEMA), entries: z.array(entrySchema) })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();

    for (const entry of file.entries) {
      const key = [entry.provider, entry.profile ?? "*", entry.track ?? "*"].join("|");

      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `two entries for ${key}` });
      seen.add(key);
    }
  });

export type AuditFile = z.infer<typeof auditFileSchema>;

export type AuditEntry = z.infer<typeof entrySchema>;

export const noAuditFile: AuditFile = { schema: AUDIT_SCHEMA, entries: [] };

export interface AuditGroup {
  readonly provider: string;
  readonly profile: string;
  readonly track: string;
}

/** The audit a group used, with its provenance, as written to summary.json. */
export type AuditUsed = { readonly kind: "none"; readonly reason: string } | AuditEntry;

export interface AuditResult {
  readonly audit: CostSourceAudit;
  readonly used: AuditUsed;
}

const noEntryReason = "no settled-charge reconciliation recorded for this provider";

function findEntry(file: AuditFile, group: AuditGroup): AuditEntry | null {
  const own = file.entries.filter((e) => e.provider === group.provider);

  return (
    own.find((e) => e.profile === group.profile && e.track === group.track) ??
    own.find((e) => e.kind === "not-reconciled" && e.profile === null && e.track === null) ??
    null
  );
}

const overlaps = (a: CostedAttempt, start: number, end: number) =>
  a.record.startedAt < end && a.record.endedAt > start;

const inside = (a: CostedAttempt, start: number, end: number) =>
  a.record.startedAt >= start && a.record.endedAt <= end;

const groupOf = (a: CostedAttempt) => `${a.record.profile}|${a.record.track}|${a.record.variant}`;

/**
 * Our metered total for a reconciled entry's period, recomputed from the loaded attempts, or the
 * reason the entry does not describe them.
 */
function checkReconciled(
  entry: z.infer<typeof reconciledSchema>,
  group: readonly CostedAttempt[],
  provider: readonly CostedAttempt[],
): string | null {
  const start = Date.parse(entry.period.start);
  const end = Date.parse(entry.period.end);
  const label = `${entry.provider} ${entry.profile}/${entry.track}`;
  const [first] = group;

  if (first === undefined) return `${label}: no attempts to reconcile`;

  if (!group.every((a) => inside(a, start, end)))
    return `${label}: the period does not cover every attempt of this profile and track`;

  const inPeriod = provider.filter((a) => overlaps(a, start, end));

  if (!inPeriod.every((a) => inside(a, start, end)))
    return `${label}: an attempt straddles the period's edge, so the settled charge cannot be split`;

  if (entry.window === "profile-track") {
    const own = groupOf(first);

    if (inPeriod.some((a) => groupOf(a) !== own))
      return `${label}: the period also holds this provider's other profiles, tracks or variants; use "mixed-profiles"`;
  }

  let total = 0;

  for (const a of inPeriod) {
    const charge = a.charge;

    if (charge.kind === "no-sandbox") continue;

    if (charge.kind !== "billed" && charge.kind !== "metered")
      return `${label}: attempt ${a.record.attemptId} in the period has no metered cost (${charge.kind})`;
    total += charge.usd;
  }

  if (Math.abs(total - entry.reportedUSD) > REPORTED_TOLERANCE_USD)
    return `${label}: reportedUSD ${entry.reportedUSD} is not our metered total for the period, ${total}`;

  return null;
}

/**
 * The accounting evidence for one provider, profile and track. `group` is that group's headline
 * attempts; `provider` is every loaded attempt of the provider, any profile, track or variant, so
 * a reconciliation's period can be checked to hold nothing else. A reconciled entry that does not
 * match the loaded attempts throws: the audit file is wrong, and no figure is published from it.
 */
export function auditFor(input: {
  readonly file: AuditFile;
  readonly group: AuditGroup;
  readonly attempts: readonly CostedAttempt[];
  readonly providerAttempts: readonly CostedAttempt[];
}): AuditResult {
  const entry = findEntry(input.file, input.group);
  const base = { resolutionUSDPerAttempt: 0, provisional: null } as const;

  if (entry === null)
    return {
      audit: { ...base, reconciliation: { kind: "not-reconciled", reason: noEntryReason } },
      used: { kind: "none", reason: noEntryReason },
    };

  if (entry.kind === "not-reconciled")
    return {
      audit: { ...base, reconciliation: { kind: "not-reconciled", reason: entry.reason } },
      used: entry,
    };

  const problem = checkReconciled(entry, input.attempts, input.providerAttempts);

  if (problem !== null) throw new Error(`Audit file: ${problem}`);

  const reconciliation: Reconciliation = {
    kind: "reconciled",
    window: entry.window,
    reportedUSD: entry.reportedUSD,
    settledUSD: entry.settledUSD,
  };

  return { audit: { ...base, reconciliation }, used: entry };
}
