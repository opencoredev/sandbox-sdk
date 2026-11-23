/**
 * "Real tasks at once": several copies of the published Fix and test attempt started together on one
 * provider, in rounds. Each task is `runAttempt` exactly as the headline runs it (create, prepare,
 * the frozen workload and checks, delete), so its wall time has the published definition: from the
 * create request to the confirmed deletion.
 *
 * Timing only. There are no billing windows here: tasks overlap on one account by design, so no
 * charge can be tied to one task, and nothing in this module claims a cost. Spend is estimated at
 * list price only to enforce the run's ceiling.
 *
 * Around each round the provider's sandboxes are listed (the adapter's `list`, as the realistic
 * harness lists at its window edges). Anything this run created that is still there afterwards is
 * deleted and the deletion confirmed by listing again. Nothing else is ever deleted.
 *
 * Every record carries a `burst` tag: its role and round, what its create error said (the SDK's
 * code and any sandbox it named), and any failure on our side. Older records lack it.
 */
import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { z } from "zod";
import type { AttemptApp } from "./apps.js";
import { lifecycleOf } from "../cost/attempt-input.js";
import { providerMember } from "../providers.js";
import { runAttempt, SlotTimeout, type AttemptEnvironment, type AttemptPlan } from "./attempt.js";
import type { Clock } from "./gaps.js";
import type { HarnessManifest } from "./manifest.js";
import type { PrepareSettings } from "./prepare.js";
import { attemptRecordSchema, type AttemptRecord } from "./record.js";
import { emptyRecord, type SlotProvider } from "./slots.js";
import type { BlobStore } from "./steps.js";

/**
 * A burst round starts `size` tasks together. A control round runs 1 task alone in the same hour, so
 * the provider's solo time and its time under concurrency share the day and the network.
 */
export const roundRoleSchema = z.enum(["control", "burst"]);

export type RoundRole = z.infer<typeof roundRoleSchema>;

/** What a thrown create said, from the SDK's structured error. */
export const createErrorSchema = z.object({
  /** The SDK error code; null when the create threw something other than a SandboxError. */
  code: z.string().nullable(),
  /**
   * The sandbox the error named, or the one the provider's create returned after the attempt had
   * given up on it: the provider allocated it, so this run owns it.
   */
  sandboxId: z.string().nullable(),
});

export type CreateError = z.infer<typeof createErrorSchema>;

/** What the provider's own create answered, apart from what the SDK returned to the attempt. */
export type CreateOutcome =
  | { readonly kind: "created"; readonly id: string }
  | { readonly kind: "failed"; readonly error: CreateError };

/**
 * The provider with its creates observed. After an abort the SDK returns `aborted` at once and
 * drops what the provider answers later, such as Beam's half-create error naming the container it
 * allocated. Every create here is followed to the end, so the round owns any sandbox it names.
 */
export interface WatchedCreates {
  readonly provider: Provider;
  /** What each create answered, in the order they settled. */
  readonly outcomes: readonly CreateOutcome[];
  /** Waits up to `ms` for every create to settle; false when one is still in flight. */
  settle(ms: number): Promise<boolean>;
}

export function watchCreates(
  provider: Provider,
  hooks: {
    /**
     * Called as each create settles with the sandbox it names, however late: the run owns it from
     * then on, even after the task stopped waiting. Its failures are swallowed.
     */
    readonly owned?: (id: string) => Promise<void>;
    /** Every create still in flight, shared with the final sweep so it can wait for them. */
    readonly open?: Set<Promise<void>> | undefined;
  } = {},
): WatchedCreates {
  const outcomes: CreateOutcome[] = [];
  const inflight = new Set<Promise<void>>();

  const create: Provider["create"] = (input) => {
    const pending = provider.create(input);

    const settled: Promise<void> = pending
      .then(
        (info) => {
          outcomes.push({ kind: "created", id: info.id });

          return info.id;
        },
        (error) => {
          const outcome = createErrorOf(error);
          outcomes.push({ kind: "failed", error: outcome });

          return outcome.sandboxId;
        },
      )
      .then(async (id) => {
        if (id !== null) await hooks.owned?.(id).catch(() => {});
      })
      .finally(() => {
        inflight.delete(settled);
        hooks.open?.delete(settled);
      });

    inflight.add(settled);
    hooks.open?.add(settled);

    return pending;
  };

  // Every other member as the attempt's tracer sees it: bound to the adapter.
  const watched = new Proxy(provider, {
    get: (target, key) => (key === "create" ? create : providerMember(target, key)),
  });

  return {
    provider: watched,
    outcomes,
    settle: async (ms) =>
      inflight.size === 0 ||
      (await within(
        Promise.all(inflight).then(() => true),
        Math.max(0, ms),
      )) === true,
  };
}

/**
 * A failure on our side, not the provider's: "setup" is the per-task setup before any create
 * (Modal's App and its journal), "journal" a local write about a created sandbox, "runner" the
 * attempt runner throwing instead of returning a record.
 */
export const harnessFailureSchema = z.object({
  stage: z.enum(["setup", "journal", "runner"]),
  detail: z.string(),
});

export type HarnessFailure = z.infer<typeof harnessFailureSchema>;

export const burstTagSchema = z.object({
  role: roundRoleSchema,
  /** Counted within the role, from 1. */
  round: z.number().int().positive(),
  createError: createErrorSchema.nullable(),
  harness: harnessFailureSchema.nullable(),
});

export type BurstTag = z.infer<typeof burstTagSchema>;

/** A line of a burst run's attempts.jsonl: the attempt record, and its tag unless it predates it. */
export const storedRecordSchema = attemptRecordSchema.extend({ burst: burstTagSchema.optional() });

export type StoredRecord = z.infer<typeof storedRecordSchema>;

/** A record as a round produces it, always tagged. */
export type BurstRecord = AttemptRecord & { burst: BurstTag };

/** A thrown value's text. */
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createErrorOf(cause: unknown): CreateError {
  return cause instanceof SandboxError
    ? { code: cause.code, sandboxId: cause.sandboxId ?? null }
    : { code: null, sandboxId: null };
}

/**
 * Codes for a create the provider answered with a refusal, so nothing was allocated. Anything else
 * without a sandbox ID (outcome_unknown, a timeout, a generic provider error) may have allocated one.
 */
const refusalCodes: ReadonlySet<string> = new Set([
  "quota",
  "auth",
  "unsupported",
  "invalid_argument",
  "not_found",
]);

/**
 * Providers whose refusals do not prove nothing was allocated. Modal's client allocates a sandbox
 * and then waits for it to be scheduled, so even a quota or permission error can follow an
 * allocation it does not name (`failedAllocation` in modal-apps.ts keeps every such create
 * ambiguous for billing too).
 */
const allocateBeforeRefusal: ReadonlySet<string> = new Set(["modal"]);

/** A create the provider refused before allocating anything, by its code; never for Modal. */
function refusedUnallocated(provider: string, error: CreateError): boolean {
  return (
    error.sandboxId === null &&
    error.code !== null &&
    refusalCodes.has(error.code) &&
    !allocateBeforeRefusal.has(provider)
  );
}

/** The create threw without naming a sandbox, and not as a refusal: a sandbox may exist unnamed. */
export function allocationUnknown(record: StoredRecord): boolean {
  const error = record.burst?.createError;

  return (
    error !== null &&
    error !== undefined &&
    error.sandboxId === null &&
    !refusedUnallocated(record.provider, error)
  );
}

/**
 * A task's billable lifetime: the slot timeout plus the 15 minutes past it that `loadSlotProvider`
 * sets as the hard lifetime where the adapter accepts one. That margin also covers the abandon
 * grace (150 s), the attempt's own deletion (120 s) and the round's cleanup listings and deletions.
 * A provider with no hard lifetime (Upstash, Superserve, Boat) is reserved the same, but nothing
 * bounds a sandbox of it that the cleanup could not resolve (see `spendGuard`).
 */
export function billableLifetimeMs(slotTimeoutMs: number): number {
  return slotTimeoutMs + 15 * 60_000;
}

/** One listing of the provider's sandboxes; `ids` is null when the listing failed. */
export interface Listing {
  readonly at: number;
  /** Every sandbox the adapter's `list({})` returned. */
  readonly ids: readonly string[] | null;
  /** Sandboxes carrying this run's label. */
  readonly runIds: readonly string[] | null;
  readonly error: string | null;
}

/**
 * A sandbox of this run that a listing still showed after its round, or whose deletion its attempt
 * did not confirm.
 */
export interface Leftover {
  readonly id: string;
  /** destroy() resolved. */
  readonly destroyed: boolean;
  /** A listing after the destroy no longer showed it. */
  readonly goneAfter: boolean;
  /** When that listing returned; null when it still showed the sandbox or failed. */
  readonly confirmedAt: number | null;
}

/** How a task's sandbox ended, after the round's cleanup. */
export type TaskEnd =
  /** Its attempt confirmed the deletion, or it never had a sandbox. */
  | { readonly kind: "confirmed"; readonly at: number }
  /** The round's cleanup deleted what its attempt left and a listing confirmed it gone. */
  | { readonly kind: "recovered"; readonly at: number }
  /** A sandbox of it may still exist: a deletion nothing confirmed, or a create with no ID. */
  | { readonly kind: "unresolved" };

/**
 * The round's cleanup is newer than the attempt's own deletion: a sandbox the cleanup touched
 * (still listed after the round, or never confirmed deleted) ends as the cleanup found it, even when
 * its attempt confirmed the deletion. Only a sandbox the cleanup never touched keeps the attempt's
 * confirmation.
 */
export function taskEnd(record: StoredRecord, leftovers: readonly Leftover[]): TaskEnd {
  if (allocationUnknown(record)) return { kind: "unresolved" };
  let recoveredAt: number | null = null;

  for (const id of record.sandboxIds) {
    const leftover = leftovers.find((l) => l.id === id);

    if (!leftover) {
      if (record.deletionConfirmed) continue;

      return { kind: "unresolved" };
    }

    if (!leftover.destroyed || !leftover.goneAfter || leftover.confirmedAt === null)
      return { kind: "unresolved" };
    recoveredAt = Math.max(recoveredAt ?? record.endedAt, leftover.confirmedAt);
  }

  if (recoveredAt !== null) return { kind: "recovered", at: recoveredAt };

  if (record.deletionConfirmed)
    return { kind: "confirmed", at: lifecycleOf(record).deletedAt ?? record.endedAt };

  return { kind: "unresolved" };
}

export interface RoundReport {
  readonly provider: string;
  readonly round: number;
  readonly role: RoundRole;
  readonly batch: number;
  readonly size: number;
  /** When every task was released at once (after any per-task setup such as Modal's App). */
  readonly startedAt: number;
  /**
   * When the last task's sandbox was gone: its confirmed deletion, or the cleanup listing that
   * confirmed a recovered one. null while any task's sandbox is unresolved.
   */
  readonly allDoneAt: number | null;
  /** Tasks the provider allocated a sandbox for (`isAdmitted`). */
  readonly admitted: number;
  /** Attempt IDs whose sandbox may still exist after the cleanup. */
  readonly unresolved: readonly string[];
  readonly before: Listing;
  readonly after: Listing;
  /** Listed IDs present before the round that this run created earlier (should be none). */
  readonly ownBefore: readonly string[];
  readonly leftovers: readonly Leftover[];
  readonly records: readonly BurstRecord[];
}

export interface RoundPlan {
  readonly runId: string;
  /** The round's number within its role: control rounds and burst rounds each count from 1. */
  readonly round: number;
  /** Default "burst". */
  readonly role?: RoundRole;
  /**
   * The records' `batch`, unique per provider in the run. Defaults to `round`; a run that
   * interleaves control rounds numbers its rounds in the order they run.
   */
  readonly batch?: number;
  readonly size: number;
  readonly manifest: HarnessManifest;
  readonly manifestSha256: string | null;
  readonly profileName: string;
  readonly track: string;
  readonly entry: SlotProvider;
  readonly clock: Clock;
  readonly blobs: BlobStore;
  readonly prepare: PrepareSettings;
  readonly outputDir?: string;
  /**
   * Every sandbox ID this run created on this provider so far; this round adds to it, including a
   * sandbox a create names after its task stopped waiting.
   */
  readonly created: Set<string>;
  /** Creates still in flight, shared across rounds so the final sweep can wait for them. */
  readonly openCreates?: Set<Promise<void>>;
  /**
   * Attempts whose create named its sandbox only after the task stopped waiting, so the saved
   * record still says the allocation is unknown. The final sweep reads this before calling one
   * unknown.
   */
  readonly namedLate?: Set<string>;
  readonly listTimeoutMs?: number;
  /** How long the cleanup waits for each deletion. Default 120 s, as an attempt's own. */
  readonly destroyTimeoutMs?: number;
  /** How long past the slot timeout a task that ignores the abort is waited for. Default 150 s. */
  readonly timeoutGraceMs?: number;
  onRecord(record: BurstRecord): Promise<void>;
  onSandbox?(id: string): Promise<void>;
  /** Injected in tests; defaults to `runAttempt`. */
  readonly attempt?: typeof runAttempt;
}

/** The slot ID of task `task` in a round: `r1-t0` for a burst round, `c1-t0` for a control round. */
export function taskSlotId({
  role,
  round,
  task,
}: {
  role: RoundRole;
  round: number;
  task: number;
}) {
  return `${role === "control" ? "c" : "r"}${round}-t${task}`;
}

/** The attempt ID of task `task` in round `round` (a burst round unless `role` says otherwise). */
export function taskAttemptId({
  runId,
  provider,
  round,
  task,
  role = "burst",
}: {
  runId: string;
  provider: string;
  round: number;
  task: number;
  role?: RoundRole;
}) {
  return `${runId}-${taskSlotId({ role, round, task })}-${provider}`;
}

/** Resolve with the value, or null once `ms` passes. The timer is always cleared. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The adapter's listing, all of it and this run's label, bounded by `timeoutMs`. */
export async function listSandboxes(
  entry: SlotProvider,
  runId: string,
  clock: Clock,
  timeoutMs: number,
): Promise<Listing> {
  const at = clock.now();

  const ids = async (labels: Record<string, string>) => {
    const items = await within(entry.provider.list(labels), timeoutMs);

    if (items === null) throw new Error(`Listing timed out after ${timeoutMs} ms`);

    return items.map((item) => item.id);
  };

  try {
    const [all, run] = await Promise.all([ids({}), ids({ "sandbox-bench-run": runId })]);

    return { at, ids: all, runIds: run, error: null };
  } catch (error) {
    return {
      at,
      ids: null,
      runIds: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** This run's sandboxes in a listing: IDs it recorded creating, and anything carrying its label. */
export function ownIn(listing: Listing, created: ReadonlySet<string>): string[] {
  const listed = [...(listing.ids ?? []), ...(listing.runIds ?? [])];

  return [...new Set(listed.filter((id) => created.has(id) || listing.runIds?.includes(id)))];
}

/**
 * One round: every task is prepared (Modal's per-attempt App), then all are released together; each
 * runs the published attempt under the profile's slot timeout. The round ends when every task has
 * returned. Its listings bracket it, and anything of ours still listed afterwards is deleted.
 */
export async function runRound(plan: RoundPlan): Promise<RoundReport> {
  const { clock, entry } = plan;
  const profile = plan.manifest.profiles[plan.profileName];

  if (!profile) throw new Error(`Unknown profile ${plan.profileName}`);
  const listTimeoutMs = plan.listTimeoutMs ?? 30_000;
  const destroyTimeoutMs = plan.destroyTimeoutMs ?? 120_000;
  const graceMs = plan.timeoutGraceMs ?? 150_000;
  const attempt = plan.attempt ?? runAttempt;
  const role = plan.role ?? "burst";
  const batch = plan.batch ?? plan.round;
  const before = await listSandboxes(entry, plan.runId, clock, listTimeoutMs);
  const ownBefore = ownIn(before, plan.created);
  const tasks = Array.from({ length: plan.size }, (_, task) => task);

  const base = (task: number, startedAt: number) => ({
    runId: plan.runId,
    attemptId: taskAttemptId({
      runId: plan.runId,
      provider: entry.name,
      round: plan.round,
      task,
      role,
    }),
    manifest: plan.manifest,
    manifestSha256: plan.manifestSha256,
    profileName: plan.profileName,
    track: plan.track,
    variant: "concurrent" as const,
    batch,
    slot: { index: task, id: taskSlotId({ role, round: plan.round, task }) },
    seed: 0,
    slotStartedAt: startedAt,
  });

  /** What a task saw that its record alone does not say: its create error and our-side failures. */
  interface Seen {
    createError: CreateError | null;
    harness: HarnessFailure | null;
  }

  /**
   * Tag the record. A sandbox the task owns that its record does not list (one its create error
   * named, or one the provider's create returned after the attempt gave up on it) joins the record's
   * IDs with its deletion unconfirmed, so the cleanup and the final sweep delete it by ID. A create
   * that threw with no ID, other than a refusal, leaves the deletion unconfirmed too.
   */
  const tag = (record: AttemptRecord, seen: Seen, owned: readonly string[]): BurstRecord => {
    const missing = owned.filter((id) => !record.sandboxIds.includes(id));

    if (missing.length) {
      record.sandboxIds = [...record.sandboxIds, ...missing];
      record.deletionConfirmed = false;
    }

    const burst: BurstTag = {
      role,
      round: plan.round,
      createError: seen.createError,
      harness: seen.harness,
    };

    const tagged: BurstRecord = Object.assign(record, { burst });

    if (allocationUnknown(tagged)) tagged.deletionConfirmed = false;

    return tagged;
  };

  const failed = (task: number, startedAt: number, detail: string, ids: string[]) => {
    const record = emptyRecord(
      { ...base(task, startedAt), provider: entry.name },
      "error",
      detail,
      clock.now(),
      entry.attribution,
    );

    record.sandboxIds = ids;
    record.deletionConfirmed = ids.length === 0;

    if (entry.volumeGiB !== undefined) record.volumeGiB = entry.volumeGiB;

    if (entry.diskGiB !== undefined) record.diskGiB = entry.diskGiB;

    return record;
  };

  // Per-task setup outside the timed attempt (Modal's App), so the creates start together. A setup
  // that ignores the abort is raced against the deadline, as the headline runner does, so one
  // stalled lookup cannot hold the release.
  const setupDeadline = profile.slotTimeoutMs;

  const apps = await Promise.all(
    tasks.map(async (task): Promise<{ app: AttemptApp | null; error: string | null }> => {
      if (!entry.beforeAttempt) return { app: null, error: null };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), setupDeadline);

      try {
        const app = await within(
          entry.beforeAttempt(base(task, 0).attemptId, controller.signal),
          setupDeadline,
        );

        if (app) return { app, error: null };
        // Past the deadline: abort so a late setup journals no create it will never submit.
        controller.abort();

        return {
          app: null,
          error: `Our side: per-attempt setup was not ready within ${setupDeadline} ms; no create was submitted`,
        };
      } catch (error) {
        return {
          app: null,
          error: `Our side: per-attempt setup failed: ${message(error)}`,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const startedAt = clock.now();
  const deadline = startedAt + profile.slotTimeoutMs;

  const records = await Promise.all(
    tasks.map(async (task): Promise<BurstRecord> => {
      const prepared = apps[task];
      const seen: Seen = { createError: null, harness: null };

      if (prepared?.error) {
        seen.harness = { stage: "setup", detail: prepared.error };

        return tag(failed(task, startedAt, prepared.error, []), seen, []);
      }

      const app = prepared?.app ?? null;
      const controller = new AbortController();
      const ids: string[] = [];
      /** IDs whose creation is written down (the App journal and the run's notes). */
      const journaled = new Set<string>();
      /** Set once the task stopped waiting on its creates: later IDs are journaled as they come. */
      let closed = false;

      const own = (id: string) => {
        if (!ids.includes(id)) ids.push(id);
        plan.created.add(id);
      };

      /** Journal writes, as for a failed create: one failing must not skip another. */
      const journal = async (id: string) => {
        if (journaled.has(id)) return;
        journaled.add(id);
        await Promise.allSettled([app?.created(id), plan.onSandbox?.(id)]);
      };

      // Every ID a create names joins the run's ownership set when the create settles, however
      // late; one that settles after the task stopped waiting is journaled then too.
      const creates = watchCreates(entry.provider, {
        owned: async (id) => {
          own(id);

          if (closed) {
            plan.namedLate?.add(base(task, 0).attemptId);
            await journal(id);
          }
        },
        open: plan.openCreates,
      });

      /**
       * After the attempt: wait (to the task's bound) for a create the SDK stopped waiting on, own
       * any sandbox it names and journal it, and replace the SDK's `aborted` with the provider's own
       * answer. A create still in flight at the bound leaves the allocation unknown in the record,
       * and the settlement itself owns and journals whatever it names later.
       */
      const settleCreates = async () => {
        await creates.settle(deadline + graceMs - clock.now());
        closed = true;
        const late: string[] = [];

        for (const outcome of creates.outcomes) {
          const id = outcome.kind === "created" ? outcome.id : outcome.error.sandboxId;

          if (id !== null) {
            own(id);
            late.push(id);
          }
        }

        const error = seen.createError;
        const answer = creates.outcomes.at(-1);

        if (error !== null && error.sandboxId === null && answer)
          seen.createError =
            answer.kind === "created" ? { code: error.code, sandboxId: answer.id } : answer.error;

        await Promise.all(late.map(journal));
      };

      const environment: AttemptEnvironment = {
        clock,
        signal: controller.signal,
        blobs: plan.blobs,
        prepare: plan.prepare,
        attribution: entry.attribution,
        onSandbox: async (_, id) => {
          own(id);
          journaled.add(id);

          try {
            await app?.created(id);
            await plan.onSandbox?.(id);
          } catch (error) {
            // A local write failed: the attempt stops, and the failure is ours, not the provider's.
            seen.harness ??= {
              stage: "journal",
              detail: `Our side: journaling sandbox ${id} failed: ${message(error)}`,
            };
            throw error;
          }
        },
        onCreateFailed: async (_, cause) => {
          seen.createError = createErrorOf(cause);
          const named = seen.createError.sandboxId;

          if (named !== null) {
            own(named);
            journaled.add(named);
          }

          // Both are journal writes; one failing must not skip the other.
          await Promise.allSettled([
            app?.failed(cause),
            named === null ? undefined : plan.onSandbox?.(named),
          ]);
        },
        afterDestroy: async (_, id) => {
          await app?.destroyed(id);
        },
      };

      if (plan.outputDir) environment.outputDir = plan.outputDir;
      const capture = entry.beforeDestroy;

      if (capture) environment.beforeDestroy = (_, id) => capture(id);

      const attemptPlan: AttemptPlan = {
        ...base(task, startedAt),
        provider: { name: entry.name, provider: creates.provider },
      };

      if (entry.create) attemptPlan.create = entry.create(plan.track);

      if (entry.workdir) attemptPlan.workdir = entry.workdir;

      if (entry.volumeGiB !== undefined) attemptPlan.volumeGiB = entry.volumeGiB;

      if (entry.diskGiB !== undefined) attemptPlan.diskGiB = entry.diskGiB;

      if (entry.runLabelOnly) attemptPlan.runLabelOnly = true;

      if (entry.uploadConcurrency !== undefined)
        attemptPlan.uploadConcurrency = entry.uploadConcurrency;
      const vcpu = entry.vcpuFor?.(plan.track);

      if (vcpu !== undefined) attemptPlan.vcpu = vcpu;

      if (app) attemptPlan.labels = app.labels;

      const abort = setTimeout(
        () => controller.abort(new SlotTimeout(`Round ${plan.round} reached its frozen timeout`)),
        Math.max(0, deadline - clock.now()),
      );

      const invokedAt = clock.now();

      try {
        const outcome = await within(
          attempt(attemptPlan, environment).then(({ record }) => record),
          Math.max(0, deadline + graceMs - clock.now()),
        );

        if (outcome) {
          await settleCreates();

          return tag(outcome, seen, ids);
        }

        await settleCreates();

        const abandoned = failed(
          task,
          startedAt,
          "The attempt did not return within the slot timeout plus its grace; abandoned",
          ids,
        );

        abandoned.completion = {
          kind: "incomplete",
          reason: "slot-timeout",
          detail: "The attempt did not return within the slot timeout plus its grace; abandoned",
        };
        abandoned.startedAt = invokedAt;
        abandoned.startOffsetMs = invokedAt - startedAt;

        return tag(abandoned, seen, ids);
      } catch (error) {
        // runAttempt records every provider failure itself; one that throws is a harness bug.
        seen.harness ??= {
          stage: "runner",
          detail: `Our side: the attempt runner threw: ${message(error)}`,
        };
        await settleCreates();

        return tag(failed(task, startedAt, message(error), ids), seen, ids);
      } finally {
        clearTimeout(abort);
      }
    }),
  );

  // Records are written before the cleanup, so a crash during it leaves their IDs for the final
  // sweep. A failed write must not skip the cleanup: it is thrown once the cleanup is done.
  const writeFailures: unknown[] = [];

  for (const record of records)
    try {
      await plan.onRecord(record);
    } catch (error) {
      writeFailures.push(error);
    }

  // After the round: whatever of ours is still listed, plus any ID whose deletion was not
  // confirmed (a provider may stop listing a sandbox whose delete failed), is destroyed again.
  const after = await listSandboxes(entry, plan.runId, clock, listTimeoutMs);
  const unconfirmed = records.flatMap((r) => (r.deletionConfirmed ? [] : r.sandboxIds));
  const targets = [...new Set([...ownIn(after, plan.created), ...unconfirmed])];

  // Deleted together, so a slow deletion does not keep the others billing behind it.
  const destroyed = new Map(
    await Promise.all(
      targets.map(
        async (id) =>
          [
            id,
            (await within(
              entry.provider
                .destroy(id)
                .then(() => true)
                .catch(() => false),
              destroyTimeoutMs,
            )) ?? false,
          ] as const,
      ),
    ),
  );

  const recheck = targets.length
    ? await listSandboxes(entry, plan.runId, clock, listTimeoutMs)
    : after;

  const checkedAt = clock.now();

  const leftovers = targets.map((id): Leftover => {
    const goneAfter =
      recheck.ids !== null && !recheck.ids.includes(id) && !recheck.runIds?.includes(id);

    return {
      id,
      destroyed: destroyed.get(id) ?? false,
      goneAfter,
      confirmedAt: goneAfter ? checkedAt : null,
    };
  });

  // The last task's end: its confirmed deletion, as its wall time ends (host-side output writing
  // after the deletion is not counted), or the listing that confirmed a recovered one gone. With
  // any sandbox unresolved the round has no all-done time.
  const ends = records.map((record) => ({ record, end: taskEnd(record, leftovers) }));

  const unresolved = ends.flatMap(({ record, end }) =>
    end.kind === "unresolved" ? [record.attemptId] : [],
  );

  const allDoneAt = unresolved.length
    ? null
    : Math.max(
        startedAt,
        ...ends.map(({ end }) => (end.kind === "unresolved" ? startedAt : end.at)),
      );

  if (writeFailures.length)
    throw new AggregateError(
      writeFailures,
      `Writing ${writeFailures.length} attempt record(s) failed: ${message(writeFailures[0])}`,
    );

  return {
    provider: entry.name,
    round: plan.round,
    role,
    batch,
    size: plan.size,
    startedAt,
    allDoneAt,
    admitted: records.filter(isAdmitted).length,
    unresolved,
    before,
    after,
    ownBefore,
    leftovers,
    records,
  };
}

const round3 = (value: number | null) => (value === null ? null : Math.round(value * 1000) / 1000);

/** Where a task stopped, for the published failure line. */
export type FailureStage =
  | "account-limit"
  | "create"
  | "prepare"
  | "workload"
  | "timeout"
  | "delete";

export interface TaskResult {
  readonly round: number;
  readonly wallS: number;
  /**
   * Seconds spent uploading the toolchain and the dependency cache from the host into the sandbox
   * (the attempt's `download` spans, which lie inside prepare); null when no upload was recorded.
   */
  readonly uploadS: number | null;
  readonly completed: boolean;
  readonly failure?: { readonly stage: FailureStage; readonly reason: string };
}

/**
 * Records from before the burst tag carry only the error's message, so they are still read by it.
 * The published run (rtb1119-seq1) had no create failures, so none of its numbers depend on this.
 */
const legacyAccountLimitPattern =
  /\bquota\b|rate.?limit|too many (requests|sandboxes|machines)|\b429\b|concurrency limit|limit (reached|exceeded)|exceeds? (the |your )?(account|plan|org)/i;

/**
 * A create the provider refused for an account limit before allocating anything: the SDK's `quota`
 * code with no sandbox named. Not an attempt. A quota error that names a sandbox was admitted and
 * failed later, so it stays a create failure, as does every other code. A Modal quota error may
 * follow an allocation it does not name, so it is never one.
 */
export function isAccountLimit(record: StoredRecord): boolean {
  if (record.completion.kind !== "incomplete" || record.completion.reason !== "create-failed")
    return false;

  if (allocateBeforeRefusal.has(record.provider)) return false;

  if (!record.burst) return legacyAccountLimitPattern.test(record.completion.detail);
  const error = record.burst.createError;

  return error !== null && error.code === "quota" && refusedUnallocated(record.provider, error);
}

/**
 * The provider allocated the task a sandbox: its record names one, and it did not fail on our side.
 * A create refused for any reason (an account limit, auth, a bad argument) or one whose outcome is
 * unknown allocated nothing that can be shown, so it is not admitted; a refusal other than an
 * account limit still counts as a failed attempt.
 */
export function isAdmitted(record: StoredRecord): boolean {
  return harnessFailureOf(record) === null && record.sandboxIds.length > 0;
}

/** The task failed on our side; it is not a provider attempt. Older records never say so. */
export function harnessFailureOf(record: StoredRecord): HarnessFailure | null {
  return record.burst?.harness ?? null;
}

/** Seconds from the create request to the confirmed deletion (or the record's end without one). */
export function wallSeconds(record: AttemptRecord): number {
  return ((lifecycleOf(record).deletedAt ?? record.endedAt) - record.startedAt) / 1000;
}

/** Seconds in the attempt's uploads (its `download` spans), or null when it recorded none. */
export function uploadSeconds(record: AttemptRecord): number | null {
  const spans = record.phases.filter((p) => p.name === "download");

  if (spans.length === 0) return null;

  return spans.reduce((sum, p) => sum + (p.endedAt - p.startedAt), 0) / 1000;
}

/** The stage of the last phase the attempt started before its sandbox was deleted. */
function stageReached(record: AttemptRecord): FailureStage {
  const fallback: FailureStage = record.sandboxIds.length ? "prepare" : "create";

  for (const phase of [...record.phases].sort((a, b) => b.startedAt - a.startedAt))
    switch (phase.name) {
      case "gap":
      case "destroy":
        continue;
      case "create":
        return fallback;
      case "prepare":
      case "download":
        return "prepare";
      case "workload":
      case "idle":
      case "resume":
        return "workload";
      default: {
        const _exhaustive: never = phase.name;

        return _exhaustive;
      }
    }

  return fallback;
}

/**
 * One task as published: wall time, upload time, whether it passed its checks, and where it failed.
 * `round` defaults to the record's batch. `leftovers` are its round's cleanup results: how the task's
 * sandbox ended is taken from them (`taskEnd`), so a sandbox the cleanup found still running and
 * could not delete is not a completed task even when its attempt confirmed the deletion, and one the
 * cleanup deleted ends when the cleanup confirmed it gone.
 */
export function taskResult(
  record: StoredRecord,
  redact: (text: string) => string = (text) => text,
  round: number = record.batch,
  leftovers: readonly Leftover[] = [],
): TaskResult {
  const end = taskEnd(record, leftovers);

  const wallMs = end.kind === "unresolved" ? wallSeconds(record) * 1000 : end.at - record.startedAt;

  const wallS = Math.round(wallMs) / 1000;
  const uploadS = round3(uploadSeconds(record));
  const short = (text: string) => redact(text).replace(/\s+/g, " ").slice(0, 300);

  if (record.completion.kind === "completed") {
    if (end.kind !== "unresolved") return { round, wallS, uploadS, completed: true };

    return {
      round,
      wallS,
      uploadS,
      completed: false,
      failure: { stage: "delete", reason: "Passed its checks, but its deletion was not confirmed" },
    };
  }

  const { reason, detail } = record.completion;

  const stage: FailureStage = isAccountLimit(record)
    ? "account-limit"
    : reason === "slot-timeout"
      ? "timeout"
      : reason === "create-failed"
        ? "create"
        : reason === "prepare-failed"
          ? "prepare"
          : stageReached(record);

  return {
    round,
    wallS,
    uploadS,
    completed: false,
    failure: { stage, reason: short(`${reason}: ${detail}`) },
  };
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length === 0) return null;

  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** A task's record and the round it ran in, counted within its role (control or burst). */
export interface RoundTask {
  readonly round: number;
  readonly record: StoredRecord;
  /** Its round's cleanup results; none when the round line predates them or was never written. */
  readonly leftovers?: readonly Leftover[];
}

/** What a provider's slowdown divides by. */
export type SoloBaseline =
  /** The provider's published solo median, from another day. */
  | { readonly kind: "published"; readonly medianWallS: number | null }
  /** This run's control tasks, each run alone in the same hour as the burst rounds. */
  | { readonly kind: "same-day"; readonly tasks: readonly RoundTask[] };

/** The same-day control tasks of a provider. */
export interface SoloRun {
  readonly tasks: readonly TaskResult[];
  readonly completed: number;
  readonly attempts: number;
}

/**
 * A task that failed on our side, published apart from the provider's attempts; or, with stage
 * "round", a whole round that threw before it finished, whose tasks are left out of every count.
 */
export interface HarnessTask {
  readonly role: RoundRole;
  readonly round: number;
  readonly stage: HarnessFailure["stage"] | "round";
  readonly reason: string;
}

/** A round that threw before it finished (a record write, the runner): rounds.jsonl marks it. */
export interface FailedRound {
  readonly role: RoundRole;
  readonly round: number;
  readonly reason: string;
}

/** One burst round as published: how many of its tasks the provider admitted, and its all-done time. */
export interface BurstRound {
  readonly round: number;
  readonly size: number;
  /** Tasks the provider allocated a sandbox for (`isAdmitted`). */
  readonly admitted: number;
  /** Seconds from the release until the last task's sandbox was gone; null when unresolved. */
  readonly allDoneS: number | null;
}

/** One provider in the site data file. */
export type ProviderBurst = {
  readonly provider: string;
  /** The burst tasks. */
  readonly tasks: readonly TaskResult[];
  /** Median wall time of completed tasks under concurrency, as the published solo median. */
  readonly medianWallS: number | null;
  /** Median upload time of the completed burst tasks. */
  readonly medianUploadS: number | null;
  readonly completed: number;
  /** Tasks that ran; creates an account limit refused are not attempts. */
  readonly attempts: number;
  /**
   * Per burst round with at least one task admitted and a known end, seconds from the release of
   * its tasks until the last one finished.
   */
  readonly roundAllDoneS: readonly number[];
  /** Every burst round that ran, with its admitted count. */
  readonly burstRounds: readonly BurstRound[];
  /** Burst rounds the run skipped (the spend ceiling, an earlier round's failure). */
  readonly skippedBurstRounds: readonly number[];
  /** Tasks, burst or control, and whole rounds, that failed on our side: in no count above. */
  readonly harnessFailures: readonly HarnessTask[];
  /** The same-day control tasks; null when the baseline is the published solo median. */
  readonly solo: SoloRun | null;
  /** Median wall time of the completed control tasks, or the published solo median. */
  readonly soloMedianWallS: number | null;
  /** Median upload time of the completed control tasks; null with the published baseline. */
  readonly soloMedianUploadS: number | null;
  /**
   * The median wall time of the completed tasks in burst rounds that had every task admitted, over
   * soloMedianWallS; null when withheld. A partly admitted round did not run at the requested
   * concurrency, so its tasks are left out (medianWallS keeps them).
   */
  readonly slowdown: number | null;
  /**
   * The same ratio with each task's upload taken out of its wall time: the median of
   * (wall - upload) over the same fully admitted rounds, over the same median for the control tasks.
   */
  readonly slowdownWithoutUpload: number | null;
  /** Why both slowdowns are withheld: no burst round ran at the requested size. */
  readonly slowdownWithheld: string | null;
} & ({ readonly status: "ran" } | { readonly status: "not-run"; readonly reason: string });

export interface RoundTiming {
  readonly round: number;
  /** Tasks the round started. */
  readonly size: number;
  readonly startedAt: number;
  /** null when a sandbox of the round was left unresolved. */
  readonly allDoneAt: number | null;
}

const ratio = (top: number | null, bottom: number | null) =>
  top !== null && bottom !== null && bottom > 0 ? Math.round((top / bottom) * 1000) / 1000 : null;

/**
 * Tasks as published, in round and slot order, and the medians over the ones that ran and passed.
 * Tasks that failed on our side are set apart: they are not the provider's.
 */
function tally(tasks: readonly RoundTask[], redact?: (text: string) => string) {
  const sorted = [...tasks].sort(
    (a, b) => a.round - b.round || a.record.slot.index - b.record.slot.index,
  );

  const harness = sorted.flatMap(({ round, record }) => {
    const failure = harnessFailureOf(record);

    return failure ? [{ round, failure }] : [];
  });

  const results = sorted
    .filter(({ record }) => harnessFailureOf(record) === null)
    .map(({ round, record, leftovers }) => taskResult(record, redact, round, leftovers));

  const ran = results.filter((t) => t.failure?.stage !== "account-limit");
  const done = ran.filter((t) => t.completed);

  const withUpload = done.flatMap((t) =>
    t.uploadS === null ? [] : [{ wallS: t.wallS, uploadS: t.uploadS }],
  );

  return {
    results,
    harness,
    ran,
    done,
    medianWallS: round3(median(done.map((t) => t.wallS))),
    medianUploadS: round3(median(withUpload.map((t) => t.uploadS))),
    medianWithoutUploadS: round3(median(withUpload.map((t) => t.wallS - t.uploadS))),
  };
}

/**
 * A provider's row. `tasks` are the burst tasks; `solo` is the baseline. `notRun` is a reason it
 * never ran (an account limit known in advance, the budget). A provider with no burst attempt is
 * not run either: every create refused by an account limit (the provider's refusal is the reason),
 * or every task failed on our side. The slowdowns are withheld unless some burst round had all its
 * tasks admitted, since a partly admitted round did not run at the requested concurrency.
 */
export function summarizeProvider({
  provider,
  tasks: allTasks,
  rounds,
  solo: givenSolo,
  notRun,
  skipped = [],
  failed = [],
  redact = (text) => text,
}: {
  provider: string;
  tasks: readonly RoundTask[];
  rounds: readonly RoundTiming[];
  solo: SoloBaseline;
  notRun?: string;
  /** Burst rounds the run skipped. */
  skipped?: readonly number[];
  /** Rounds, burst or control, that threw before they finished: their tasks are left out. */
  failed?: readonly FailedRound[];
  redact?: (text: string) => string;
}): ProviderBurst {
  const short = (text: string) => redact(text).replace(/\s+/g, " ").slice(0, 300);

  const kept = (role: RoundRole, list: readonly RoundTask[]) =>
    list.filter((t) => !failed.some((f) => f.role === role && f.round === t.round));

  const tasks = kept("burst", allTasks);

  const solo: SoloBaseline =
    givenSolo.kind === "same-day"
      ? { kind: "same-day", tasks: kept("control", givenSolo.tasks) }
      : givenSolo;

  const burst = tally(tasks, redact);

  const burstRounds = [...rounds]
    .sort((a, b) => a.round - b.round)
    .map(
      (r): BurstRound => ({
        round: r.round,
        size: r.size,
        admitted: tasks.filter((t) => t.round === r.round && isAdmitted(t.record)).length,
        allDoneS: r.allDoneAt === null ? null : Math.round(r.allDoneAt - r.startedAt) / 1000,
      }),
    );

  const roundAllDoneS = burstRounds.flatMap((r) =>
    r.admitted > 0 && r.allDoneS !== null ? [r.allDoneS] : [],
  );

  const baseline = (() => {
    switch (solo.kind) {
      case "published":
        return {
          solo: null,
          soloMedianWallS: solo.medianWallS,
          soloMedianUploadS: null,
          withoutUploadS: null,
          harness: [],
        };
      case "same-day": {
        const control = tally(solo.tasks, redact);

        return {
          solo: {
            tasks: control.results,
            completed: control.done.length,
            attempts: control.ran.length,
          },
          soloMedianWallS: control.medianWallS,
          soloMedianUploadS: control.medianUploadS,
          withoutUploadS: control.medianWithoutUploadS,
          harness: control.harness,
        };
      }

      default: {
        const _exhaustive: never = solo;

        return _exhaustive;
      }
    }
  })();

  const harnessFailures: HarnessTask[] = [
    ...baseline.harness.map(({ round, failure }) => ({ role: "control" as const, round, failure })),
    ...burst.harness.map(({ round, failure }) => ({ role: "burst" as const, round, failure })),
  ]
    .map(
      ({ role, round, failure }): HarnessTask => ({
        role,
        round,
        stage: failure.stage,
        reason: short(failure.detail),
      }),
    )
    .concat(
      [...failed]
        .sort((a, b) => a.round - b.round || a.role.localeCompare(b.role))
        .map((f) => ({ role: f.role, round: f.round, stage: "round", reason: short(f.reason) })),
    );

  // The slowdown compares runs at the requested concurrency: only fully admitted rounds count.
  const fullRounds = new Set(burstRounds.filter((r) => r.admitted >= r.size).map((r) => r.round));
  const full = fullRounds.size > 0;

  const atSize = tally(
    tasks.filter((t) => fullRounds.has(t.round)),
    redact,
  );

  const slowdownWithheld = full
    ? null
    : burstRounds.length === 0
      ? "No burst round ran"
      : `No burst round had all ${Math.max(...burstRounds.map((r) => r.size))} of its tasks admitted`;

  const common = {
    provider,
    tasks: burst.results,
    medianWallS: burst.medianWallS,
    medianUploadS: burst.medianUploadS,
    completed: burst.done.length,
    attempts: burst.ran.length,
    roundAllDoneS,
    burstRounds,
    skippedBurstRounds: [...skipped].sort((a, b) => a - b),
    harnessFailures,
    solo: baseline.solo,
    soloMedianWallS: baseline.soloMedianWallS,
    soloMedianUploadS: baseline.soloMedianUploadS,
    slowdown: full ? ratio(atSize.medianWallS, baseline.soloMedianWallS) : null,
    slowdownWithoutUpload: full
      ? ratio(atSize.medianWithoutUploadS, baseline.withoutUploadS)
      : null,
    slowdownWithheld,
  };

  const refused = burst.results.find((t) => t.failure?.stage === "account-limit")?.failure?.reason;
  const ours = failed.find((f) => f.role === "burst")?.reason ?? burst.harness[0]?.failure.detail;

  const reason =
    notRun ??
    (burst.ran.length > 0
      ? undefined
      : refused
        ? `account limit: ${refused}`
        : ours
          ? `our side: ${short(ours)}`
          : "no burst task ran");

  return reason === undefined
    ? { ...common, status: "ran" }
    : { ...common, status: "not-run", reason };
}

/**
 * A round's spend at list price, for the spend guard. `price` is a task's list price for `ms` of
 * its sandbox; `perTaskUSD` is what one task reserved. A task whose sandbox is unresolved after the
 * cleanup keeps at least its whole reservation; a recovered one is charged until the listing that
 * confirmed it gone. Where the provider enforces a hard lifetime (`hardLifetimeMs`), no sandbox can
 * bill past it, so every elapsed time is capped there; without one, nothing caps it.
 */
export function roundSpend({
  records,
  leftovers,
  perTaskUSD,
  hardLifetimeMs,
  price,
}: {
  records: readonly StoredRecord[];
  leftovers: readonly Leftover[];
  perTaskUSD: number;
  /** The lifetime the provider enforces on each sandbox; null when it enforces none. */
  hardLifetimeMs: number | null;
  price: (record: StoredRecord, ms: number) => number;
}): number {
  const billed = (ms: number) => (hardLifetimeMs === null ? ms : Math.min(ms, hardLifetimeMs));

  return records.reduce((sum, record) => {
    const end = taskEnd(record, leftovers);
    const ran = record.endedAt - record.startedAt;

    switch (end.kind) {
      case "unresolved":
        return sum + Math.max(perTaskUSD, price(record, billed(ran)));
      case "recovered":
        return sum + price(record, billed(Math.max(ran, end.at - record.startedAt)));
      case "confirmed":
        return sum + (record.sandboxIds.length ? price(record, billed(ran)) : 0);
      default: {
        const _exhaustive: never = end;

        return _exhaustive;
      }
    }
  }, 0);
}

/**
 * Account limits known before the run that a round cannot fit (checked 2026-11-19), so the provider
 * is recorded as not run instead of being sent creates it would refuse.
 */
export interface AccountCap {
  /** vCPUs the account may run at once. */
  readonly vcpu?: number;
  /** Sandboxes the account may run at once. */
  readonly sandboxes?: number;
  readonly note: string;
}

export const accountCaps = new Map<string, AccountCap>([
  ["daytona", { vcpu: 10, note: "Daytona's account allows 10 vCPU in total" }],
  ["beam", { vcpu: 30, note: "Beam's workspace quota is 30 vCPU" }],
  ["baseten", { sandboxes: 10, note: "Baseten allows 10 sandboxes at once" }],
  // Plan caps (docs.archil.com/administration/billing.md, 2026-11-21): Free 5, Developer 20, Team 250.
  ["archil", { sandboxes: 20, note: "Archil's Developer plan allows 20 sandboxes at once" }],
]);

/** Why a round of `size` tasks of `vcpu` each cannot run on this account, or null when it fits. */
export function accountRefusal({
  provider,
  size,
  vcpu,
}: {
  provider: string;
  size: number;
  vcpu: number;
}): string | null {
  const cap = accountCaps.get(provider);

  if (!cap) return null;

  if (cap.vcpu !== undefined && size * vcpu > cap.vcpu)
    return `${cap.note}; ${size} tasks x ${vcpu} vCPU = ${size * vcpu} vCPU does not fit`;

  if (cap.sandboxes !== undefined && size > cap.sandboxes)
    return `${cap.note}; ${size} tasks do not fit`;

  return null;
}

/**
 * Runs `run` for every item, at most `parallel` at once. Items on one account (one adapter, one key)
 * never run at once: their listings would see each other's sandboxes. Every item runs even when
 * another fails; the failures are thrown together at the end.
 */
export async function runPool<T>({
  items,
  parallel,
  account,
  run,
}: {
  items: readonly T[];
  parallel: number;
  account: (item: T) => string;
  run: (item: T) => Promise<void>;
}): Promise<void> {
  if (!Number.isInteger(parallel) || parallel < 1)
    throw new Error(`parallel must be a positive integer, got ${parallel}`);
  const waiting = [...items];
  const busy = new Set<string>();
  const running = new Set<Promise<void>>();
  const errors: unknown[] = [];

  while (waiting.length || running.size) {
    const index =
      running.size < parallel ? waiting.findIndex((item) => !busy.has(account(item))) : -1;

    if (index === -1) {
      await Promise.race(running);
      continue;
    }

    const [item] = waiting.splice(index, 1);

    if (item === undefined) continue;
    const key = account(item);
    busy.add(key);

    const job: Promise<void> = run(item)
      .catch((error) => {
        errors.push(error);
      })
      .finally(() => {
        busy.delete(key);
        running.delete(job);
      });

    running.add(job);
  }

  if (errors.length) throw new AggregateError(errors, `${errors.length} pool item(s) failed`);
}

/**
 * The run's spend ceiling at list price. A round reserves its worst case (every task through its
 * billable lifetime) before it starts and settles to its estimate when it ends; a round that would
 * cross the ceiling is refused. A sandbox left unresolved on a provider with no hard lifetime can
 * bill without end, so it stops the guard: no round is admitted after it, on any provider.
 */
export function spendGuard(capUSD: number) {
  if (!Number.isFinite(capUSD) || capUSD <= 0)
    throw new Error(`The spend ceiling must be a positive number of dollars, got ${capUSD}`);
  let spent = 0;
  let reserved = 0;
  let stopped: string | null = null;

  return {
    /** Reserves `usd` and returns true, or returns false when it would cross the ceiling. */
    reserve(usd: number): boolean {
      if (stopped !== null || spent + reserved + usd > capUSD) return false;
      reserved += usd;

      return true;
    },
    /** Whether `usd` could ever be reserved: true while only other rounds' reservations are in the way. */
    couldFit(usd: number): boolean {
      return stopped === null && spent + usd <= capUSD;
    },
    /** Admits no more rounds: an allocation with no bound on its spend is unresolved. */
    stop(reason: string) {
      stopped ??= reason;
    },
    /** Why the guard admits no more rounds, or null. */
    stopped: () => stopped,
    settle({ reservedUSD, spentUSD }: { reservedUSD: number; spentUSD: number }) {
      reserved = Math.max(0, reserved - reservedUSD);
      spent += spentUSD;
    },
    state: () => ({ spentUSD: spent, reservedUSD: reserved, capUSD }),
  };
}
