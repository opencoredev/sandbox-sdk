/**
 * `bun bench realistic <run|billing|summary|sweep>`: the release-1 profiles on real providers.
 *
 * run      Load SBX-95's frozen manifest and the providers' per-track setups (setup.ts), then run
 *          batches through the slot scheduler, writing one record per attempt to attempts.jsonl.
 *          Artifacts are uploaded from local files through the SDK (no hosted cache). Attempts the
 *          fit check rules out (FIT.md) get a "default-size-too-small" record without a paid run.
 *          A budget guard stops before a slot whose reservation would cross the cap.
 * billing  Collect each attempt's charge with bench/src/billing and write billing.jsonl.
 * summary  Completion, median wall and CPU, cost per completed task with kind and status, through
 *          the cost model's eligibility and picks (descriptive: no statistical gate is claimed).
 * sweep    List every provider for sandboxes labelled with this run and delete any left.
 */
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CreateInput, Provider } from "@opencoredev/sandbox-sdk/provider";
import { z } from "zod";
import type { OwnedSandbox } from "../billing/input.js";
import type { Json } from "../json.js";
import { collectProvider } from "../billing/providers.js";
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
import { describeIneligibility, eligibility, type CostSourceAudit } from "../cost/eligibility.js";
import { pick, type Candidate } from "../cost/picks.js";
import { budgetUSD, estimateCost } from "../pricing.js";
import { loadProvider } from "../providers.js";
import { shuffle } from "../v2-stats.js";
import { harnessManifestFromFrozen } from "./frozen.js";
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
} from "./setup.js";
import {
  attributionFor,
  batchSeed,
  emptyRecord,
  runBatch,
  type SlotProvider,
  type SlotSpec,
} from "./slots.js";
import { sha256Hex } from "./steps.js";

/** One line of notes.jsonl. */
type RunNote = { readonly kind: string } & { readonly [key: string]: Json | undefined };

const defaultManifest = "/home/leo/agents/realistic-workloads/manifest.json";

/** Where the frozen artifacts live on evo-1, top level only. */
const defaultArtifactDirs = [
  "/home/leo/agents/realistic-workloads/depcache/vue-core",
  "/home/leo/agents/realistic-workloads/depcache/jitsi-web",
  "/home/leo/agents/realistic-workloads/toolchain",
  "/home/leo/agents/realistic-workloads/patches",
  `${process.env.HOME ?? ""}/.cache/sbx98/artifacts`,
];

const fx = { eurToUsd: 1.08, date: "2026-11-05" } as const;

const heldOpenProviders = ["e2b", "daytona", "upstash", "upstash-ephemeral", "boat", "boxd"];

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
async function artifactPaths(manifest: HarnessManifest, dirs: readonly string[]) {
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
function attemptBudget(setup: ProviderSetup, track: TrackId, durationMs: number): number {
  const size = setup.tracks[track].provisioned;
  const cost = estimateCost(setup.pricingKey, durationMs, size);

  // Unknown prices are counted at a conservative $1 per hour.
  return cost === null ? (durationMs / 3_600_000) * 1 : budgetUSD(setup.pricingKey, cost);
}

function trackOf(record: AttemptRecord): TrackId {
  return record.track === "default" ? "default" : "same-machine";
}

async function spentUSD(path: string) {
  const records = await readJsonLines(path, attemptRecordSchema);

  return records.reduce(
    (sum, r) =>
      r.sandboxIds.length === 0
        ? sum
        : sum + attemptBudget(providerSetup(r.provider), trackOf(r), r.endedAt - r.startedAt),
    0,
  );
}

/** Boat reports a sandbox's usage only while it exists; the billing collector reads it then. */
function captureUsage(adapter: string, usageDir: string) {
  return async (id: string) => {
    const collected = await collectProvider(
      adapter,
      [
        {
          provider: adapter,
          id,
          scenarios: new Set(["pre-destroy"]),
          startedAt: null,
          finishedAt: null,
        },
      ],
      process.env,
    );

    await mkdir(usageDir, { recursive: true });
    const file = join(usageDir, `${adapter}-${id}.json`);
    await writeFile(
      file,
      JSON.stringify({ capturedAt: new Date().toISOString(), ...collected }) + "\n",
    );

    return file;
  };
}

/** The billing collector's per-sandbox cost, as saved in a usage file. */
const costSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["billed", "metered"]),
    usd: z.number().finite().nonnegative(),
    scope: z.enum(["sandbox-lifetime", "window"]),
    complete: z.boolean(),
    confidence: z.enum(["high", "medium", "low"]),
    note: z.string(),
  }),
  z.object({ kind: z.literal("unavailable"), confidence: z.literal("none"), note: z.string() }),
]);

const usageFileSchema = z.object({
  sandboxes: z.array(z.object({ id: z.string(), cost: costSchema })),
});

async function loadSlotProvider(
  setup: ProviderSetup,
  track: TrackId,
  slotMs: number,
  usageDir?: string,
): Promise<{ kind: "ready"; entry: SlotProvider } | { kind: "skipped"; note: string }> {
  const config = setup.tracks[track];

  const loaded = await loadProvider(setup.adapter, process.env, undefined, {
    template: config.template ? { [setup.adapter]: config.template } : {},
    product: setup.product ? { [setup.adapter]: setup.product } : {},
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

  if (setup.adapter === "boat" && usageDir)
    entry.beforeDestroy = captureUsage(setup.adapter, usageDir);

  // Measured 2026-11-05: Tenki answers a write started while three others run with gRPC 13.
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

  const cap = Number(values["budget-usd"]);
  const seed = Number(values.seed);
  const firstBatch = Number(values["first-batch"]);
  const batches = Number(values.batches);
  const setups = providerNames.map(providerSetup);

  const loaded = new Map<string, SlotProvider>();
  const longest = plan === "held-open" ? 60 * 60_000 : 0;

  for (const track of trackIds)
    for (const setup of setups) {
      const slotMs = (manifest.profiles["fix-and-test"]?.slotTimeoutMs ?? 0) + longest;
      const result = await loadSlotProvider(setup, track, slotMs, join(out, "usage"));

      if (result.kind === "skipped")
        await note({ kind: "provider-skipped", provider: setup.name, track, reason: result.note });
      else loaded.set(`${setup.name}/${track}`, result.entry);
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

  for (let batch = firstBatch; batch < firstBatch + batches; batch++) {
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

        const entry = loaded.get(`${setup.name}/${track}`);

        if (entry) active.push(entry);
      }

      if (!active.length) continue;
      const spent = await spentUSD(attemptsPath);

      const reserve = active.reduce(
        (sum, entry) => sum + attemptBudget(providerSetup(entry.name), track, slotMs),
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

        return;
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
        onSandbox: (provider, id) => note({ kind: "sandbox", provider, id, batch, slot: slot.id }),
      });
    }
  }

  await sweepProviders(values.run, [...loaded.values()], note);
}

async function sweepProviders(
  runId: string,
  providers: readonly SlotProvider[],
  note: (entry: RunNote) => Promise<void>,
) {
  const seen = new Set<Provider>();

  for (const entry of providers) {
    if (seen.has(entry.provider)) continue;
    seen.add(entry.provider);

    try {
      const left = await entry.provider.list({ "sandbox-bench-run": runId });

      for (const item of left) {
        const removed = await entry.provider
          .destroy(item.id)
          .then(() => true)
          .catch(() => false);

        await note({ kind: "leftover", provider: entry.name, id: item.id, removed });
      }

      await note({ kind: "swept", provider: entry.name, found: left.length });
    } catch (error) {
      await note({
        kind: "sweep-failed",
        provider: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
  const notesPath = join(resolve(values.out), "notes.jsonl");

  const note = (entry: RunNote) =>
    appendFile(notesPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

  const setups = list(
    values.providers,
    providerSetups.map((s) => s.name),
  ).map(providerSetup);

  for (const track of tracks)
    for (const runId of values.run) {
      const providers: SlotProvider[] = [];

      for (const setup of setups) {
        const loaded = await loadSlotProvider(setup, track, 0);

        if (loaded.kind === "ready") providers.push(loaded.entry);
      }

      await sweepProviders(runId, providers, note);
    }

  process.stdout.write(`Swept; see ${notesPath}\n`);
}

/** Collect each attempt's charge and write billing.jsonl. */
async function billing(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { out: { type: "string" }, "wait-ms": { type: "string", default: "0" } },
  });

  if (!values.out) throw new Error("realistic billing needs --out");
  const out = resolve(values.out);
  const records = await readJsonLines(join(out, "attempts.jsonl"), attemptRecordSchema);
  const withSandbox = records.filter((r) => r.sandboxIds.length > 0);
  const byAdapter = new Map<string, AttemptRecord[]>();

  const captured = new Map<string, z.infer<typeof costSchema>>();

  for (const record of withSandbox) {
    const adapter = providerSetup(record.provider).adapter;

    // Usage captured before deletion (Boat) is the only evidence once the sandbox is gone.
    for (const file of record.costEvidence.usageFiles) {
      const saved = usageFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));

      for (const sandbox of saved.success ? saved.data.sandboxes : [])
        captured.set(sandbox.id, sandbox.cost);
    }

    if (record.sandboxIds.every((id) => captured.has(id))) continue;
    byAdapter.set(adapter, [...(byAdapter.get(adapter) ?? []), record]);
  }

  const costs = new Map<
    string,
    Awaited<ReturnType<typeof collectProvider>>["sandboxes"][number]["cost"]
  >();

  const raw: object[] = [];

  for (const [adapter, items] of byAdapter) {
    if (adapter === "tenki" || adapter === "freestyle") continue;

    const rows: OwnedSandbox[] = items.flatMap((record) =>
      record.sandboxIds.map((id) => ({
        provider: adapter,
        id,
        scenarios: new Set([`${record.profile}/${record.track}/${record.variant}`]),
        startedAt: new Date(record.startedAt).toISOString(),
        finishedAt: new Date(record.endedAt).toISOString(),
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

  const entries: AttemptBilling[] = withSandbox.map((record) => {
    const setup = providerSetup(record.provider);
    const track = trackOf(record);

    const measured = {
      cpuQuota: record.resources?.cpuQuota ?? null,
      memoryGiB: record.resources?.memoryGiB ?? null,
    };

    const allocation = { provisioned: setup.tracks[track].provisioned, measured };
    // The recorded provider name already says which product ran (upstash-ephemeral).
    const base = { attemptId: record.attemptId, product: null, allocation, usage: null };

    if (setup.adapter === "tenki" || setup.adapter === "freestyle")
      return {
        ...base,
        charge: { kind: "estimate", source: "billing rules at list price (no billing data)" },
      };
    const found = record.sandboxIds.map((id) => captured.get(id) ?? costs.get(id));
    const missing = found.find((cost) => cost === undefined || cost.kind === "unavailable");

    if (missing !== undefined || found.length === 0)
      return {
        ...base,
        charge: {
          kind: "unavailable",
          reason:
            missing && missing.kind === "unavailable"
              ? missing.note
              : "no billing row for this sandbox",
        },
      };

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

  await writeFile(
    join(out, "billing.jsonl"),
    entries.map((e) => JSON.stringify(attemptBillingSchema.parse(e))).join("\n") + "\n",
  );
  await writeFile(
    join(out, "billing-sources.json"),
    JSON.stringify({ collectedAt: new Date().toISOString(), providers: raw }, null, 2) + "\n",
  );

  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    const key =
      e.charge.kind === "billed" || e.charge.kind === "metered"
        ? `${e.charge.kind}${e.charge.settled ? "" : " (pending)"}`
        : e.charge.kind;

    acc[key] = (acc[key] ?? 0) + 1;

    return acc;
  }, {});

  process.stdout.write(
    `Billing: ${entries.length} attempts with sandboxes; ${JSON.stringify(counts)}\n`,
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

const pilotAudit: CostSourceAudit = {
  reconciliation: {
    kind: "not-reconciled",
    reason: "pilot: no settled-charge reconciliation was run",
  },
  resolutionUSDPerAttempt: 0,
  provisional: null,
};

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
  billingModel: string | null;
  eligibility: string;
}

async function summary(args: string[]) {
  const { values } = parseArgs({ args, options: { out: { type: "string", multiple: true } } });

  if (!values.out?.length) throw new Error("realistic summary needs --out");
  const records: AttemptRecord[] = [];
  const bills: AttemptBilling[] = [];

  for (const dir of values.out.map((d) => resolve(d))) {
    records.push(...(await readJsonLines(join(dir, "attempts.jsonl"), attemptRecordSchema)));
    bills.push(...(await readJsonLines(join(dir, "billing.jsonl"), attemptBillingSchema)));
  }

  const attempts = costedAttempts(records, bills);
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

      const whole = counted.map((attempt) => wholeMachineListPrice({ attempt, rule, fx }));

      if (done.length && whole.every((w) => w.kind === "list-price"))
        wholeMachinePerCompletedUSD =
          whole.reduce((sum, w) => sum + (w.kind === "list-price" ? w.usd : 0), 0) / done.length;

      if (variant === "headline") {
        const verdict = eligibility({
          rule,
          comparison: track === "same-machine" ? "same-machine" : "tested-size",
          attempts: group,
          audit: pilotAudit,
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
            audit: pilotAudit,
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

  const outDir = resolve(values.out[0] ?? ".");
  const usd = (v: number | null) => (v === null ? "n/a" : `$${(v * 1000).toFixed(2)}`);
  const s = (v: number | null) => (v === null ? "n/a" : v.toFixed(0));

  const table = [
    "| Variant | Profile | Track | Provider | Attempts | Completed | Not run | Median wall (s) | Median CPU (s) | Cost / 1,000 completed | Kind | Whole machine / 1,000 | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.variant} | ${r.profile} | ${r.track} | ${r.provider} | ${r.attempts} | ${r.completed} | ${r.notRun} | ${s(r.medianWallS)} | ${s(r.medianCpuS)} | ${usd(r.costPerCompletedUSD)} | ${r.costKind ?? "n/a"} | ${usd(r.wholeMachinePerCompletedUSD)} | ${[r.eligibility, r.costNote].filter((x) => x && x !== "n/a").join("; ")} |`,
    ),
  ].join("\n");

  const held = heldOpen(attempts);

  const heldTable = held.length
    ? [
        "",
        "Held-open diagnostic (fix-and-test, same-machine, provider-default idle; descriptive):",
        "",
        "| Provider | Idle | Runs | Completed | Median total cost (fix, wait, resume) | Change vs zero-wait | Median wake latency (ms) | Idle state transitions |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ...held.map(
          (h) =>
            `| ${h.provider} | ${h.idle} | ${h.runs} | ${h.completed} | ${h.medianCostUSD === null ? "n/a" : `$${h.medianCostUSD.toFixed(5)}`}${h.costKind ? ` (${h.costKind})` : ""} | ${h.changeVsZeroWait === null ? "n/a" : `${h.changeVsZeroWait >= 0 ? "+" : ""}${(h.changeVsZeroWait * 100).toFixed(0)}%`} | ${h.medianWakeMs === null ? "n/a" : h.medianWakeMs.toFixed(0)} | ${h.transitions.join(", ") || "none seen"} |`,
        ),
      ].join("\n")
    : "";

  const pickLines = picks.map(
    (p) =>
      `- ${p.profile} / ${p.track}: ${p.label}${p.lowest ? `; lowest eligible cost: ${p.lowest}` : ""}; eligible: ${p.eligible.join(", ") || "none"}${p.lowerUnverified.length ? `; lower unverified: ${p.lowerUnverified.map((u) => `${u.provider} ($${(u.costPerCompletedUSD * 1000).toFixed(2)}/1,000: ${u.reasons.join(", ")})`).join("; ")}` : ""}`,
  );

  const text = `${table}\n\nPicks (descriptive; no statistical gate claimed):\n${pickLines.join("\n")}\n${heldTable}\n`;

  await writeFile(join(outDir, "summary.md"), text);
  await writeFile(
    join(outDir, "summary.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), fx, rows, picks, heldOpen: held },
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
    default:
      process.stdout.write(
        "bun bench realistic run --out DIR --run ID [--plan headline|held-open] [--providers a,b] [--profiles fix-and-test,build] [--tracks same-machine,default] [--batches N] [--first-batch K] [--budget-usd 75]\n" +
          "bun bench realistic billing --out DIR\nbun bench realistic summary --out DIR [--out DIR2]\nbun bench realistic sweep --out DIR --run ID\n",
      );
  }
}
