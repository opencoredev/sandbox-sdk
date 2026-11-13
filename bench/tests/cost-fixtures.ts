import {
  attemptBillingSchema,
  costedAttempt,
  type AttemptBilling,
  type CostedAttempt,
} from "../src/cost/attempt-input.js";
import type { BillingRule } from "../src/cost/billing-rules.js";
import type { CostSourceAudit } from "../src/cost/eligibility.js";
import {
  attemptRecordSchema,
  attemptSchemaVersion,
  type Attribution,
  type Completion,
  type PhaseSpan,
  type Variant,
} from "../src/realistic/record.js";

const start = Date.parse("2026-11-05T10:00:00.000Z");

/** Epoch milliseconds `seconds` after the fixture's create request. */
export const at = (seconds: number) => start + seconds * 1000;

let next = 0;

export interface AttemptSpec {
  readonly attemptId?: string;
  readonly provider?: string;
  readonly product?: string | null;
  readonly profile?: string;
  readonly track?: string;
  readonly variant?: Variant;
  readonly batch?: number;
  readonly sandboxIds?: string[];
  readonly completion?: Completion;
  /** Seconds after the create request; null leaves the event unobserved. */
  readonly createdAt?: number | null;
  readonly deleteRequestedAt?: number | null;
  /** Deletion confirmed; null means it never was. */
  readonly deletedAt?: number | null;
  readonly endedAt?: number;
  readonly attribution?: Attribution;
  readonly windowVoid?: boolean;
  /** false: no billing window at all (an empty record outside any slot). */
  readonly window?: boolean;
  readonly allocation?: AttemptBilling["allocation"];
  readonly usage?: AttemptBilling["usage"];
  readonly charge?: AttemptBilling["charge"];
  /** false: billing collected nothing for this attempt. */
  readonly billing?: boolean;
}

/**
 * A completed 300 s same-machine headline attempt as the harness writes it (`rw-attempt/1`,
 * schema-checked), with a settled per-sandbox bill, passed through the cost adapter.
 */
export function attempt(spec: AttemptSpec = {}): CostedAttempt {
  const attemptId = spec.attemptId ?? `a-${++next}`;
  const endedAt = at(spec.endedAt ?? 300);
  const createdAt = spec.createdAt === undefined ? 2 : spec.createdAt;
  const deleteRequestedAt = spec.deleteRequestedAt === undefined ? 298 : spec.deleteRequestedAt;
  const deletedAt = spec.deletedAt === undefined ? 300 : spec.deletedAt;
  const phases: PhaseSpan[] = [];

  if (createdAt !== null) phases.push({ name: "create", startedAt: at(0), endedAt: at(createdAt) });

  if (deleteRequestedAt !== null)
    phases.push({
      name: "destroy",
      startedAt: at(deleteRequestedAt),
      endedAt: deletedAt === null ? endedAt : at(deletedAt),
    });

  const record = attemptRecordSchema.parse({
    schema: attemptSchemaVersion,
    attemptId,
    runId: "fixture",
    provider: spec.provider ?? "upstash",
    profile: spec.profile ?? "fix-and-test",
    profileKind: "fix-and-test",
    track: spec.track ?? "same-machine",
    variant: spec.variant ?? "headline",
    batch: spec.batch ?? 0,
    slot: { index: 0, id: "fat-same" },
    seed: 42,
    manifestSha256: null,
    sandboxIds: spec.sandboxIds ?? [`sbx-${attemptId}`],
    startedAt: at(0),
    endedAt,
    startOffsetMs: 0,
    completion: spec.completion ?? { kind: "completed" },
    deletionConfirmed: deletedAt !== null,
    phases,
    steps: [],
    downloads: [],
    background: [],
    gaps: { count: 0, totalMs: 0, traffic: [] },
    idle: null,
    costEvidence: {
      attribution: spec.attribution ?? "per-sandbox",
      // The scheduler gives every provider its own billing window in every slot.
      window:
        spec.window === false
          ? null
          : {
              id: `w-${attemptId}`,
              provider: spec.provider ?? "upstash",
              openedAt: at(-1),
              closedAt: at(301),
              settlementMs: null,
              paddingMs: 0,
              listingScope: "account",
              listings: [],
              void: spec.windowVoid ?? false,
              voidReasons: spec.windowVoid ? ["unexpected sandbox"] : [],
            },
      usageFiles: [],
    },
    outputDir: null,
    outputError: null,
  });

  // Realistic billing writes no entry for an attempt that created nothing, unless a charge is given.
  if (spec.billing === false || (record.sandboxIds.length === 0 && spec.charge === undefined))
    return costedAttempt(record);

  const billing = attemptBillingSchema.parse({
    attemptId,
    product: spec.product ?? null,
    allocation: spec.allocation ?? {
      provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 10 },
      measured: { cpuQuota: 4, memoryGiB: 8 },
    },
    usage: spec.usage ?? null,
    charge: spec.charge ?? { kind: "billed", usd: 0.02, settled: true, source: "fixture" },
  });

  return costedAttempt(record, billing);
}

export const failed = (spec: AttemptSpec = {}) =>
  attempt({
    completion: { kind: "incomplete", reason: "check-failed", detail: "fixture" },
    ...spec,
  });

export const cleanAudit: CostSourceAudit = {
  reconciliation: { kind: "reconciled", window: "profile-track", reportedUSD: 1, settledUSD: 1 },
  resolutionUSDPerAttempt: 0,
  provisional: null,
};

export function confirmed(rule: BillingRule): BillingRule {
  return {
    ...rule,
    confirmation: { kind: "confirmed-in-writing", date: "2026-11-10", reference: "fixture" },
  };
}
