import { z } from "zod";
import type { Json } from "../json.js";

/**
 * The one record the slot scheduler (SBX-96) writes per attempt, and the only run input the cost,
 * eligibility and statistics modules (SBX-98) read.
 *
 * An attempt is one provider running one profile on one track in one slot of one batch. It spans
 * the create request to confirmed deletion, preparation included. Every attempt is written,
 * failures, timeouts and "provider unavailable" slots included, because cost per completed task
 * divides the cost of all attempts by the completed ones.
 *
 * Fields the harness cannot know are null, never zero. Costs are USD; a provider that reports in
 * another currency is converted by the collector at the release's frozen rate, or recorded as
 * `unavailable`.
 */
export const ATTEMPT_RECORD_VERSION = 1;

/** "same-spec" is the plan's same-machine track (4 vCPU, 8 GiB); "default" is each provider's default size. */
export const tracks = ["same-spec", "default"] as const;

export type Track = (typeof tracks)[number];

const instant = z.iso.datetime();
const money = z.number().finite().nonnegative();
const quantity = z.number().finite().nonnegative();
const positive = z.number().finite().positive();

const completionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed") }),
  z.object({
    kind: z.literal("incomplete"),
    reason: z.enum(["check-failed", "timeout", "stopped", "provider-unavailable", "create-failed"]),
    detail: z.string(),
  }),
  /** Not a failure and not in the denominator: the run could not happen on this plan or size. */
  z.object({
    kind: z.literal("not-run"),
    reason: z.enum(["exceeds-plan-limit", "default-size-too-small"]),
  }),
]);

/**
 * What the provider says this attempt cost. `estimate` carries no amount: the cost module prices
 * it from the billing rules. `no-sandbox` means nothing billable was created (a failed health
 * check or create), so it costs zero.
 */
const costEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["billed", "metered"]),
    usd: money,
    /** The provider's figure is final (sandbox deleted and its settlement delay has passed). */
    settled: z.boolean(),
    /** How the charge was tied to this attempt. "none" means a shared bucket we cannot split. */
    attribution: z.enum(["per-sandbox", "per-machine", "isolated-window", "none"]),
    source: z.string().min(1),
  }),
  z.object({ kind: z.literal("estimate"), source: z.string().min(1) }),
  z.object({ kind: z.literal("no-sandbox") }),
  z.object({ kind: z.literal("unavailable"), reason: z.string().min(1) }),
]);

const allocationSchema = z.object({
  /** The size the provider provisioned and prices, null when unknown. */
  provisioned: z.object({ cpu: positive, memoryGiB: positive, diskGiB: quantity }).nullable(),
  /** Measured inside the sandbox: CPU by cgroup quota (not `nproc`) and usable memory. */
  measured: z.object({ cpuQuota: positive.nullable(), memoryGiB: positive.nullable() }),
});

/** Usage over the attempt, from the provider's own report or validated in-sandbox sampling. */
const usageSchema = z.object({
  source: z.enum(["provider-report", "in-sandbox"]),
  /** Passed the known-burn and known-allocation scope checks on this provider. */
  validated: z.boolean(),
  cpuSeconds: quantity,
  memoryGiBSeconds: quantity,
  diskGiBSeconds: quantity.nullable(),
});

const attemptRecordSchema = z
  .object({
    version: z.literal(ATTEMPT_RECORD_VERSION),
    attemptId: z.string().min(1),
    provider: z.string().min(1),
    /** Native product such as Upstash "ephemeral"; null is the provider default. */
    product: z.string().min(1).nullable(),
    profile: z.string().min(1),
    track: z.enum(tracks),
    /** Headline runs feed picks; instrumented twins and diagnostics never do. */
    purpose: z.enum(["headline", "instrumented", "diagnostic"]),
    batch: z.int().nonnegative(),
    slot: z.int().nonnegative(),
    sandboxIds: z.array(z.string().min(1)),
    /** Create request sent. */
    startedAt: instant,
    /** Deletion confirmed by the provider's API, or when the harness gave up. */
    finishedAt: instant,
    /** Provider-side lifecycle times the harness observed, used to apply billing start and stop rules. */
    lifecycle: z.object({
      createdAt: instant.nullable(),
      deleteRequestedAt: instant.nullable(),
      deletedAt: instant.nullable(),
    }),
    completion: completionSchema,
    phases: z.array(z.object({ name: z.string().min(1), startedAt: instant, finishedAt: instant })),
    allocation: allocationSchema,
    usage: usageSchema.nullable(),
    cost: costEvidenceSchema,
  })
  .superRefine((record, context) => {
    if (Date.parse(record.finishedAt) < Date.parse(record.startedAt))
      context.addIssue({ code: "custom", message: "finishedAt precedes startedAt" });

    if (record.cost.kind === "no-sandbox" && record.sandboxIds.length > 0)
      context.addIssue({ code: "custom", message: "no-sandbox cost with sandbox IDs" });

    if (record.completion.kind === "completed" && record.sandboxIds.length === 0)
      context.addIssue({ code: "custom", message: "completed attempt without a sandbox ID" });
  });

export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export type CostEvidence = AttemptRecord["cost"];

export type Completion = AttemptRecord["completion"];

/** Parse attempt records at the boundary; duplicate attempt IDs are rejected. */
export function parseAttemptRecords(raw: Json): AttemptRecord[] {
  const records = z.array(attemptRecordSchema).parse(raw);
  const ids = new Set<string>();

  for (const record of records) {
    if (ids.has(record.attemptId)) throw new Error(`Duplicate attempt ${record.attemptId}`);
    ids.add(record.attemptId);
  }

  return records;
}

/** Elapsed time, the same definition for every provider: create request to confirmed deletion. */
export function elapsedSeconds(record: AttemptRecord): number {
  return (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000;
}
