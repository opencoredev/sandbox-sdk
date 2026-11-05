/**
 * The per-attempt record: the join point between the harness (SBX-96) and the cost model, eligibility
 * and statistics (SBX-98). One record per attempt, failures, unavailable slots and paused providers
 * included, written one per line to `attempts.jsonl` in the run directory.
 *
 * Conventions:
 * - Every time is epoch milliseconds from the harness clock.
 * - `attemptId` is unique in the run; `(runId, batch, slot.index, provider)` is unique too, and is how
 *   a record pairs with the other providers' attempts in the same slot.
 * - `sandboxIds` lists every sandbox the attempt created, in order. Charges are attributed by these IDs
 *   where the provider reports per sandbox; otherwise through `costEvidence.window`.
 * - `phases` are spans on the attempt's timeline. `download` spans lie inside `prepare`; `gap` spans
 *   (harness-side think time) lie inside `workload` or `resume`. Headline time is `startedAt` (the create
 *   request) to `endedAt` (deletion confirmed), preparation included.
 * - The harness decides only completion. It never computes cost: `costEvidence` holds pointers to the
 *   evidence (sandbox IDs, the isolated billing window, account listings at its edges, usage files).
 *
 * Bump `schema` on any incompatible change.
 */
import { z } from "zod";
import type { BackgroundEvent, StepResult } from "./steps.js";
import type { DownloadRecord } from "./prepare.js";

export const attemptSchemaVersion = "rw-attempt/1";

/** What an attempt is for. Twins and diagnostics always run in their own slots. */
export const variantSchema = z.enum([
  "headline",
  "instrumented",
  "held-open",
  "zero-wait",
  "managed-idle",
  "prepared",
  "state-check",
  "live-registry",
]);

export type Variant = z.infer<typeof variantSchema>;

export const phaseSpanSchema = z.object({
  name: z.enum(["create", "prepare", "download", "workload", "gap", "idle", "resume", "destroy"]),
  startedAt: z.number(),
  endedAt: z.number(),
  label: z.string().optional(),
});

export type PhaseSpan = z.infer<typeof phaseSpanSchema>;

export const incompleteReasonSchema = z.enum([
  /** A gating step failed its frozen check. */
  "check-failed",
  /** A step hit its per-step deadline. */
  "step-timeout",
  /** The slot's frozen timeout ended the attempt. */
  "slot-timeout",
  /** Toolchain or cache fetch, hash, extraction, disk or architecture check failed. */
  "prepare-failed",
  "create-failed",
  /** The pre-slot health check failed: counted as a failed attempt. */
  "unavailable",
  /** Unavailable for 3 slots in a row earlier in this batch: not tried for the rest of it. */
  "provider-paused",
  /** The attempt would exceed the account plan's sandbox lifetime: not a failure. */
  "exceeds-plan-limit",
  /** Managed idle needs a state-preserving pause, stop or snapshot this provider lacks. */
  "not-available",
  "error",
]);

export type IncompleteReason = z.infer<typeof incompleteReasonSchema>;

export const completionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed") }),
  z.object({
    kind: z.literal("incomplete"),
    reason: incompleteReasonSchema,
    detail: z.string(),
  }),
]);

export type Completion = z.infer<typeof completionSchema>;

const failureSchema = z.looseObject({ kind: z.string() });

const ranStepSchema = z.object({
  id: z.string(),
  phase: z.enum(["prepare", "workload", "resume"]),
  gating: z.boolean(),
  startedAt: z.number(),
  endedAt: z.number(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  outputBytes: z.number(),
  outputSha256: z.string(),
  invariants: z.looseObject({}),
  failures: z.array(failureSchema),
  excluded: z.array(
    z.object({
      file: z.string(),
      name: z.string(),
      status: z.enum(["passed", "failed", "skipped", "todo"]),
    }),
  ),
  gap: z.object({ requestedMs: z.number(), startedAt: z.number(), endedAt: z.number() }).nullable(),
});

export const stepResultSchema = z.discriminatedUnion("status", [
  ranStepSchema.extend({ status: z.literal("passed") }),
  ranStepSchema.extend({ status: z.literal("failed") }),
  z.object({
    status: z.literal("blocked"),
    id: z.string(),
    phase: z.enum(["prepare", "workload", "resume"]),
    gating: z.boolean(),
    blockedBy: z.string(),
  }),
]);

/** How a provider's charges can be attributed (plan section 6). */
export const attributionSchema = z.enum(["per-sandbox", "per-machine", "account-window", "none"]);

export type Attribution = z.infer<typeof attributionSchema>;

export const accountListingSchema = z.object({
  edge: z.enum(["open", "close"]),
  at: z.number(),
  /** null when the listing call failed; the window's reconciliation is then void. */
  ids: z.array(z.string()).nullable(),
  unexpected: z.array(z.string()),
});

export type AccountListing = z.infer<typeof accountListingSchema>;

/** One provider's isolated billing window for one slot, padded to its settlement edges. */
export const billingWindowSchema = z.object({
  id: z.string(),
  provider: z.string(),
  openedAt: z.number(),
  closedAt: z.number(),
  /** Settlement edge the window was padded to, ms (boxd: 15 minutes), or null. */
  settlementMs: z.number().nullable(),
  paddingMs: z.number(),
  listings: z.array(accountListingSchema),
  /** Unexpected activity or an unreadable listing voids this window's reconciliation. */
  void: z.boolean(),
  voidReasons: z.array(z.string()),
});

export type BillingWindow = z.infer<typeof billingWindowSchema>;

export const idleSchema = z.object({
  policy: z.enum(["provider-defaults", "managed"]),
  requestedMs: z.number(),
  /** The managed-idle call made, or null for provider defaults and short gaps. */
  mechanism: z.enum(["pause", "snapshot"]).nullable(),
  stateBefore: z.string().nullable(),
  stateAfter: z.string().nullable(),
  suspendMs: z.number().nullable(),
  restoreMs: z.number().nullable(),
  /** The resume step's first command, request to result: includes any provider wake. */
  wakeLatencyMs: z.number().nullable(),
  /** Calls that reached the provider during the idle wait (must be empty for provider defaults). */
  trafficDuringIdle: z.number(),
});

export type IdleRecord = z.infer<typeof idleSchema>;

export const attemptRecordSchema = z.object({
  schema: z.literal(attemptSchemaVersion),
  attemptId: z.string(),
  runId: z.string(),
  provider: z.string(),
  profile: z.string(),
  profileKind: z.enum(["fix-and-test", "build", "session"]),
  track: z.string(),
  variant: variantSchema,
  batch: z.number().int().nonnegative(),
  slot: z.object({ index: z.number().int().nonnegative(), id: z.string() }),
  /** The published seed the batch's slot order was drawn from. */
  seed: z.number().int(),
  manifestSha256: z.string().nullable(),
  sandboxIds: z.array(z.string()),
  startedAt: z.number(),
  endedAt: z.number(),
  /** Create request time minus the slot's start: the published start offset. */
  startOffsetMs: z.number(),
  completion: completionSchema,
  /** The provider confirmed deletion. false leaves the ID for the reserved-gap cleanup. */
  deletionConfirmed: z.boolean(),
  phases: z.array(phaseSpanSchema),
  steps: z.array(stepResultSchema),
  downloads: z.array(
    z.object({
      role: z.enum(["toolchain", "dependency-cache"]),
      sha256: z.string(),
      url: z.string(),
      startedAt: z.number(),
      endedAt: z.number(),
      bytes: z.number().nullable(),
      hashOk: z.boolean(),
    }),
  ),
  background: z.array(
    z.object({
      id: z.string(),
      startStep: z.string(),
      startedAt: z.number(),
      readyAt: z.number().nullable(),
      stoppedAt: z.number().nullable(),
      shutdown: z.enum(["step", "harness", "exited", "session-end", "running"]),
    }),
  ),
  /** Harness-side gaps and every provider call that overlapped one (the requirement is none). */
  gaps: z.object({
    count: z.number().int().nonnegative(),
    totalMs: z.number(),
    traffic: z.array(
      z.object({
        gap: z.string(),
        member: z.string(),
        startedAt: z.number(),
        endedAt: z.number().nullable(),
      }),
    ),
  }),
  idle: idleSchema.nullable(),
  costEvidence: z.object({
    attribution: attributionSchema,
    window: billingWindowSchema.nullable(),
    /** Files with provider usage pulled for these sandbox IDs (written by the billing code). */
    usageFiles: z.array(z.string()),
  }),
  /** Directory holding each step's raw output, kept for inspection only. */
  outputDir: z.string().nullable(),
});

export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

// Compile-time checks that the runner's own types fit the record.
type Fits<T extends U, U> = T;

export type StepResultFits = Fits<StepResult, z.infer<typeof stepResultSchema>>;

export type DownloadFits = Fits<DownloadRecord, AttemptRecord["downloads"][number]>;

export type BackgroundFits = Fits<BackgroundEvent, AttemptRecord["background"][number]>;

export function parseAttemptRecord(line: string): AttemptRecord {
  return attemptRecordSchema.parse(JSON.parse(line));
}
