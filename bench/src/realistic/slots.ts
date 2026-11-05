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
import type { CreateOptions } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { shuffle } from "../v2-stats.js";
import { runAttempt, SlotTimeout, type AttemptEnvironment, type AttemptPlan } from "./attempt.js";
import type { Clock } from "./gaps.js";
import type { IdlePlan } from "./idle.js";
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
  /** Account-wide listing for window edges. Default: the adapter's `list({})`. */
  listAccount?(signal: AbortSignal): Promise<string[]>;
  /** Reserved-gap cleanup of this run's leftovers; returns the IDs it removed. */
  cleanup?(signal: AbortSignal): Promise<string[]>;
}

const attributionTable = new Map<string, { attribution: Attribution; settlementMs: number | null }>(
  [
    ["boat", { attribution: "per-sandbox", settlementMs: null }],
    ["upstash", { attribution: "per-sandbox", settlementMs: null }],
    ["e2b", { attribution: "per-sandbox", settlementMs: null }],
    ["daytona", { attribution: "per-sandbox", settlementMs: null }],
    ["boxd", { attribution: "per-machine", settlementMs: 15 * 60_000 }],
    ["superserve", { attribution: "account-window", settlementMs: null }],
    ["tenki", { attribution: "none", settlementMs: null }],
    ["freestyle", { attribution: "none", settlementMs: null }],
  ],
);

/** The plan's attribution table (section 6), with boxd's 15-minute settlement. Unknown: none. */
export function attributionFor(provider: string) {
  return attributionTable.get(provider) ?? { attribution: "none", settlementMs: null };
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
  listTimeoutMs?: number;
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
    outputDir: null,
  };
}

export async function runBatch(plan: BatchPlan): Promise<BatchReport> {
  const { clock } = plan;
  const order = slotOrder(plan.slots, plan.seed, plan.batch);
  const startWindowMs = plan.startWindowMs ?? 5 * 60_000;
  const limit = plan.unavailableLimit ?? 3;
  const listTimeoutMs = plan.listTimeoutMs ?? 30_000;
  const attempt = plan.attempt ?? runAttempt;
  const unavailableRun = new Map(plan.providers.map((entry) => [entry.name, 0]));
  const paused: BatchReport["paused"] = [];
  const reports: SlotReport[] = [];

  for (const [index, slot] of order.entries()) {
    const profile = plan.manifest.profiles[slot.profile];

    if (!profile) throw new Error(`Slot ${slot.id} runs unknown profile ${slot.profile}`);
    // Open every provider's window at its next settlement edge, then wait out its padding.
    const now = clock.now();

    const opens = new Map(
      plan.providers.map((entry) => [entry.name, edgeAtOrAfter(now, entry.settlementMs)]),
    );

    const startAt = Math.max(
      now,
      ...plan.providers.map((entry) => (opens.get(entry.name) ?? now) + entry.paddingMs),
    );

    await clock.sleep(startAt - clock.now());
    const listings = new Map<string, AccountListing[]>();
    const active: SlotProvider[] = [];
    const records = new Map<string, AttemptRecord>();
    const slotStartedAt = clock.now();

    const base = {
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
    };

    const attemptId = (provider: string) => `${plan.runId}-b${plan.batch}-s${index}-${provider}`;

    await Promise.all(
      plan.providers.map(async (entry) => {
        if (paused.some((item) => item.provider === entry.name)) {
          records.set(
            entry.name,
            emptyRecord(
              { ...base, provider: entry.name, attemptId: attemptId(entry.name) },
              "provider-paused",
              `Unavailable for ${limit} slots in a row in batch ${plan.batch}`,
              clock.now(),
              entry.attribution,
            ),
          );

          return;
        }

        const at = clock.now();
        const ids = await listAccount(entry, listTimeoutMs);
        listings.set(entry.name, [{ edge: "open", at, ids, unexpected: ids ?? [] }]);

        if (ids === null) {
          records.set(
            entry.name,
            emptyRecord(
              { ...base, provider: entry.name, attemptId: attemptId(entry.name) },
              "unavailable",
              "Health check (account listing) failed before the slot",
              clock.now(),
              entry.attribution,
            ),
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

    const deadline = slotStartedAt + profile.slotTimeoutMs;
    const controllers = new Map(active.map((entry) => [entry.name, new AbortController()]));

    const timer = setTimeout(
      () => {
        for (const controller of controllers.values())
          controller.abort(new SlotTimeout(`Slot ${slot.id} reached its frozen timeout`));
      },
      Math.max(0, deadline - clock.now()),
    );

    const ends = new Map<string, number>();

    try {
      await Promise.all(
        active.map(async (entry) => {
          const signal = controllers.get(entry.name)?.signal ?? new AbortController().signal;

          const environment: AttemptEnvironment = {
            clock,
            signal,
            blobs: plan.blobs,
            prepare: plan.prepare,
            attribution: entry.attribution,
          };

          if (plan.outputDir) environment.outputDir = plan.outputDir;

          if (plan.onSandbox) environment.onSandbox = plan.onSandbox;

          const attemptPlan: AttemptPlan = {
            ...base,
            attemptId: attemptId(entry.name),
            provider: { name: entry.name, provider: entry.provider },
          };

          if (entry.create) attemptPlan.create = entry.create(slot.track);

          if (slot.idle) attemptPlan.idle = slot.idle;

          if (slot.gapScale !== undefined) attemptPlan.gapScale = slot.gapScale;

          try {
            const { record } = await attempt(attemptPlan, environment);
            records.set(entry.name, record);
          } catch (error) {
            records.set(
              entry.name,
              emptyRecord(
                { ...attemptPlan, provider: entry.name },
                "error",
                error instanceof Error ? error.message : String(error),
                clock.now(),
                entry.attribution,
              ),
            );
          }

          ends.set(entry.name, clock.now());
        }),
      );
    } finally {
      clearTimeout(timer);
    }

    // Close each window at the next settlement edge after its attempt, plus padding.
    const closes = new Map(
      plan.providers.map((entry) => [
        entry.name,
        edgeAtOrAfter((ends.get(entry.name) ?? clock.now()) + entry.paddingMs, entry.settlementMs),
      ]),
    );

    await clock.sleep(Math.max(0, ...closes.values()) - clock.now());
    const windows: BillingWindow[] = [];
    const cleanup: SlotReport["cleanup"] = [];

    for (const entry of plan.providers) {
      const record = records.get(entry.name);
      const edges = listings.get(entry.name) ?? [];
      const own = new Set(record?.sandboxIds ?? []);

      // Only a provider that ran lists again; an unavailable or paused one gets no further calls.
      if (active.includes(entry)) {
        const at = clock.now();
        const ids = await listAccount(entry, listTimeoutMs);
        edges.push({ edge: "close", at, ids, unexpected: ids ?? [] });
      }

      const reasons: string[] = [];

      for (const listing of edges) {
        if (listing.ids === null) reasons.push(`${listing.edge} listing failed`);
        else if (listing.unexpected.length)
          reasons.push(
            `${listing.edge}: ${listing.unexpected.length} sandbox(es) present${listing.unexpected.some((id) => own.has(id)) ? ", including this attempt's" : ""}`,
          );
      }

      if (!edges.length) reasons.push("No attempt in this window");

      const window: BillingWindow = {
        id: `${plan.runId}/b${plan.batch}/s${index}/${entry.name}`,
        provider: entry.name,
        openedAt: opens.get(entry.name) ?? slotStartedAt,
        closedAt: closes.get(entry.name) ?? clock.now(),
        settlementMs: entry.settlementMs,
        paddingMs: entry.paddingMs,
        listings: edges,
        void: reasons.length > 0,
        voidReasons: reasons,
      };

      windows.push(window);

      if (record) {
        record.costEvidence.window = window;
        await plan.onRecord(record);
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
