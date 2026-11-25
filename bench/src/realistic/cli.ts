/**
 * `bun bench realistic <run|billing|summary|sweep>`: the release-1 profiles on real providers.
 *
 * run      Load SBX-95's frozen manifest and the providers' per-track setups (setup.ts), then run
 *          batches through the slot scheduler, writing one record per attempt to attempts.jsonl.
 *          Artifacts are uploaded from local files through the SDK (no hosted cache). Attempts the
 *          fit check rules out (FIT.md) get a "default-size-too-small" record without a paid run.
 *          A budget guard stops before a slot whose reservation would cross the cap.
 * billing  Collect each attempt's charge with bench/src/billing and write billing.jsonl.
 *          `--providers a,b` recollects only those providers and keeps every other entry, for a
 *          later pass after settlement without losing evidence past a source's retention limit.
 * summary  Completion, median wall and CPU, cost per completed task with kind and status, through
 *          the cost model's eligibility and picks (descriptive: no statistical gate is claimed).
 *          `--audit FILE` supplies settled-charge reconciliations (cost/audit-file.ts); without
 *          one, every meter stays not reconciled.
 * sweep    List every provider for sandboxes labelled with this run and delete any left.
 */
import { sleepingUnchecked } from "../sleeping.js";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { requestBilledCompute } from "../allocation.js";
import { isMissingFile } from "../files.js";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CreateInput, Provider } from "@opencoredev/sandbox-sdk/provider";
import { z } from "zod";
import type { OwnedSandbox } from "../billing/input.js";
import type { Json } from "../json.js";
import { collectProvider, type Cost } from "../billing/providers.js";
import {
  attemptBillingSchema,
  costedAttempts,
  elapsedSeconds,
  type AttemptBilling,
  type CostedAttempt,
} from "../cost/attempt-input.js";
import { pairedBatches } from "../cost/batch-stats.js";
import { billingModelLabel, billingRule } from "../cost/billing-rules.js";
import { reportedCost, wholeMachineListPrice } from "../cost/columns.js";
import { auditFileSchema, auditFor, noAuditFile, type AuditUsed } from "../cost/audit-file.js";
import { describeIneligibility, eligibility } from "../cost/eligibility.js";
import { captureUsage, savedCosts, usageFileSchema } from "./usage-file.js";
import { pick, type Candidate } from "../cost/picks.js";
import { reservationResources } from "../billed-resources.js";
import { pendingForRun, prepareJournaledApps, reconcileDiscovered } from "../modal-apps.js";
import { budgetUSD, computeHourly, estimateCost, pricing } from "../pricing.js";
import { loadProvider, providerRegion } from "../providers.js";
import {
  appJournalFile,
  attemptAllocation,
  ownedApps,
  persistApp,
  prepareAttemptApp,
  readAppJournal,
  readStops,
  recordStop,
  stopJournalFile,
} from "./apps.js";
import { shuffle } from "../v2-stats.js";
import { harnessManifestFromFrozen } from "./frozen.js";
import { heldStatus, type HeldStatus } from "./held-status.js";
import { systemClock } from "./gaps.js";
import type { HarnessManifest } from "./manifest.js";
import { fileArtifacts } from "./prepare.js";
import { attemptRecordSchema, type AttemptRecord } from "./record.js";
import {
  providerSetup,
  providerSetups,
  tracks,
  type ProviderSetup,
  type TrackId,
  provisionedAtMost,
  provisionedFor,
  provisionedOf,
  type ProvisionedSize,
} from "./setup.js";
import {
  attributionFor,
  batchHealth,
  batchSeed,
  emptyRecord,
  runBatch,
  type SlotProvider,
  type SlotSpec,
} from "./slots.js";
import { sha256Hex } from "./steps.js";

/** One line of notes.jsonl. */
export type RunNote = { readonly kind: string } & { readonly [key: string]: Json | undefined };

export const defaultManifest = "/home/leo/agents/realistic-workloads/manifest.json";

/** Where the frozen artifacts live on evo-1, top level only. */
export const defaultArtifactDirs = [
  "/home/leo/agents/realistic-workloads/depcache/vue-core",
  "/home/leo/agents/realistic-workloads/depcache/jitsi-web",
  "/home/leo/agents/realistic-workloads/toolchain",
  "/home/leo/agents/realistic-workloads/patches",
  `${process.env.HOME ?? ""}/.cache/sbx98/artifacts`,
];

const fx = { eurToUsd: 1.08, date: "2026-11-05" } as const;

/**
 * Each provider's pinned region for a run folder, as `providerRegion` resolved it when the run
 * placed its sandboxes (null: unpinned). The summary prices list-price columns at it.
 */
export const regionsFile = "regions.json";

const regionsSchema = z.record(z.string(), z.string().nullable());

async function readRegions(dir: string): Promise<Record<string, string | null>> {
  try {
    return regionsSchema.parse(JSON.parse(await readFile(join(dir, regionsFile), "utf8")));
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

/**
 * The region an adapter's attempts in `dir` ran in: the run's recorded one, else (for folders from
 * before it was recorded) the environment's, resolved as the run resolved it. A recorded region
 * that the environment contradicts is refused rather than priced either way.
 */
function regionFor(
  recorded: Record<string, string | null>,
  { adapter, dir }: { adapter: string; dir: string },
): string | null {
  const resolved = providerRegion(adapter, process.env);

  if (!(adapter in recorded)) return resolved;
  const region = recorded[adapter] ?? null;

  if (resolved !== null && resolved !== region)
    throw new Error(
      `${dir} ran ${adapter} in ${region ?? "no pinned region"}, but the environment resolves ${resolved}; unset it or set it to the run's region`,
    );

  return region;
}

/**
 * Providers in the held-open idle diagnostic. Maritime is not: its usage intervals leave out a paused
 * sandbox's disk ($0.08/GB-month), so an idle that pauses would read cheaper than it bills. Neither
 * Microsandbox tier is: its usage rows meter running intervals only and settle with no
 * finalization signal, so its idle cost is provisional. Buddy is not either: it has no usage API,
 * so an idle costs only what the list-price estimate says, which the diagnostic exists to check.
 */
export const heldOpenProviders = [
  "e2b",
  "daytona",
  "upstash",
  "upstash-ephemeral",
  "boat",
  "boxd",
  "modal",
  "vercel",
  "instabox",
  "archil",
  "styne",
];

/** Idle lengths of the held-open diagnostic, provider defaults, with the matched zero-wait twin. */
const heldOpenSlots: SlotSpec[] = [
  {
    id: "held-10",
    profile: "fix-and-test",
    track: "same-machine",
    variant: "held-open",
    idle: { policy: "provider-defaults", idleMs: 10 * 60_000 },
  },
  {
    id: "held-60",
    profile: "fix-and-test",
    track: "same-machine",
    variant: "held-open",
    idle: { policy: "provider-defaults", idleMs: 60 * 60_000 },
  },
  {
    id: "zero-wait",
    profile: "fix-and-test",
    track: "same-machine",
    variant: "zero-wait",
    idle: { policy: "provider-defaults", idleMs: 0 },
  },
];

const list = (value: string | undefined, fallback: readonly string[]) =>
  value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [...fallback];

async function readJsonLines<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }

  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => schema.parse(JSON.parse(line)));
}

/** Every artifact the manifest names, found by file name in the artifact directories. */
export async function artifactPaths(manifest: HarnessManifest, dirs: readonly string[]) {
  const wanted = new Map<string, string>();

  for (const toolchain of Object.values(manifest.toolchains))
    for (const artifact of Object.values(toolchain.tarballs))
      if (artifact?.url) wanted.set(artifact.sha256, basename(new URL(artifact.url).pathname));

  for (const profile of Object.values(manifest.profiles)) {
    for (const artifact of Object.values(profile.dependencyCache?.archives ?? {}))
      if (artifact?.file) wanted.set(artifact.sha256, artifact.file);

    for (const patch of Object.values(profile.patches))
      wanted.set(patch.sha256, basename(patch.file));
  }

  const found = new Map<string, string>();

  for (const dir of dirs) {
    const names: string[] = await readdir(dir).catch((): string[] => []);

    for (const [sha, name] of wanted)
      if (!found.has(sha) && names.includes(name)) found.set(sha, join(dir, name));
  }

  return { wanted, found };
}

/** Budget estimate for one attempt at list price for its provisioned size (EUR counted at 2x). */
export function attemptBudget(
  setup: ProviderSetup,
  track: TrackId,
  durationMs: number,
  size: ProvisionedSize = setup.tracks[track].provisioned,
): number {
  // Upstash charges its tier price per CPU-hour used (observed, SBX-100), so a busy box can cost
  // that price times its vCPUs per wall-hour: bound it by every vCPU busy.
  const upstash = setup.pricingKey === "upstash" ? pricing.upstash : undefined;
  const tier = upstash ? computeHourly(upstash, size) : null;

  // Request-billed (Modal): the requested size at the pinned region's rate; the unsized default
  // bursts above its billed minimum, so it reserves the conservative 8 CPU / 16 GiB.
  const requestBilled = pricing[setup.pricingKey]?.requestBilled;
  const trackSize = setup.tracks[track].size;

  const cost =
    upstash && tier !== null
      ? (tier * size.cpu * durationMs) / 3_600_000
      : requestBilled
        ? estimateCost(
            setup.pricingKey,
            durationMs,
            reservationResources(setup.pricingKey, null, trackSize ?? null),
            providerRegion(setup.adapter, process.env),
          )
        : estimateCost(setup.pricingKey, durationMs, size);

  // Unknown prices are counted at a conservative $1 per hour.
  return cost === null ? (durationMs / 3_600_000) * 1 : budgetUSD(setup.pricingKey, cost);
}

function trackOf(record: AttemptRecord): TrackId {
  return record.track === "default" ? "default" : "same-machine";
}

/**
 * A finished attempt's spend at list price for the size it recorded. A record from before
 * attempts recorded their volume counts the largest size its setup can provision.
 */
function recordedBudget(record: AttemptRecord) {
  const setup = providerSetup(record.provider);
  const track = trackOf(record);

  return attemptBudget(
    setup,
    track,
    record.endedAt - record.startedAt,
    provisionedOf(setup, track, record) ?? provisionedAtMost(setup, track),
  );
}

async function spentUSD(path: string) {
  const records = await readJsonLines(path, attemptRecordSchema);

  return records.reduce((sum, r) => (r.sandboxIds.length === 0 ? sum : sum + recordedBudget(r)), 0);
}

export async function loadSlotProvider(
  setup: ProviderSetup,
  track: TrackId,
  slotMs: number,
  usageDir?: string,
  /** The run's output directory, which holds the App journal and confirmed stops (Modal). */
  journalDir?: string,
  /** A profile with its own factory options (`profileFactory`); unset loads the plain adapter. */
  profile?: string,
): Promise<{ kind: "ready"; entry: SlotProvider } | { kind: "skipped"; note: string }> {
  const config = setup.tracks[track];

  // Modal's, Maritime's, Styne's and Microsandbox's factory lifetime for creates without one; each attempt also passes its own below.
  const lifetime: Record<string, number> = [
    "modal",
    "maritime",
    "styne",
    "microsandbox",
    "microsandbox-shared",
  ].includes(setup.adapter)
    ? { [setup.adapter]: slotMs + 15 * 60_000 }
    : {};

  const loaded = await loadProvider(setup.adapter, process.env, undefined, {
    template: config.template ? { [setup.adapter]: config.template } : {},
    product: setup.product ? { [setup.adapter]: setup.product } : {},
    "lifetime-ms": lifetime,
    factory: profile === undefined ? undefined : setup.profileFactory?.[profile],
  });

  if (loaded.kind !== "ready") return { kind: "skipped", note: loaded.note };

  const entry: SlotProvider = {
    name: setup.name,
    provider: loaded.provider,
    attribution: attributionFor(setup.name).attribution,
    // Settlement padding (boxd's 15-minute edges) only helps reconcile a clean window. No adapter
    // here lists sandboxes it did not create, so every window is void and padding would only wait.
    settlementMs: null,
    paddingMs: 0,
    runLabelOnly: setup.adapter === "boat",
    volumeGiB: profile === undefined ? 0 : (setup.profileFactory?.[profile]?.volume?.sizeGiB ?? 0),
    diskGiB: config.provisioned.diskGiB,
    workdir: "/workspace/rw",
    vcpuFor: () => config.vcpu,
    create: () => {
      const options: Pick<CreateInput, "size" | "timeoutMs"> = {};

      if (config.size !== undefined) options.size = config.size;

      // A hard lifetime past the slot, so a lost handle cannot bill for long.
      if (setup.lifetime) options.timeoutMs = slotMs + 15 * 60_000;

      return options;
    },
  };

  if ((setup.adapter === "boat" || setup.adapter === "vercel") && usageDir)
    entry.beforeDestroy = (id) =>
      captureUsage({ adapter: setup.adapter, id, usageDir, env: process.env });

  // Modal bills per App: each attempt gets its own App, journaled before allocation (apps.ts).
  if (setup.adapter === "modal") {
    if (!journalDir) throw new Error("Modal attempts need an App journal");
    const { provider } = loaded;

    const paths = {
      apps: join(journalDir, appJournalFile),
      stops: join(journalDir, stopJournalFile),
    };

    entry.beforeAttempt = (attemptId, signal) =>
      prepareAttemptApp(paths, provider, attemptId, { signal });
  }

  // Measured 2026-11-05: Luxor answers a write started while three others run with gRPC 13.
  if (setup.adapter === "tenki") entry.uploadConcurrency = 1;

  return { kind: "ready", entry };
}

async function run(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string", default: defaultManifest },
      out: { type: "string" },
      run: { type: "string" },
      plan: { type: "string", default: "headline" },
      providers: { type: "string" },
      profiles: { type: "string" },
      tracks: { type: "string" },
      batches: { type: "string", default: "1" },
      "first-batch": { type: "string", default: "0" },
      "budget-usd": { type: "string", default: "75" },
      seed: { type: "string", default: "20261105" },
      "artifact-dir": { type: "string", multiple: true },
    },
  });

  if (!values.out || !values.run) throw new Error("realistic run needs --out and --run");
  const cap = Number(values["budget-usd"]);

  // NaN would make every spend check false and silently drop the budget guard. Checked before
  // anything is written.
  if (!Number.isFinite(cap) || cap <= 0)
    throw new Error(
      `--budget-usd must be a positive number of dollars, got ${values["budget-usd"]}`,
    );
  const out = resolve(values.out);
  await mkdir(join(out, "outputs"), { recursive: true });
  const attemptsPath = join(out, "attempts.jsonl");
  const notesPath = join(out, "notes.jsonl");

  const note = (entry: RunNote) =>
    appendFile(notesPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

  const frozenJson = await readFile(values.manifest, "utf8");
  const manifest = harnessManifestFromFrozen(frozenJson);
  const manifestSha256 = sha256Hex(frozenJson);

  const { wanted, found } = await artifactPaths(
    manifest,
    values["artifact-dir"] ?? defaultArtifactDirs,
  );

  const missing = [...wanted].flatMap(([sha, name]) => (found.has(sha) ? [] : [name]));

  if (missing.length) await note({ kind: "missing-artifacts", files: missing });
  const source = fileArtifacts(found);
  const blobs = { get: (sha: string) => source.read(sha) };
  const plan = values.plan === "held-open" ? "held-open" : "headline";

  const providerNames = list(
    values.providers,
    plan === "held-open" ? heldOpenProviders : providerSetups.map((s) => s.name),
  );

  const profiles = list(values.profiles, ["fix-and-test", "build"]);

  const trackIds = list(values.tracks, plan === "held-open" ? ["same-machine"] : tracks).map((t) =>
    z.enum(tracks).parse(t),
  );

  const seed = Number(values.seed);
  const firstBatch = Number(values["first-batch"]);
  const batches = Number(values.batches);
  const setups = providerNames.map(providerSetup);

  // Record each adapter's resolved region; a later run into the same folder must match it.
  const regions = await readRegions(out);

  for (const setup of setups) {
    const region = providerRegion(setup.adapter, process.env);

    if (setup.adapter in regions && regions[setup.adapter] !== region)
      throw new Error(
        `${out} already ran ${setup.adapter} in ${regions[setup.adapter] ?? "no pinned region"}, not ${region ?? "no pinned region"}`,
      );
    regions[setup.adapter] = region;
  }

  await writeFile(join(out, regionsFile), JSON.stringify(regions, null, 2) + "\n");

  const loaded = new Map<string, SlotProvider>();
  const profileLoaded = new Map<string, SlotProvider>();
  const longest = plan === "held-open" ? 60 * 60_000 : 0;

  for (const track of trackIds)
    for (const setup of setups) {
      const slotMs = (manifest.profiles["fix-and-test"]?.slotTimeoutMs ?? 0) + longest;

      const result = await loadSlotProvider(setup, track, slotMs, join(out, "usage"), out);

      if (result.kind === "skipped")
        await note({ kind: "provider-skipped", provider: setup.name, track, reason: result.note });
      else loaded.set(`${setup.name}/${track}`, result.entry);

      // A profile with its own factory options gets its own adapter. The sweep uses the plain one,
      // whose destroy also deletes a volume another instance made.
      for (const profile of Object.keys(setup.profileFactory ?? {})) {
        const own = await loadSlotProvider(setup, track, slotMs, join(out, "usage"), out, profile);

        if (own.kind === "ready") profileLoaded.set(`${setup.name}/${track}/${profile}`, own.entry);
      }
    }

  const combos: SlotSpec[] =
    plan === "held-open"
      ? heldOpenSlots
      : trackIds.flatMap((track) =>
          profiles.map((profile) => ({
            id: `${profile === "fix-and-test" ? "fat" : profile}-${track === "same-machine" ? "same" : "default"}`,
            profile,
            track,
            variant: "headline" as const,
          })),
        );

  try {
    slots: for (let batch = firstBatch; batch < firstBatch + batches; batch++) {
      // Each slot is its own runBatch call; the batch's provider health carries across them.
      const health = batchHealth();

      for (const slot of shuffle(combos, batchSeed(seed, batch))) {
        const track = z.enum(tracks).parse(slot.track);
        const profile = manifest.profiles[slot.profile];

        if (!profile) throw new Error(`Unknown profile ${slot.profile}`);
        const slotMs = profile.slotTimeoutMs + (slot.idle?.idleMs ?? 0);
        const active: SlotProvider[] = [];
        const slotStartedAt = Date.now();

        for (const setup of setups) {
          const tooSmall = setup.tracks[track].tooSmall[slot.profile];

          if (tooSmall) {
            const record = emptyRecord(
              {
                runId: values.run,
                attemptId: `${values.run}-b${batch}-${slot.id}-${setup.name}`,
                provider: setup.name,
                manifest,
                manifestSha256,
                profileName: slot.profile,
                track: slot.track,
                variant: slot.variant,
                batch,
                slot: { index: 0, id: slot.id },
                seed,
                slotStartedAt,
              },
              "default-size-too-small",
              tooSmall,
              slotStartedAt,
              attributionFor(setup.name).attribution,
            );

            await appendFile(attemptsPath, JSON.stringify(record) + "\n");
            continue;
          }

          // A profile with its own options runs only on its own adapter, never the plain one.
          const entry = setup.profileFactory?.[slot.profile]
            ? profileLoaded.get(`${setup.name}/${track}/${slot.profile}`)
            : loaded.get(`${setup.name}/${track}`);

          if (entry) active.push(entry);
        }

        if (!active.length) continue;
        const spent = await spentUSD(attemptsPath);

        const reserve = active.reduce(
          (sum, entry) =>
            sum +
            attemptBudget(
              providerSetup(entry.name),
              track,
              slotMs,
              provisionedFor(providerSetup(entry.name), track, slot.profile),
            ),
          0,
        );

        if (spent + reserve > cap) {
          await note({
            kind: "budget-stop",
            batch,
            slot: slot.id,
            spentUSD: spent,
            reserveUSD: reserve,
            capUSD: cap,
          });
          process.stdout.write(
            `Budget guard: $${spent.toFixed(2)} spent + $${reserve.toFixed(2)} reserved > $${cap}; stopping.\n`,
          );

          break slots;
        }

        process.stdout.write(
          `[${new Date().toISOString()}] batch ${batch} slot ${slot.id}: ${active.map((e) => e.name).join(", ")} (est. spent $${spent.toFixed(2)})\n`,
        );

        await runBatch({
          runId: values.run,
          batch,
          seed,
          manifest,
          manifestSha256,
          slots: [slot],
          providers: active,
          health,
          clock: systemClock,
          blobs,
          prepare: { cacheBaseUrl: "sdk-upload", upload: { source } },
          outputDir: join(out, "outputs"),
          onRecord: async (record) => {
            await appendFile(attemptsPath, JSON.stringify(record) + "\n");
            process.stdout.write(
              `  ${record.provider}: ${record.completion.kind === "completed" ? "completed" : `${record.completion.reason}: ${record.completion.detail.slice(0, 160)}`} (${Math.round((record.endedAt - record.startedAt) / 1000)} s)\n`,
            );
          },
          onSandbox: (provider, id) =>
            note({ kind: "sandbox", provider, id, batch, slot: slot.id }),
        });
      }
    }
  } finally {
    // Always, after a budget stop or an error too: nothing this run made is left running.
    reportSweep(await sweepProviders(values.run, [...loaded.values()], note, out), notesPath);
  }
}

/** What a sweep could not clear. Any nonzero count means sandboxes may still be running. */
export interface SweepResult {
  /** Sleeping machines (boxd) out of list() that could not be checked without waking them. */
  readonly unchecked: number;
  /** Providers whose listing or sweep threw. */
  readonly failed: number;
  /** Leftover sandboxes whose destroy() rejected: they may still be running and charging. */
  readonly undeleted: number;
}

/** Prints what a sweep left and fails the process when it left anything. */
function reportSweep({ unchecked, failed, undeleted }: SweepResult, notesPath: string) {
  if (unchecked > 0) {
    process.stderr.write(
      `${unchecked} sleeping machines could not be checked without waking them; see leftover-unchecked in ${notesPath}\n`,
    );
    process.exitCode = 1;
  }

  if (failed > 0) {
    process.stderr.write(`${failed} provider sweeps failed; see sweep-failed in ${notesPath}\n`);
    process.exitCode = 1;
  }

  if (undeleted > 0) {
    process.stderr.write(
      `${undeleted} leftover sandboxes could not be deleted; see leftover with removed: false in ${notesPath}\n`,
    );
    process.exitCode = 1;
  }
}

/** Sandbox IDs from this run's attempts whose deletion was never confirmed. */
async function unconfirmed(out: string, runId: string, provider: string) {
  // A run with no attempts file yet reads as none.
  const records = await readJsonLines(join(out, "attempts.jsonl"), attemptRecordSchema);

  return records.flatMap((r) =>
    r.runId === runId && r.provider === provider && !r.deletionConfirmed ? r.sandboxIds : [],
  );
}

/** How long one provider call in a sweep may take before it counts as failed. */
const sweepCallTimeoutMs = 120_000;

/** Resolves with the call's value, or rejects once `ms` passes. */
async function bounded<T>(what: string, work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deletes this run's sandboxes on each provider. Discovery (the run's listing, Modal's pending
 * restores, sleeping machines) and deletion by known ID are separate: a failed listing still
 * deletes every ID the run knows, from its attempt records and from `known` (the live ownership
 * sets, which hold IDs whose record was never written). Every provider call is bounded, so one
 * stalled call fails its provider and the next provider is still swept.
 */
export async function sweepProviders(
  runId: string,
  providers: readonly SlotProvider[],
  note: (entry: RunNote) => Promise<void>,
  journalDir: string,
  options: {
    /** Sandbox IDs this run owns, by provider name (the SlotProvider's `name`). */
    readonly known?: ReadonlyMap<string, ReadonlySet<string>>;
    /** Bound on each provider call. Default 120 s. */
    readonly callTimeoutMs?: number;
  } = {},
): Promise<SweepResult> {
  const callTimeoutMs = options.callTimeoutMs ?? sweepCallTimeoutMs;
  let unchecked = 0;
  let failed = 0;
  let undeleted = 0;
  const journal = join(journalDir, appJournalFile);
  const apps = await readAppJournal(journal);
  const changed = new Set<(typeof apps)[number]>();

  // Entries that share one adapter instance are swept together: one discovery, every name's IDs.
  const groups = new Map<Provider, SlotProvider[]>();

  for (const entry of providers)
    groups.set(entry.provider, [...(groups.get(entry.provider) ?? []), entry]);

  for (const [provider, entries] of groups) {
    const name = entries.map((e) => e.name).join("+");
    let broken = false;

    const fail = async (stage: string, error: string) => {
      broken = true;
      await note({ kind: "sweep-failed", provider: name, stage, error }).catch(() => {});
    };

    const remove = async (id: string) => {
      const removed = await bounded(`destroy ${id}`, () => provider.destroy(id), callTimeoutMs)
        .then(() => true)
        .catch(() => false);

      // Billing treats a Modal sandbox as settled only after its confirmed stop. A failed write
      // leaves its cost provisional, the safe side, and never stops the sweep.
      if (!removed) undeleted++;
      else
        await recordStop({
          path: join(journalDir, stopJournalFile),
          provider: provider.name,
          sandboxId: id,
        }).catch(() => {});

      await note({ kind: "leftover", provider: name, id, removed }).catch(() => {});
    };

    let left: { id: string }[] | null = null;

    try {
      left = await bounded(
        `${name} discovery`,
        async () => {
          // Modal lists only the Apps this process knows: prepare every journaled one first.
          await prepareJournaledApps(provider, apps);

          // Restores whose setup never finished stay tagged pending and out of list() (Modal).
          const found = [
            ...(await provider.list({ "sandbox-bench-run": runId })),
            ...(await pendingForRun(provider, runId)),
          ];

          // A sandbox whose create response was lost joins its App's journal entry.
          for (const item of found)
            for (const app of apps)
              if (reconcileDiscovered([app], provider.name, item)) changed.add(app);

          return found;
        },
        callTimeoutMs,
      );
    } catch (error) {
      await fail("list", error instanceof Error ? error.message : String(error));
    }

    const listed = new Set((left ?? []).map((x) => x.id));

    for (const id of listed) await remove(id);

    // IDs the run knows that discovery did not show (or could not, when it failed): an attempt
    // whose deletion was never confirmed may have left something list() no longer shows (Baseten
    // lists no deleted sandbox, but a volume that failed to delete outlives it), and a live set
    // holds IDs whose record was never written. Destroy treats an absent sandbox as done.
    const known = new Set<string>();

    for (const entry of entries) {
      for (const id of options.known?.get(entry.name) ?? []) known.add(id);

      try {
        for (const id of await unconfirmed(journalDir, runId, entry.name)) known.add(id);
      } catch (error) {
        await fail("attempt records", error instanceof Error ? error.message : String(error));
      }
    }

    for (const id of known) if (!listed.has(id)) await remove(id);

    // A sleeping machine (boxd) is out of list() and can't be checked without waking it.
    try {
      const asleep = await bounded(
        `${name} sleeping listing`,
        () => sleepingUnchecked(provider),
        callTimeoutMs,
      );

      for (const id of asleep)
        await note({ kind: "leftover-unchecked", provider: name, id, reason: "sleeping" });
      unchecked += asleep.length;

      if (!broken)
        await note({
          kind: "swept",
          provider: name,
          found: listed.size,
          sleepingUnchecked: asleep.length,
        });
    } catch (error) {
      await fail("sleeping", error instanceof Error ? error.message : String(error));
    }

    if (broken) failed++;
  }

  for (const app of changed) await persistApp(journal, app);

  return { unchecked, failed, undeleted };
}

async function sweep(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string" },
      run: { type: "string", multiple: true },
      providers: { type: "string" },
    },
  });

  if (!values.out || !values.run?.length) throw new Error("realistic sweep needs --out and --run");
  const out = resolve(values.out);
  const notesPath = join(out, "notes.jsonl");

  const note = (entry: RunNote) =>
    appendFile(notesPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

  const setups = list(
    values.providers,
    providerSetups.map((s) => s.name),
  ).map(providerSetup);

  let unchecked = 0;
  let failed = 0;
  let undeleted = 0;

  for (const track of tracks)
    for (const runId of values.run) {
      const providers: SlotProvider[] = [];

      for (const setup of setups) {
        const loaded = await loadSlotProvider(setup, track, 0, undefined, out);

        if (loaded.kind === "ready") providers.push(loaded.entry);
      }

      const result = await sweepProviders(runId, providers, note, out);

      unchecked += result.unchecked;
      failed += result.failed;
      undeleted += result.undeleted;
    }

  process.stdout.write(`Swept; see ${notesPath}\n`);
  reportSweep({ unchecked, failed, undeleted }, notesPath);
}

const billingSourcesSchema = z.object({
  collectedAt: z.string(),
  recollected: z.array(z.object({ at: z.string(), adapters: z.array(z.string()) })).optional(),
  // Each collector's raw report, kept as written; only its adapter name is read.
  providers: z.array(z.looseObject({ provider: z.string() })),
});

async function readBillingSources(out: string) {
  return billingSourcesSchema.parse(
    JSON.parse(await readFile(join(out, "billing-sources.json"), "utf8")),
  );
}

/** Collect each attempt's charge and write billing.jsonl. */
async function billing(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string" },
      "wait-ms": { type: "string", default: "0" },
      // Recollect only these providers (record names, comma-separated); every other provider's
      // billing.jsonl entries and billing-sources.json rows are kept as they are. A provider whose
      // source has a retention limit (E2B's 7-day events) would otherwise lose its evidence.
      providers: { type: "string" },
    },
  });

  if (!values.out) throw new Error("realistic billing needs --out");
  const out = resolve(values.out);
  const allRecords = await readJsonLines(join(out, "attempts.jsonl"), attemptRecordSchema);
  const only = values.providers === undefined ? null : new Set(values.providers.split(","));

  if (only !== null) {
    const known = new Set(allRecords.map((r) => r.provider));
    const unknown = [...only].filter((p) => !known.has(p));

    if (only.size === 0 || unknown.length > 0)
      throw new Error(
        `--providers names no attempts in ${out}: ${unknown.join(", ") || "(empty)"}`,
      );

    // billing-sources.json keeps one row per adapter, so a recollection takes whole adapters.
    const adapters = new Set([...only].map((p) => providerSetup(p).adapter));

    const sharing = [...known].filter(
      (p) => !only.has(p) && adapters.has(providerSetup(p).adapter),
    );

    if (sharing.length > 0)
      throw new Error(`--providers must also name ${sharing.join(", ")}, which share an adapter`);
  }

  const records = only === null ? allRecords : allRecords.filter((r) => only.has(r.provider));

  // Kept entries: other providers' lines from the previous collection, validated and written back
  // as the exact text they were, so a recollection cannot reformat or strip their evidence.
  const kept = new Map<string, string>();

  if (only !== null)
    for (const line of (await readFile(join(out, "billing.jsonl"), "utf8")).split("\n")) {
      if (line.trim() === "") continue;
      const entry = attemptBillingSchema.parse(JSON.parse(line));
      const record = allRecords.find((r) => r.attemptId === entry.attemptId);

      if (!record) throw new Error(`billing.jsonl names an unknown attempt, ${entry.attemptId}`);

      if (!only.has(record.provider)) kept.set(entry.attemptId, line);
    }

  // Read before anything is collected or written, so a bad file leaves both files as they were.
  const previous = only === null ? null : await readBillingSources(out);

  const apps = await readAppJournal(join(out, appJournalFile));

  // Each attempt's sandboxes: its record's, plus any its App journal names (a reconciliation can
  // recover one whose create response was lost). An attempt whose App still has a create of unknown
  // result is billed as unavailable even when no sandbox ID is known.
  const billable = records.flatMap((record) => {
    const creates = attemptAllocation(apps, {
      provider: providerSetup(record.provider).adapter,
      attemptId: record.attemptId,
    });

    const sandboxIds = [
      ...new Set([
        ...record.sandboxIds,
        ...(creates.kind === "no-create" ? [] : creates.sandboxIds),
      ]),
    ];

    return sandboxIds.length > 0 || creates.kind === "unresolved"
      ? [{ record, sandboxIds, creates }]
      : [];
  });

  // Each journaled App's sandboxes, for the per-App collector (Modal).
  const appOf = ownedApps(apps);
  // A Modal charge settles only after its sandbox's confirmed stop.
  const stops = await readStops(join(out, stopJournalFile));

  const byAdapter = new Map<string, (typeof billable)[number][]>();

  const captured = new Map<string, Cost>();

  for (const item of billable) {
    const { record, sandboxIds } = item;
    const adapter = providerSetup(record.provider).adapter;

    // Usage captured before deletion (Boat, Vercel) is the only evidence once the sandbox is gone.
    for (const file of record.costEvidence.usageFiles) {
      const saved = usageFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));

      for (const sandbox of saved.success ? savedCosts(adapter, saved.data) : [])
        captured.set(sandbox.id, sandbox.cost);
    }

    if (sandboxIds.every((id) => captured.has(id))) continue;
    byAdapter.set(adapter, [...(byAdapter.get(adapter) ?? []), item]);
  }

  const costs = new Map<
    string,
    Awaited<ReturnType<typeof collectProvider>>["sandboxes"][number]["cost"]
  >();

  const raw: object[] = [];

  for (const [adapter, items] of byAdapter) {
    if (["tenki", "freestyle", "baseten", "beam", "styne", "buddy"].includes(adapter)) continue;

    const rows: OwnedSandbox[] = items.flatMap(({ record, sandboxIds }) =>
      sandboxIds.map((id) => ({
        provider: adapter,
        id,
        scenarios: new Set([`${record.profile}/${record.track}/${record.variant}`]),
        startedAt: new Date(record.startedAt).toISOString(),
        finishedAt: new Date(record.endedAt).toISOString(),
        // Modal prices a sandbox from its App's charge, when it is the App's only sandbox.
        confirmedStopAt: stops.get(`${adapter}/${id}`) ?? null,
        app: appOf.get(`${adapter}/${id}`) ?? null,
      })),
    );

    const collected = await collectProvider(
      adapter,
      rows,
      process.env,
      undefined,
      false,
      Number(values["wait-ms"]),
    );

    for (const sandbox of collected.sandboxes) costs.set(sandbox.id, sandbox.cost);
    raw.push({ ...collected, sandboxes: collected.sandboxes.length });
  }

  const entries: AttemptBilling[] = billable.map(({ record, sandboxIds, creates }) => {
    const setup = providerSetup(record.provider);
    const track = trackOf(record);

    const measured = {
      cpuQuota: record.resources?.cpuQuota ?? null,
      memoryGiB: record.resources?.memoryGiB ?? null,
    };

    const allocation = { provisioned: provisionedOf(setup, track, record), measured };
    // The recorded provider name already says which product ran (upstash-ephemeral).
    const base = { attemptId: record.attemptId, product: null, allocation, usage: null };

    if (["tenki", "freestyle", "baseten", "beam", "styne", "buddy"].includes(setup.adapter))
      return {
        ...base,
        charge: { kind: "estimate", source: "billing rules at list price (no billing data)" },
      };

    if (creates.kind === "unresolved")
      return {
        ...base,
        charge: {
          kind: "unavailable",
          reason: `${creates.unresolved} create(s) for this attempt have an unknown result (lost response), so a sandbox may exist that no ID names`,
        },
      };
    const found = sandboxIds.map((id) => captured.get(id) ?? costs.get(id));
    const unpriced = found.filter((cost) => cost === undefined || cost.kind === "unavailable");

    if (unpriced.length > 0 || found.length === 0) {
      const note = unpriced.flatMap((cost) => (cost?.kind === "unavailable" ? [cost.note] : []))[0];

      return {
        ...base,
        charge: { kind: "unavailable", reason: note ?? "no billing row for this sandbox" },
      };
    }

    const priced = found.flatMap((cost) => (cost && cost.kind !== "unavailable" ? [cost] : []));
    const kind = priced[0]?.kind ?? "metered";

    return {
      ...base,
      charge: {
        kind,
        usd: priced.reduce((sum, cost) => sum + cost.usd, 0),
        settled: priced.every((cost) => cost.complete),
        source: priced.map((cost) => cost.note).join("; "),
      },
    };
  });

  // Record order, kept and recollected entries alike.
  const fresh = new Map(
    entries.map((e) => [e.attemptId, JSON.stringify(attemptBillingSchema.parse(e))]),
  );

  const written = allRecords.flatMap((r) => {
    const line = fresh.get(r.attemptId) ?? kept.get(r.attemptId);

    return line === undefined ? [] : [line];
  });

  await writeFile(join(out, "billing.jsonl"), written.join("\n") + "\n");

  // Each recollected adapter replaces its own row; other adapters' rows and times are kept.
  const recollected = new Set(records.map((r) => providerSetup(r.provider).adapter));

  const sourcesFile =
    previous === null
      ? { collectedAt: new Date().toISOString(), providers: raw }
      : {
          collectedAt: previous.collectedAt,
          recollected: [
            ...(previous.recollected ?? []),
            { at: new Date().toISOString(), adapters: [...recollected].sort() },
          ],
          providers: [...previous.providers.filter((p) => !recollected.has(p.provider)), ...raw],
        };

  await writeFile(join(out, "billing-sources.json"), JSON.stringify(sourcesFile, null, 2) + "\n");

  const counts = written
    .map((line) => attemptBillingSchema.parse(JSON.parse(line)))
    .reduce<Record<string, number>>((acc, e) => {
      const key =
        e.charge.kind === "billed" || e.charge.kind === "metered"
          ? `${e.charge.kind}${e.charge.settled ? "" : " (pending)"}`
          : e.charge.kind;

      acc[key] = (acc[key] ?? 0) + 1;

      return acc;
    }, {});

  process.stdout.write(
    `Billing: ${written.length} attempts with sandboxes; ${JSON.stringify(counts)}\n`,
  );
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length === 0
    ? null
    : sorted.length % 2
      ? (sorted[mid] ?? null)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const heldSlots = ["zero-wait", "held-10", "held-60"] as const;

interface HeldRow {
  provider: string;
  idle: (typeof heldSlots)[number];
  runs: number;
  completed: number;
  costKind: string | null;
  /** Median reported cost of one whole run: fix-and-test, the idle wait and the resume step. */
  medianCostUSD: number | null;
  /** Against the same provider's zero-wait twin, from the medians. */
  changeVsZeroWait: number | null;
  medianWakeMs: number | null;
  /** Billed charges settle; metered costs stay unreconciled (see `heldStatus`). */
  status: HeldStatus | null;
  /** Provider state before and after the idle wait, when the adapter reports one. */
  transitions: string[];
}

function heldOpen(attempts: readonly CostedAttempt[]): HeldRow[] {
  const rows: HeldRow[] = [];

  const providers = [
    ...new Set(
      attempts.flatMap((a) => (a.record.variant === "headline" ? [] : [a.record.provider])),
    ),
  ].sort();

  for (const provider of providers) {
    const rule = billingRule(provider, null);
    let zeroWait: number | null = null;

    for (const idle of heldSlots) {
      const runs = attempts.filter(
        (a) => a.record.provider === provider && a.record.slot.id === idle,
      );

      if (!runs.length) continue;
      const costs = rule ? runs.map((attempt) => reportedCost({ attempt, rule, fx })) : [];
      const priced = costs.flatMap((c) => (c.kind === "unavailable" ? [] : [c.usd]));
      const medianCostUSD = costs.length && priced.length === costs.length ? median(priced) : null;

      if (idle === "zero-wait") zeroWait = medianCostUSD;

      rows.push({
        provider,
        idle,
        runs: runs.length,
        completed: runs.filter((a) => a.outcome === "completed").length,
        costKind:
          [
            ...new Set(
              costs.flatMap((c) =>
                c.kind === "unavailable" || c.kind === "nothing-created" ? [] : [c.kind],
              ),
            ),
          ].join("+") || null,
        medianCostUSD,
        changeVsZeroWait:
          idle !== "zero-wait" && medianCostUSD !== null && zeroWait !== null && zeroWait > 0
            ? medianCostUSD / zeroWait - 1
            : null,
        status: heldStatus(costs),
        medianWakeMs: median(
          runs.flatMap((a) =>
            a.record.idle?.wakeLatencyMs == null ? [] : [a.record.idle.wakeLatencyMs],
          ),
        ),
        transitions: [
          ...new Set(
            runs.flatMap((a) =>
              a.record.idle?.stateBefore &&
              a.record.idle.stateAfter &&
              a.record.idle.stateBefore !== a.record.idle.stateAfter
                ? [`${a.record.idle.stateBefore} -> ${a.record.idle.stateAfter}`]
                : [],
            ),
          ),
        ],
      });
    }
  }

  return rows;
}

interface Row {
  provider: string;
  profile: string;
  track: string;
  variant: string;
  attempts: number;
  completed: number;
  incomplete: number;
  notRun: number;
  reasons: Record<string, number>;
  medianWallS: number | null;
  medianCpuS: number | null;
  costKind: string | null;
  costPerCompletedUSD: number | null;
  costNote: string | null;
  wholeMachinePerCompletedUSD: number | null;
  /**
   * "lower" when the whole-machine price is a floor: a request-billed provider's unsized track
   * (Modal's default 0.125 CPU request) bursts above the request and that usage is billed too.
   */
  wholeMachineBound: "exact" | "lower";
  billingModel: string | null;
  eligibility: string;
}

/** Whether a group's whole-machine price is exact or a floor (request-billed, unsized track). */
function wholeMachineBound(group: readonly CostedAttempt[]): "exact" | "lower" {
  const first = group[0];

  if (!first) return "exact";
  const setup = providerSetup(first.record.provider);
  const size = setup.tracks[trackOf(first.record)].size ?? null;

  return requestBilledCompute(setup.pricingKey, size)?.bound ?? "exact";
}

async function summary(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string", multiple: true },
      // Where summary.json and summary.md go; the first --out by default.
      to: { type: "string" },
      // provider@runId[@track]: attempts superseded by a rerun, left out of the table and listed in it.
      drop: { type: "string", multiple: true },
      // Settled-charge audits (cost/audit-file.ts). Without one, every meter stays not reconciled.
      audit: { type: "string" },
    },
  });

  const auditFile = values.audit
    ? auditFileSchema.parse(JSON.parse(await readFile(resolve(values.audit), "utf8")))
    : noAuditFile;

  const drops = (values.drop ?? []).map((item) => {
    const [provider = "", runId = "", track] = item.split("@");

    return { provider, runId, track };
  });

  if (!values.out?.length) throw new Error("realistic summary needs --out");
  const records: AttemptRecord[] = [];
  const bills: AttemptBilling[] = [];

  // Each attempt's pinned region, from its run folder.
  const regionOf = new Map<string, string | null>();

  for (const dir of values.out.map((d) => resolve(d))) {
    const read = await readJsonLines(join(dir, "attempts.jsonl"), attemptRecordSchema);
    const recorded = await readRegions(dir);

    for (const record of read)
      regionOf.set(
        record.attemptId,
        regionFor(recorded, { adapter: providerSetup(record.provider).adapter, dir }),
      );

    records.push(...read);
    bills.push(...(await readJsonLines(join(dir, "billing.jsonl"), attemptBillingSchema)));
  }

  const isDropped = (r: AttemptRecord) =>
    drops.some(
      (d) =>
        d.provider === r.provider &&
        d.runId === r.runId &&
        (d.track === undefined || d.track === r.track),
    );

  const dropped = records.filter(isDropped);
  const kept = records.filter((r) => !isDropped(r));
  const keptIds = new Set(kept.map((r) => r.attemptId));

  const attempts = costedAttempts(
    kept,
    bills.filter((b) => keptIds.has(b.attemptId)),
  );

  // A reconciliation's period is checked against every loaded attempt, dropped ones included: a
  // superseded run still ran, and its charges sit in the provider's settled total. Only a
  // reconciled entry reads them, so a summary without one joins only the kept attempts, as before.
  const everyAttempt = auditFile.entries.some((e) => e.kind === "reconciled")
    ? costedAttempts(records, bills)
    : attempts;

  const groups = new Map<string, CostedAttempt[]>();

  for (const a of attempts) {
    const key = [
      a.record.variant === "headline" ? "headline" : a.record.slot.id,
      a.record.profile,
      a.record.track,
      a.record.provider,
    ].join("|");

    groups.set(key, [...(groups.get(key) ?? []), a]);
  }

  const rows: Row[] = [];
  const candidates = new Map<string, Candidate[]>();

  // The audit each headline group was judged with, for summary.json.
  const audits: { provider: string; profile: string; track: string; audit: AuditUsed }[] = [];

  for (const [key, group] of [...groups].sort(([x], [y]) => x.localeCompare(y))) {
    const [variant = "", profile = "", track = "", provider = ""] = key.split("|");
    const rule = billingRule(provider, null);
    const counted = group.filter((a) => a.outcome !== "not-run");
    const done = counted.filter((a) => a.outcome === "completed");
    const reasons: Record<string, number> = {};

    for (const a of group)
      if (a.record.completion.kind === "incomplete")
        reasons[a.record.completion.reason] = (reasons[a.record.completion.reason] ?? 0) + 1;

    let costPerCompletedUSD: number | null = null;
    let costNote: string | null = null;
    let wholeMachinePerCompletedUSD: number | null = null;
    let eligible = "n/a";
    let costKind: string | null = null;

    if (rule && counted.length) {
      const costs = counted.map((attempt) => reportedCost({ attempt, rule, fx }));
      const unavailable = costs.filter((c) => c.kind === "unavailable");

      const kinds = new Set(
        costs.flatMap((c) =>
          c.kind === "unavailable" || c.kind === "nothing-created" ? [] : [c.kind],
        ),
      );

      costKind = [...kinds].join("+") || null;

      if (unavailable.length)
        costNote = `${unavailable.length} of ${costs.length} attempts unavailable: ${unavailable[0]?.kind === "unavailable" ? unavailable[0].reason : ""}`;
      else if (done.length)
        costPerCompletedUSD =
          costs.reduce((sum, c) => sum + (c.kind === "unavailable" ? 0 : c.usd), 0) / done.length;

      const whole = counted.map((attempt) =>
        wholeMachineListPrice({
          attempt,
          rule,
          fx,
          region: regionOf.get(attempt.record.attemptId) ?? null,
        }),
      );

      if (done.length && whole.every((w) => w.kind === "list-price"))
        wholeMachinePerCompletedUSD =
          whole.reduce((sum, w) => sum + (w.kind === "list-price" ? w.usd : 0), 0) / done.length;

      if (variant === "headline") {
        const { audit, used } = auditFor({
          file: auditFile,
          group: { provider, profile, track },
          attempts: group,
          providerAttempts: everyAttempt.filter((a) => a.record.provider === provider),
        });

        audits.push({ provider, profile, track, audit: used });

        const verdict = eligibility({
          rule,
          comparison: track === "same-machine" ? "same-machine" : "tested-size",
          attempts: group,
          audit,
        });

        // Kind, settlement and provisional status all travel in the eligibility reasons.
        eligible =
          verdict.kind === "eligible"
            ? "eligible"
            : verdict.reasons.map(describeIneligibility).join("; ");

        if (!unavailable.length) {
          const costUSD = new Map(
            counted.map((a, i) => {
              const c = costs[i];

              return [a.record.attemptId, c && c.kind !== "unavailable" ? c.usd : 0];
            }),
          );

          const [batchesRow] = pairedBatches([{ provider, attempts: counted, costUSD }]);
          const list = candidates.get(`${profile}|${track}`) ?? [];
          list.push({
            provider,
            batches: batchesRow?.batches ?? [],
            eligibility: verdict,
            audit,
          });
          candidates.set(`${profile}|${track}`, list);
        }
      }
    }

    rows.push({
      provider,
      profile,
      track,
      variant,
      attempts: group.length,
      completed: done.length,
      incomplete: counted.length - done.length,
      notRun: group.length - counted.length,
      reasons,
      medianWallS: median(done.map(elapsedSeconds)),
      medianCpuS: median(
        done.flatMap((a) =>
          a.record.resources?.cpuSeconds == null ? [] : [a.record.resources.cpuSeconds],
        ),
      ),
      costKind,
      costPerCompletedUSD,
      costNote,
      wholeMachinePerCompletedUSD,
      wholeMachineBound: wholeMachineBound(group),
      billingModel: rule ? billingModelLabel(rule) : null,
      eligibility: eligible,
    });
  }

  const picks = [...candidates].map(([key, list]) => {
    const [profile, track] = key.split("|");
    const verdict = pick({ candidates: list, procedure: null });

    return {
      profile,
      track,
      verdict: verdict.kind,
      label: verdict.label,
      lowest: verdict.kind === "no-certified-winner" ? verdict.lowest : null,
      eligible: verdict.eligible,
      lowerUnverified: verdict.lowerUnverified.map((u) => ({
        provider: u.provider,
        costPerCompletedUSD: u.costPerCompletedUSD,
        reasons: u.reasons,
      })),
      didNotComplete: verdict.didNotComplete,
    };
  });

  const outDir = resolve(values.to ?? values.out[0] ?? ".");
  await mkdir(outDir, { recursive: true });
  const usd = (v: number | null) => (v === null ? "n/a" : `$${(v * 1000).toFixed(2)}`);
  const s = (v: number | null) => (v === null ? "n/a" : v.toFixed(0));

  const table = [
    "| Variant | Profile | Track | Provider | Attempts | Completed | Not run | Median wall (s) | Median CPU (s) | Cost / 1,000 completed | Kind | Whole machine / 1,000 | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.variant} | ${r.profile} | ${r.track} | ${r.provider} | ${r.attempts} | ${r.completed} | ${r.notRun} | ${s(r.medianWallS)} | ${s(r.medianCpuS)} | ${usd(r.costPerCompletedUSD)} | ${r.costKind ?? "n/a"} | ${r.wholeMachineBound === "lower" && r.wholeMachinePerCompletedUSD !== null ? "≥ " : ""}${usd(r.wholeMachinePerCompletedUSD)} | ${[r.eligibility, r.costNote].filter((x) => x && x !== "n/a").join("; ")} |`,
    ),
  ].join("\n");

  const held = heldOpen(attempts);

  const heldTable = held.length
    ? [
        "",
        "Held-open diagnostic (fix-and-test, same-machine, provider-default idle; descriptive):",
        "",
        "| Provider | Idle | Runs | Completed | Median total cost (fix, wait, resume) | Status | Change vs zero-wait | Median wake latency (ms) | Idle state transitions |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...held.map(
          (h) =>
            `| ${h.provider} | ${h.idle} | ${h.runs} | ${h.completed} | ${h.medianCostUSD === null ? "n/a" : `$${h.medianCostUSD.toFixed(5)}`}${h.costKind ? ` (${h.costKind})` : ""} | ${h.status ?? "n/a"} | ${h.changeVsZeroWait === null ? "n/a" : `${h.changeVsZeroWait >= 0 ? "+" : ""}${(h.changeVsZeroWait * 100).toFixed(0)}%`} | ${h.medianWakeMs === null ? "n/a" : h.medianWakeMs.toFixed(0)} | ${h.transitions.join(", ") || "none seen"} |`,
        ),
      ].join("\n")
    : "";

  const pickLines = picks.map(
    (p) =>
      `- ${p.profile} / ${p.track}: ${p.label}${p.lowest ? `; lowest eligible cost: ${p.lowest}` : ""}; eligible: ${p.eligible.join(", ") || "none"}${p.lowerUnverified.length ? `; lower unverified: ${p.lowerUnverified.map((u) => `${u.provider} ($${(u.costPerCompletedUSD * 1000).toFixed(2)}/1,000: ${u.reasons.join(", ")})`).join("; ")}` : ""}`,
  );

  const droppedNote = drops.length
    ? `\nLeft out (superseded by a rerun): ${drops.map((d) => `${d.provider}@${d.runId}${d.track ? `@${d.track}` : ""} (${dropped.filter((r) => r.provider === d.provider && r.runId === d.runId && (d.track === undefined || d.track === r.track)).length} attempts)`).join(", ")}\n`
    : "";

  const text = `${table}\n\nPicks (descriptive; no statistical gate claimed):\n${pickLines.join("\n")}\n${heldTable}\n${droppedNote}`;

  await writeFile(join(outDir, "summary.md"), text);
  await writeFile(
    join(outDir, "summary.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        fx,
        rows,
        picks,
        heldOpen: held,
        audits,
        // Attempts kept on disk but left out of this table, each with its run and outcome.
        dropped: dropped.map((r) => ({
          attemptId: r.attemptId,
          runId: r.runId,
          provider: r.provider,
          track: r.track,
          completion: r.completion,
        })),
        dropRules: drops,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(text);
}

export async function realisticCommand(args: string[]) {
  const [command, ...rest] = args;

  switch (command) {
    case "run":
      return run(rest);
    case "billing":
      return billing(rest);
    case "summary":
      return summary(rest);
    case "sweep":
      return sweep(rest);
    case "burst":
      return (await import("./burst-cli.js")).burstCommand(rest);
    case "burst-summary":
      return (await import("./burst-cli.js")).burstSummaryCommand(rest);
    default:
      process.stdout.write(
        "bun bench realistic run --out DIR --run ID [--plan headline|held-open] [--providers a,b] [--profiles fix-and-test,build] [--tracks same-machine,default] [--batches N] [--first-batch K] [--budget-usd 75]\n" +
          "bun bench realistic billing --out DIR [--providers a,b]\nbun bench realistic summary --out DIR [--out DIR2] [--to DIR] [--drop provider@run[@track]] [--audit FILE]\nbun bench realistic sweep --out DIR --run ID\n" +
          "bun bench realistic burst --out DIR --run ID [--providers a,b] [--size 5] [--rounds 2] [--control] [--parallel N, default 3, or 1 with --control] [--budget-usd 15, a hard cap only where the provider enforces a lifetime] [--solo realistic.json, not read with --control]\n" +
          "bun bench realistic burst-summary --out DIR [--out DIR2] --solo realistic.json --to FILE\n",
      );
  }
}
