/**
 * The cost code's only input: the harness record (`rw-attempt/1` in `realistic/record.ts`, the
 * source of truth written to `attempts.jsonl`) joined with what billing collection adds and the
 * harness cannot know: the product, the sandbox's size, its usage and the priced charge.
 *
 * Nothing from the record is copied. `CostedAttempt` keeps the record as is and adds only values
 * derived from it (outcome, lifecycle times, effective attribution) or supplied by billing.
 */
import { z } from "zod";
import type { AttemptRecord, Attribution, IncompleteReason } from "../realistic/record.js";

const money = z.number().finite().nonnegative();
const quantity = z.number().finite().nonnegative();
const positive = z.number().finite().positive();

/** What billing collection writes per attempt, keyed by the record's `attemptId`. */
export const attemptBillingSchema = z.object({
  attemptId: z.string().min(1),
  /** Native product such as Upstash "ephemeral"; null is the provider default. */
  product: z.string().min(1).nullable(),
  allocation: z.object({
    /** The size the provider provisioned and prices, null when unknown. */
    provisioned: z.object({ cpu: positive, memoryGiB: positive, diskGiB: quantity }).nullable(),
    /** Measured inside the sandbox: CPU by cgroup quota (not `nproc`) and usable memory. */
    measured: z.object({ cpuQuota: positive.nullable(), memoryGiB: positive.nullable() }),
  }),
  /** Usage over the attempt from the provider's report or validated in-sandbox sampling. */
  usage: z
    .object({
      source: z.enum(["provider-report", "in-sandbox"]),
      /** Passed the known-burn and known-allocation scope checks on this provider. */
      validated: z.boolean(),
      cpuSeconds: quantity,
      memoryGiBSeconds: quantity,
      diskGiBSeconds: quantity.nullable(),
    })
    .nullable(),
  /** What the provider says the attempt cost. `estimate` is priced from the billing rules. */
  charge: z.discriminatedUnion("kind", [
    z.object({
      kind: z.enum(["billed", "metered"]),
      usd: money,
      /** Final: the sandbox is deleted and the provider's settlement delay has passed. */
      settled: z.boolean(),
      source: z.string().min(1),
    }),
    z.object({ kind: z.literal("estimate"), source: z.string().min(1) }),
    z.object({ kind: z.literal("unavailable"), reason: z.string().min(1) }),
  ]),
});

export type AttemptBilling = z.infer<typeof attemptBillingSchema>;

export type Allocation = AttemptBilling["allocation"];

export type Usage = NonNullable<AttemptBilling["usage"]>;

/** A billing charge, or "no-sandbox" when the attempt created nothing billable. */
export type Charge = AttemptBilling["charge"] | { readonly kind: "no-sandbox" };

/**
 * How an attempt counts: "not-run" attempts (beyond the plan's lifetime limit, or managed idle the
 * provider cannot do) are in no denominator; every other incomplete attempt is a failure.
 */
export type Outcome = "completed" | "incomplete" | "not-run";

export interface Lifecycle {
  /** The provider returned the new sandbox (end of the record's create span), epoch ms. */
  readonly createdAt: number | null;
  /** Delete requested (start of the destroy span). */
  readonly deleteRequestedAt: number | null;
  /** Deletion confirmed (end of the destroy span, only when the record says it was confirmed). */
  readonly deletedAt: number | null;
}

export interface CostedAttempt {
  /** The harness record, unchanged. */
  readonly record: AttemptRecord;
  readonly outcome: Outcome;
  readonly lifecycle: Lifecycle;
  /** The record's attribution; account-window attribution reads "none" without a clean window. */
  readonly attribution: Attribution;
  readonly product: string | null;
  readonly allocation: Allocation;
  readonly usage: Usage | null;
  readonly charge: Charge;
}

const notRun: ReadonlySet<IncompleteReason> = new Set([
  "exceeds-plan-limit",
  "not-available",
  "default-size-too-small",
]);

export function outcomeOf(record: AttemptRecord): Outcome {
  if (record.completion.kind === "completed") return "completed";

  return notRun.has(record.completion.reason) ? "not-run" : "incomplete";
}

export function lifecycleOf(record: AttemptRecord): Lifecycle {
  const create = record.phases.find((p) => p.name === "create");
  const destroy = record.phases.filter((p) => p.name === "destroy").at(-1);

  return {
    createdAt: create?.endedAt ?? null,
    deleteRequestedAt: destroy?.startedAt ?? null,
    deletedAt: destroy && record.deletionConfirmed ? destroy.endedAt : null,
  };
}

const unknownSize: Allocation = {
  provisioned: null,
  measured: { cpuQuota: null, memoryGiB: null },
};

/**
 * Only account-window attribution depends on the window being clean: per-sandbox and per-machine
 * charges are tied to our IDs whatever else ran on the account (plan section 6).
 */
function attributionOf(record: AttemptRecord): Attribution {
  const { attribution, window } = record.costEvidence;

  return attribution === "account-window" && (window === null || window.void)
    ? "none"
    : attribution;
}

/** The adapter: one harness record plus its billing entry (absent when none was collected). */
export function costedAttempt(record: AttemptRecord, billing?: AttemptBilling): CostedAttempt {
  if (billing && billing.attemptId !== record.attemptId)
    throw new Error(`Billing for ${billing.attemptId} joined to attempt ${record.attemptId}`);

  // Invariants the harness schema does not state but every cost rule relies on.
  if (record.endedAt < record.startedAt)
    throw new Error(`Attempt ${record.attemptId} ends before it starts`);

  if (record.completion.kind === "completed" && record.sandboxIds.length === 0)
    throw new Error(`Attempt ${record.attemptId} completed without a sandbox`);

  // A billing entry wins: an attempt without a recorded sandbox ID can still have one (a lost create
  // response), and its entry says so, as unavailable or with the recovered sandbox's charge.
  const charge: Charge =
    billing?.charge ??
    (record.sandboxIds.length === 0
      ? { kind: "no-sandbox" }
      : { kind: "unavailable", reason: "no billing collected for this attempt" });

  return {
    record,
    outcome: outcomeOf(record),
    lifecycle: lifecycleOf(record),
    attribution: attributionOf(record),
    product: billing?.product ?? null,
    allocation: billing?.allocation ?? unknownSize,
    usage: billing?.usage ?? null,
    charge,
  };
}

/** Join every record with its billing entry by attempt ID; billing for unknown attempts is an error. */
export function costedAttempts(
  records: readonly AttemptRecord[],
  billing: readonly AttemptBilling[],
): CostedAttempt[] {
  const byId = new Map<string, AttemptBilling>();

  for (const entry of billing) {
    if (byId.has(entry.attemptId)) throw new Error(`Duplicate billing for ${entry.attemptId}`);
    byId.set(entry.attemptId, entry);
  }

  const ids = new Set(records.map((r) => r.attemptId));

  if (ids.size !== records.length) throw new Error("Duplicate attempt IDs in the records");

  for (const id of byId.keys())
    if (!ids.has(id)) throw new Error(`Billing for unknown attempt ${id}`);

  return records.map((record) => costedAttempt(record, byId.get(record.attemptId)));
}

/** Elapsed time, the same for every provider: create request to confirmed deletion. */
export function elapsedSeconds(attempt: CostedAttempt): number {
  return (endOf(attempt) - attempt.record.startedAt) / 1000;
}

/**
 * The end of the attempt's envelope: confirmed deletion when observed. `record.endedAt` also
 * covers host-side work after deletion (writing raw output), so it is only the fallback for an
 * attempt whose deletion was never confirmed.
 */
export function endOf(attempt: CostedAttempt): number {
  return attempt.lifecycle.deletedAt ?? attempt.record.endedAt;
}
