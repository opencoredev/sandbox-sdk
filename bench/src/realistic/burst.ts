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
 */
import type { AttemptApp } from "./apps.js";
import { lifecycleOf } from "../cost/attempt-input.js";
import { runAttempt, SlotTimeout, type AttemptEnvironment, type AttemptPlan } from "./attempt.js";
import type { Clock } from "./gaps.js";
import type { HarnessManifest } from "./manifest.js";
import type { PrepareSettings } from "./prepare.js";
import type { AttemptRecord } from "./record.js";
import { emptyRecord, type SlotProvider } from "./slots.js";
import type { BlobStore } from "./steps.js";

/** One listing of the provider's sandboxes; `ids` is null when the listing failed. */
export interface Listing {
  readonly at: number;
  /** Every sandbox the adapter's `list({})` returned. */
  readonly ids: readonly string[] | null;
  /** Sandboxes carrying this run's label. */
  readonly runIds: readonly string[] | null;
  readonly error: string | null;
}

/** A sandbox this run created that a listing still showed after its round. */
export interface Leftover {
  readonly id: string;
  /** destroy() resolved. */
  readonly destroyed: boolean;
  /** A listing after the destroy no longer showed it. */
  readonly goneAfter: boolean;
}

export interface RoundReport {
  readonly provider: string;
  readonly round: number;
  readonly size: number;
  /** When every task was released at once (after any per-task setup such as Modal's App). */
  readonly startedAt: number;
  /** When the last task's sandbox was confirmed deleted (or its record ended, without one). */
  readonly allDoneAt: number;
  readonly before: Listing;
  readonly after: Listing;
  /** Listed IDs present before the round that this run created earlier (should be none). */
  readonly ownBefore: readonly string[];
  readonly leftovers: readonly Leftover[];
  readonly records: readonly AttemptRecord[];
}

export interface RoundPlan {
  readonly runId: string;
  readonly round: number;
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
  /** Every sandbox ID this run created on this provider so far; this round adds to it. */
  readonly created: Set<string>;
  readonly listTimeoutMs?: number;
  /** How long past the slot timeout a task that ignores the abort is waited for. Default 150 s. */
  readonly timeoutGraceMs?: number;
  onRecord(record: AttemptRecord): Promise<void>;
  onSandbox?(id: string): Promise<void>;
  /** Injected in tests; defaults to `runAttempt`. */
  readonly attempt?: typeof runAttempt;
}

/** The attempt ID of task `task` in round `round`. */
export function taskAttemptId({
  runId,
  provider,
  round,
  task,
}: {
  runId: string;
  provider: string;
  round: number;
  task: number;
}) {
  return `${runId}-r${round}-t${task}-${provider}`;
}

/** Resolve with the value, or null once `ms` passes. The timer is always cleared. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
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
  const graceMs = plan.timeoutGraceMs ?? 150_000;
  const attempt = plan.attempt ?? runAttempt;
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
    }),
    manifest: plan.manifest,
    manifestSha256: plan.manifestSha256,
    profileName: plan.profileName,
    track: plan.track,
    variant: "concurrent" as const,
    batch: plan.round,
    slot: { index: task, id: `r${plan.round}-t${task}` },
    seed: 0,
    slotStartedAt: startedAt,
  });

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

    return record;
  };

  // Per-task setup outside the timed attempt (Modal's App), so the creates start together.
  const setupDeadline = profile.slotTimeoutMs;

  const apps = await Promise.all(
    tasks.map(async (task): Promise<{ app: AttemptApp | null; error: string | null }> => {
      if (!entry.beforeAttempt) return { app: null, error: null };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), setupDeadline);

      try {
        const app = await entry.beforeAttempt(base(task, 0).attemptId, controller.signal);

        return { app, error: null };
      } catch (error) {
        return {
          app: null,
          error: `Our side: per-attempt setup failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const startedAt = clock.now();
  const deadline = startedAt + profile.slotTimeoutMs;

  const records = await Promise.all(
    tasks.map(async (task): Promise<AttemptRecord> => {
      const prepared = apps[task];

      if (prepared?.error) return failed(task, startedAt, prepared.error, []);
      const app = prepared?.app ?? null;
      const controller = new AbortController();
      const ids: string[] = [];

      const environment: AttemptEnvironment = {
        clock,
        signal: controller.signal,
        blobs: plan.blobs,
        prepare: plan.prepare,
        attribution: entry.attribution,
        onSandbox: async (_, id) => {
          ids.push(id);
          plan.created.add(id);
          await app?.created(id);
          await plan.onSandbox?.(id);
        },
        onCreateFailed: async (_, cause) => {
          await app?.failed(cause);
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
        provider: { name: entry.name, provider: entry.provider },
      };

      if (entry.create) attemptPlan.create = entry.create(plan.track);

      if (entry.workdir) attemptPlan.workdir = entry.workdir;

      if (entry.volumeGiB !== undefined) attemptPlan.volumeGiB = entry.volumeGiB;

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

        if (outcome) return outcome;

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

        return abandoned;
      } catch (error) {
        return failed(task, startedAt, error instanceof Error ? error.message : String(error), ids);
      } finally {
        clearTimeout(abort);
      }
    }),
  );

  // The last task's end: its confirmed deletion, as its wall time ends (host-side output writing
  // after the deletion is not counted).
  const allDoneAt = Math.max(
    startedAt,
    ...records.map((r) => lifecycleOf(r).deletedAt ?? r.endedAt),
  );

  for (const record of records) await plan.onRecord(record);

  // After the round: whatever of ours is still listed, plus any ID whose deletion was not
  // confirmed (a provider may stop listing a sandbox whose delete failed), is destroyed again.
  const after = await listSandboxes(entry, plan.runId, clock, listTimeoutMs);
  const unconfirmed = records.flatMap((r) => (r.deletionConfirmed ? [] : r.sandboxIds));
  const targets = [...new Set([...ownIn(after, plan.created), ...unconfirmed])];
  const destroyed = new Map<string, boolean>();

  for (const id of targets)
    destroyed.set(
      id,
      await entry.provider
        .destroy(id)
        .then(() => true)
        .catch(() => false),
    );

  const recheck = targets.length
    ? await listSandboxes(entry, plan.runId, clock, listTimeoutMs)
    : after;

  const leftovers = targets.map((id) => ({
    id,
    destroyed: destroyed.get(id) ?? false,
    goneAfter: recheck.ids !== null && !recheck.ids.includes(id) && !recheck.runIds?.includes(id),
  }));

  return {
    provider: entry.name,
    round: plan.round,
    size: plan.size,
    startedAt,
    allDoneAt,
    before,
    after,
    ownBefore,
    leftovers,
    records,
  };
}

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
  readonly completed: boolean;
  readonly failure?: { readonly stage: FailureStage; readonly reason: string };
}

/**
 * A create refused for quota or rate reasons: an account limit, not a provider failure. Matched on
 * the provider's own words; anything else stays a create failure.
 */
const accountLimitPattern =
  /\bquota\b|rate.?limit|too many (requests|sandboxes|machines)|\b429\b|concurrency limit|limit (reached|exceeded)|exceeds? (the |your )?(account|plan|org)/i;

export function isAccountLimit(record: AttemptRecord): boolean {
  return (
    record.completion.kind === "incomplete" &&
    record.completion.reason === "create-failed" &&
    accountLimitPattern.test(record.completion.detail)
  );
}

/** Seconds from the create request to the confirmed deletion (or the record's end without one). */
export function wallSeconds(record: AttemptRecord): number {
  return ((lifecycleOf(record).deletedAt ?? record.endedAt) - record.startedAt) / 1000;
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

/** One task as published: wall time, whether it passed its checks, and where it failed. */
export function taskResult(
  record: AttemptRecord,
  redact: (text: string) => string = (text) => text,
): TaskResult {
  const round = record.batch;
  const wallS = Math.round(wallSeconds(record) * 1000) / 1000;
  const short = (text: string) => redact(text).replace(/\s+/g, " ").slice(0, 300);

  if (record.completion.kind === "completed") {
    if (record.deletionConfirmed) return { round, wallS, completed: true };

    return {
      round,
      wallS,
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

/** One provider in the site data file. */
export type ProviderBurst = {
  readonly provider: string;
  readonly tasks: readonly TaskResult[];
  /** Median wall time of completed tasks under concurrency, as the published solo median. */
  readonly medianWallS: number | null;
  readonly completed: number;
  /** Tasks that ran; creates an account limit refused are not attempts. */
  readonly attempts: number;
  /** Per round, seconds from the release of its tasks until the last one finished. */
  readonly roundAllDoneS: readonly number[];
  readonly soloMedianWallS: number | null;
  /** medianWallS / soloMedianWallS. */
  readonly slowdown: number | null;
} & ({ readonly status: "ran" } | { readonly status: "not-run"; readonly reason: string });

export interface RoundTiming {
  readonly round: number;
  readonly startedAt: number;
  readonly allDoneAt: number;
}

const round3 = (value: number | null) => (value === null ? null : Math.round(value * 1000) / 1000);

/**
 * A provider's row. `notRun` is a reason it never ran (an account limit known in advance, the
 * budget). A provider whose every task was refused by an account limit is not run either, with the
 * provider's own refusal as the reason.
 */
export function summarizeProvider({
  provider,
  records,
  rounds,
  soloMedianWallS,
  notRun,
  redact,
}: {
  provider: string;
  records: readonly AttemptRecord[];
  rounds: readonly RoundTiming[];
  soloMedianWallS: number | null;
  notRun?: string;
  redact?: (text: string) => string;
}): ProviderBurst {
  const tasks = [...records]
    .sort((a, b) => a.batch - b.batch || a.slot.index - b.slot.index)
    .map((record) => taskResult(record, redact));

  const ran = tasks.filter((t) => t.failure?.stage !== "account-limit");
  const done = ran.filter((t) => t.completed);
  const medianWallS = round3(median(done.map((t) => t.wallS)));

  const roundAllDoneS = [...rounds]
    .sort((a, b) => a.round - b.round)
    .filter((r) => records.some((rec) => rec.batch === r.round && !isAccountLimit(rec)))
    .map((r) => Math.round(r.allDoneAt - r.startedAt) / 1000);

  const common = {
    provider,
    tasks,
    medianWallS,
    completed: done.length,
    attempts: ran.length,
    roundAllDoneS,
    soloMedianWallS,
    slowdown:
      medianWallS !== null && soloMedianWallS !== null && soloMedianWallS > 0
        ? Math.round((medianWallS / soloMedianWallS) * 1000) / 1000
        : null,
  };

  const refused = tasks.find((t) => t.failure?.stage === "account-limit")?.failure?.reason;
  const reason = notRun ?? (ran.length === 0 && refused ? `account limit: ${refused}` : undefined);

  return reason === undefined
    ? { ...common, status: "ran" }
    : { ...common, status: "not-run", reason };
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
 * The run's spend ceiling at list price. A round reserves its worst case (every task to the slot
 * timeout) before it starts and settles to its estimate when it ends; a round that would cross the
 * ceiling is refused.
 */
export function spendGuard(capUSD: number) {
  if (!Number.isFinite(capUSD) || capUSD <= 0)
    throw new Error(`The spend ceiling must be a positive number of dollars, got ${capUSD}`);
  let spent = 0;
  let reserved = 0;

  return {
    /** Reserves `usd` and returns true, or returns false when it would cross the ceiling. */
    reserve(usd: number): boolean {
      if (spent + reserved + usd > capUSD) return false;
      reserved += usd;

      return true;
    },
    settle({ reservedUSD, spentUSD }: { reservedUSD: number; spentUSD: number }) {
      reserved = Math.max(0, reserved - reservedUSD);
      spent += spentUSD;
    },
    state: () => ({ spentUSD: spent, reservedUSD: reserved, capUSD }),
  };
}
