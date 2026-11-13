/**
 * One slot schedule for everyone (plan section 6).
 *
 * - Per batch, the slot order is drawn from the published seed and shared by every provider.
 * - Each slot is an isolated billing window per provider, opened at its settlement edge (boxd: 15 min)
 *   plus its padding, and closed at the next edge after its attempt ends plus padding.
 * - At each window edge the account's sandboxes are listed. Anything unexpected, or a listing that
 *   fails, voids that window's reconciliation. The open listing is also the slot's health check: a
 *   status/list call that creates nothing billable. A failed check makes the provider "unavailable" for
 *   the slot, a failed attempt; 3 in a row pause it for the rest of the batch.
 * - Every available provider starts within the start window (5 minutes); actual offsets are recorded.
 * - The next slot starts only when every attempt has finished or the slot's frozen timeout ended it.
 * - Cleanup runs only in the reserved gap after a window closes, and every ID it removes is recorded.
 */
import type { AttemptApp } from "./apps.js";
import type { CreateOptions } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { shuffle } from "../v2-stats.js";
import { billingRule } from "../cost/billing-rules.js";
import { runAttempt, SlotTimeout, type AttemptEnvironment, type AttemptPlan } from "./attempt.js";
import type { Clock } from "./gaps.js";
import type { IdlePlan, StatePreservation } from "./idle.js";
import type { HarnessManifest } from "./manifest.js";
import type { PrepareSettings } from "./prepare.js";
import {
  attemptSchemaVersion,
  type AccountListing,
  type Attribution,
  type AttemptRecord,
  type BillingWindow,
  type IncompleteReason,
  type Variant,
} from "./record.js";
import type { BlobStore } from "./steps.js";

/** One profile on one track, as one variant. Twins and diagnostics are their own slots. */
export interface SlotSpec {
  id: string;
  profile: string;
  track: string;
  variant: Variant;
  idle?: IdlePlan;
  gapScale?: number;
}

export interface SlotProvider {
  name: string;
  provider: Provider;
  attribution: Attribution;
  /** Settlement granularity to pad windows to (boxd: 900000), or null. */
  settlementMs: number | null;
  /** Extra margin on each side of the window. */
  paddingMs: number;
  /** Size, image and lifetime per track. */
  create?(track: string): Omit<CreateOptions, "labels" | "signal" | "key">;
  /** Working directory when the manifest's is not writable on this provider. */
  workdir?: string;
  /** Worker count on a track whose size differs per provider (the default track). */
  vcpuFor?(track: string): number | undefined;
  /** Label sandboxes with the run only (labels share a short name budget on Boat). */
  runLabelOnly?: boolean;
  /** Chunks in flight during an upload (Tenki fails concurrent writes with gRPC INTERNAL). */
  uploadConcurrency?: number;
  /** Capture usage the provider reports only while the sandbox exists; returns the file written. */
  beforeDestroy?(id: string): Promise<string | null>;
  /**
   * Per-attempt setup before anything is timed: Modal journals and resolves the attempt's own App.
   * Its labels go on the attempt's creates, and `created` journals each sandbox. A failure fails
   * the attempt before any sandbox exists. It must finish by the slot deadline; past it, `signal`
   * aborts and the attempt fails on our side without a create.
   */
  beforeAttempt?(attemptId: string, signal: AbortSignal): Promise<AttemptApp>;
  /**
   * A truly account-wide listing for window edges (a native call). Without it the adapter's `list({})`
   * is used, which most adapters scope to SDK-made sandboxes, so the window is void as unverified.
   */
  listAccount?(signal: AbortSignal): Promise<string[]>;
  /** The state-preservation check this provider passed (or not) before the batch; managed idle needs it. */
  statePreservation?: StatePreservation;
  /** Reserved-gap cleanup of this run's leftovers; returns the IDs it removed. */
  cleanup?(signal: AbortSignal): Promise<string[]>;
}

/**
 * The plan's attribution table (section 6), with boxd's 15-minute settlement edge, read from the
 * billing-rules table that owns it. A provider without a row is not attributable.
 */
export function attributionFor(provider: string): {
  attribution: Attribution;
  settlementMs: number | null;
} {
  const rule = billingRule(provider, null);

  return rule
    ? { attribution: rule.attribution, settlementMs: rule.settlementMs }
    : { attribution: "none", settlementMs: null };
}

/** The seed for one batch, derived from the published run seed. */
export function batchSeed(seed: number, batch: number) {
  return (seed ^ Math.imul(batch + 1, 0x9e3779b1)) >>> 0;
}

/** The batch's slot order: one seeded shuffle, shared by every provider. */
export function slotOrder(slots: readonly SlotSpec[], seed: number, batch: number): SlotSpec[] {
  const ids = new Set<string>();
  const keys = new Set<string>();

  for (const slot of slots) {
    const key = `${slot.profile}/${slot.track}/${slot.variant}/${slot.idle?.policy ?? ""}/${slot.idle?.idleMs ?? ""}/${slot.gapScale ?? 1}`;

    if (ids.has(slot.id)) throw new Error(`Duplicate slot id ${slot.id}`);

    if (keys.has(key)) throw new Error(`Two slots run ${key}; each needs its own window`);
    ids.add(slot.id);
    keys.add(key);
  }

  return shuffle(slots, batchSeed(seed, batch));
}

/** The last settlement edge at or before `time`. */
export function edgeAtOrBefore(time: number, settlementMs: number | null) {
  return settlementMs ? Math.floor(time / settlementMs) * settlementMs : time;
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

/** The first settlement edge at or after `time`. */
export function edgeAtOrAfter(time: number, settlementMs: number | null) {
  return settlementMs ? Math.ceil(time / settlementMs) * settlementMs : time;
}

export interface SlotReport {
  index: number;
  id: string;
  startedAt: number;
  deadline: number;
  endedAt: number;
  timedOut: string[];
  /** Providers that started outside the start window. */
  lateStarts: string[];
  windows: BillingWindow[];
  cleanup: { provider: string; at: number; ids: string[]; error: string | null }[];
}

export interface BatchReport {
  runId: string;
  batch: number;
  seed: number;
  order: string[];
  slots: SlotReport[];
  paused: { provider: string; afterSlot: string }[];
}

/** Each provider's run of unavailable slots, and the providers paused for the batch. */
export interface BatchHealth {
  readonly unavailableRun: Map<string, number>;
  readonly paused: BatchReport["paused"];
}

export function batchHealth(): BatchHealth {
  return { unavailableRun: new Map(), paused: [] };
}

export interface BatchPlan {
  runId: string;
  batch: number;
  seed: number;
  manifest: HarnessManifest;
  manifestSha256: string | null;
  slots: readonly SlotSpec[];
  providers: readonly SlotProvider[];
  clock: Clock;
  blobs: BlobStore;
  prepare: PrepareSettings;
  outputDir?: string;
  /** Every provider starts its attempt within this window. Default 5 minutes. */
  startWindowMs?: number;
  /** Consecutive unavailable slots that pause a provider for the batch. Default 3. */
  unavailableLimit?: number;
  /**
   * The batch's provider health, for a caller that runs one batch's slots through several calls:
   * pass the same object to each so the unavailable count and pauses carry across them.
   */
  health?: BatchHealth;
  listTimeoutMs?: number;
  /** How long past the slot timeout an attempt that ignores the abort is waited for. Default 150 s. */
  timeoutGraceMs?: number;
  onRecord(record: AttemptRecord): Promise<void>;
  onSandbox?(provider: string, id: string): Promise<void>;
  /** Injected in tests; defaults to `runAttempt`. */
  attempt?: typeof runAttempt;
}

async function listAccount(entry: SlotProvider, timeoutMs: number): Promise<string[] | null> {
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const listing = entry.listAccount
      ? entry.listAccount(signal)
      : entry.provider.list({}).then((items) => items.map((item) => item.id));

    return await Promise.race([
      listing,
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("Listing timed out")), {
          once: true,
        }),
      ),
    ]);
  } catch {
    return null;
  }
}

/** A record for an attempt that never ran: unavailable, paused, not available. */
export function emptyRecord(
  plan: Omit<AttemptPlan, "provider"> & { provider: string },
  reason: IncompleteReason,
  detail: string,
  at: number,
  attribution: Attribution,
): AttemptRecord {
  const profile = plan.manifest.profiles[plan.profileName];

  return {
    schema: attemptSchemaVersion,
    attemptId: plan.attemptId,
    runId: plan.runId,
    provider: plan.provider,
    profile: plan.profileName,
    profileKind: profile?.kind ?? "fix-and-test",
    track: plan.track,
    variant: plan.variant,
    batch: plan.batch,
    slot: plan.slot,
    seed: plan.seed,
    manifestSha256: plan.manifestSha256,
    sandboxIds: [],
    startedAt: at,
    endedAt: at,
    startOffsetMs: at - plan.slotStartedAt,
    completion: { kind: "incomplete", reason, detail },
    deletionConfirmed: true,
    phases: [],
    steps: [],
    downloads: [],
    background: [],
    gaps: { count: 0, totalMs: 0, traffic: [] },
    idle: null,
    costEvidence: { attribution, window: null, usageFiles: [] },
    resources: null,
    outputDir: null,
    outputError: null,
  };
}

export async function runBatch(plan: BatchPlan): Promise<BatchReport> {
  const { clock } = plan;
  const order = slotOrder(plan.slots, plan.seed, plan.batch);
  const startWindowMs = plan.startWindowMs ?? 5 * 60_000;
  const limit = plan.unavailableLimit ?? 3;
  const listTimeoutMs = plan.listTimeoutMs ?? 30_000;
  const graceMs = plan.timeoutGraceMs ?? 150_000;
  const attempt = plan.attempt ?? runAttempt;
  const { unavailableRun, paused } = plan.health ?? batchHealth();
  const reports: SlotReport[] = [];

  for (const [index, slot] of order.entries()) {
    const profile = plan.manifest.profiles[slot.profile];

    if (!profile) throw new Error(`Slot ${slot.id} runs unknown profile ${slot.profile}`);
    // The slot starts once every provider's next settlement edge plus padding has passed. Each window
    // opens at its own boundary: the last edge (or exact time) that leaves its padding before the start.
    const now = clock.now();

    const startAt = Math.max(
      now,
      ...plan.providers.map((entry) => edgeAtOrAfter(now, entry.settlementMs) + entry.paddingMs),
    );

    const opens = new Map(
      plan.providers.map((entry) => [
        entry.name,
        edgeAtOrBefore(startAt - entry.paddingMs, entry.settlementMs),
      ]),
    );

    const listings = new Map<string, AccountListing[]>();
    const active: SlotProvider[] = [];
    const records = new Map<string, AttemptRecord>();
    // The slot id keeps IDs unique when a batch's slots run through several runBatch calls.

    const attemptId = (provider: string) =>
      `${plan.runId}-b${plan.batch}-s${index}-${slot.id}-${provider}`;

    const record = (entry: SlotProvider, reason: IncompleteReason, detail: string) =>
      emptyRecord(
        { ...base(startAt), provider: entry.name, attemptId: attemptId(entry.name) },
        reason,
        detail,
        clock.now(),
        entry.attribution,
      );

    const base = (slotStartedAt: number) => ({
      runId: plan.runId,
      manifest: plan.manifest,
      manifestSha256: plan.manifestSha256,
      profileName: slot.profile,
      track: slot.track,
      variant: slot.variant,
      batch: plan.batch,
      slot: { index, id: slot.id },
      seed: plan.seed,
      slotStartedAt,
    });

    // Open edge: each provider is listed at its own window opening. The listing is the health check.
    await Promise.all(
      plan.providers.map(async (entry) => {
        if (paused.some((item) => item.provider === entry.name)) {
          records.set(
            entry.name,
            record(
              entry,
              "provider-paused",
              `Unavailable for ${limit} slots in a row in batch ${plan.batch}`,
            ),
          );

          return;
        }

        await clock.sleep((opens.get(entry.name) ?? now) - clock.now());
        const at = clock.now();
        const ids = await listAccount(entry, listTimeoutMs);
        listings.set(entry.name, [{ edge: "open", at, ids, unexpected: ids ?? [] }]);

        if (ids === null) {
          records.set(
            entry.name,
            record(entry, "unavailable", "Health check (account listing) failed before the slot"),
          );
          const run = (unavailableRun.get(entry.name) ?? 0) + 1;
          unavailableRun.set(entry.name, run);

          if (run >= limit) paused.push({ provider: entry.name, afterSlot: slot.id });

          return;
        }

        unavailableRun.set(entry.name, 0);
        active.push(entry);
      }),
    );

    await clock.sleep(startAt - clock.now());
    const slotStartedAt = clock.now();
    // A held-open slot waits its idle time on top of the profile's work.
    const deadline = slotStartedAt + profile.slotTimeoutMs + (slot.idle?.idleMs ?? 0);
    const ends = new Map<string, number>();
    const closes = new Map<string, number>();

    await Promise.all(
      active.map(async (entry) => {
        const controller = new AbortController();
        const created: string[] = [];
        let app: AttemptApp | undefined;

        const environment: AttemptEnvironment = {
          clock,
          signal: controller.signal,
          blobs: plan.blobs,
          prepare: plan.prepare,
          attribution: entry.attribution,
          onSandbox: async (provider, id) => {
            created.push(id);
            await app?.created(id);
            await plan.onSandbox?.(provider, id);
          },
        };

        // Modal: the attempt's App journals the create's outcome and the confirmed stop.
        environment.onCreateFailed = async (_, cause) => {
          await app?.failed(cause);
        };

        environment.afterDestroy = async (_, id) => {
          await app?.destroyed(id);
        };

        if (plan.outputDir) environment.outputDir = plan.outputDir;
        const capture = entry.beforeDestroy;

        if (capture) environment.beforeDestroy = (_, id) => capture(id);

        const attemptPlan: AttemptPlan = {
          ...base(slotStartedAt),
          attemptId: attemptId(entry.name),
          provider: { name: entry.name, provider: entry.provider },
        };

        if (entry.create) attemptPlan.create = entry.create(slot.track);

        if (entry.workdir) attemptPlan.workdir = entry.workdir;

        if (entry.runLabelOnly) attemptPlan.runLabelOnly = true;

        if (entry.uploadConcurrency !== undefined)
          attemptPlan.uploadConcurrency = entry.uploadConcurrency;
        const vcpu = entry.vcpuFor?.(slot.track);

        if (vcpu !== undefined) attemptPlan.vcpu = vcpu;

        if (slot.idle) attemptPlan.idle = slot.idle;

        if (slot.gapScale !== undefined) attemptPlan.gapScale = slot.gapScale;

        if (entry.statePreservation) attemptPlan.statePreservation = entry.statePreservation;

        // The frozen timeout aborts the attempt; one that ignores the abort is abandoned after the grace.
        const abort = setTimeout(
          () => controller.abort(new SlotTimeout(`Slot ${slot.id} reached its frozen timeout`)),
          Math.max(0, deadline - clock.now()),
        );

        const invokedAt = clock.now();

        try {
          // Outside the attempt's spans, so its create timing excludes the App lookup, but bounded by
          // the slot deadline: a stalled lookup is our side and fails the attempt before any create.
          if (entry.beforeAttempt) {
            let prepared: AttemptApp | null;

            try {
              prepared = await within(
                entry.beforeAttempt(attemptPlan.attemptId, controller.signal),
                Math.max(0, deadline - clock.now()),
              );
            } catch (cause) {
              // Aborted by the slot's timer at the deadline: the same our-side timeout.
              if (!controller.signal.aborted) throw cause;
              prepared = null;
            }

            if (!prepared) {
              const detail = `Our side: the attempt's App was not ready by slot ${slot.id}'s deadline; no create was submitted`;
              controller.abort(new SlotTimeout(detail));
              throw new Error(detail);
            }

            app = prepared;
            attemptPlan.labels = app.labels;
          }

          const outcome = await within(
            attempt(attemptPlan, environment).then(({ record: done }) => done),
            Math.max(0, deadline + graceMs - clock.now()),
          );

          if (outcome) records.set(entry.name, outcome);
          else {
            const abandoned = record(
              entry,
              "slot-timeout",
              "The attempt did not return within the slot timeout plus its grace; abandoned",
            );

            abandoned.startedAt = invokedAt;
            abandoned.startOffsetMs = invokedAt - slotStartedAt;
            abandoned.sandboxIds = created;
            // Deletion is unconfirmed: the reserved-gap cleanup must remove these IDs.
            abandoned.deletionConfirmed = created.length === 0;
            records.set(entry.name, abandoned);
          }
        } catch (error) {
          const failed = record(
            entry,
            "error",
            error instanceof Error ? error.message : String(error),
          );

          failed.sandboxIds = created;
          failed.deletionConfirmed = created.length === 0;
          records.set(entry.name, failed);
        } finally {
          clearTimeout(abort);
        }

        ends.set(entry.name, clock.now());
        // Close edge: the next settlement edge after the attempt plus padding, listed at that time.
        const closeAt = edgeAtOrAfter(clock.now() + entry.paddingMs, entry.settlementMs);
        closes.set(entry.name, closeAt);
        await clock.sleep(closeAt - clock.now());
        const at = clock.now();
        const ids = await listAccount(entry, listTimeoutMs);
        listings.get(entry.name)?.push({ edge: "close", at, ids, unexpected: ids ?? [] });
      }),
    );

    const windows: BillingWindow[] = [];
    const cleanup: SlotReport["cleanup"] = [];

    for (const entry of plan.providers) {
      const result = records.get(entry.name);
      const edges = listings.get(entry.name) ?? [];
      const own = new Set(result?.sandboxIds ?? []);
      const scope = entry.listAccount ? "account" : "sdk-scoped";
      const reasons: string[] = [];

      if (scope === "sdk-scoped")
        reasons.push("Listing is SDK-scoped: sandboxes made outside the SDK are invisible");

      for (const listing of edges) {
        if (listing.ids === null) reasons.push(`${listing.edge} listing failed`);
        else if (listing.unexpected.length)
          reasons.push(
            `${listing.edge}: ${listing.unexpected.length} sandbox(es) present${listing.unexpected.some((id) => own.has(id)) ? ", including this attempt's" : ""}`,
          );
      }

      if (!active.includes(entry)) reasons.push("No attempt in this window");

      const window: BillingWindow = {
        id: `${plan.runId}/b${plan.batch}/s${index}/${entry.name}`,
        provider: entry.name,
        openedAt: opens.get(entry.name) ?? slotStartedAt,
        closedAt: closes.get(entry.name) ?? clock.now(),
        settlementMs: entry.settlementMs,
        paddingMs: entry.paddingMs,
        listingScope: scope,
        listings: edges,
        void: reasons.length > 0,
        voidReasons: reasons,
      };

      windows.push(window);

      if (result) {
        result.costEvidence.window = window;
        await plan.onRecord(result);
      }
    }

    // Reserved gap: cleanup happens here, between windows, with every removed ID recorded.
    for (const entry of plan.providers) {
      if (!entry.cleanup) continue;
      const at = clock.now();

      try {
        cleanup.push({
          provider: entry.name,
          at,
          ids: await entry.cleanup(AbortSignal.timeout(listTimeoutMs * 4)),
          error: null,
        });
      } catch (error) {
        cleanup.push({
          provider: entry.name,
          at,
          ids: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const lateStarts: string[] = [];
    const timedOut: string[] = [];

    for (const record of records.values()) {
      if (record.sandboxIds.length > 0 && record.startOffsetMs > startWindowMs)
        lateStarts.push(record.provider);

      if (record.completion.kind === "incomplete" && record.completion.reason === "slot-timeout")
        timedOut.push(record.provider);
    }

    reports.push({
      index,
      id: slot.id,
      startedAt: slotStartedAt,
      deadline,
      endedAt: clock.now(),
      timedOut,
      lateStarts,
      windows,
      cleanup,
    });
  }

  return {
    runId: plan.runId,
    batch: plan.batch,
    seed: plan.seed,
    order: order.map((slot) => slot.id),
    slots: reports,
    paused,
  };
}
