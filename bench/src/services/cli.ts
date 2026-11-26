/**
 * `bun bench services <prepare|run|summary|sweep>`: Docker and services inside the sandbox.
 *
 * prepare  Download the pinned inputs, build the fixture and no-Docker bundle artifacts into the
 *          cache (default ~/.cache/sandbox-bench/services) and write artifacts.json.
 * run      For each provider, `--attempts` rounds of each `--paths` path, each on a fresh sandbox
 *          with the same-machine size by default. Writes run.json, services-attempts.jsonl (one
 *          record per attempt, failures included), owned.jsonl (every sandbox ID as it is
 *          created), notes.jsonl and raw step output under outputs/. Sweeps the run's label at
 *          the end and fails when anything is left.
 * summary  The site data file services.json and summary.md from one or more run folders.
 * sweep    List every named provider for sandboxes labelled with this run and delete any left.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { FactoryOptions } from "../providers.js";
import { attemptBudget, loadSlotProvider, sweepProviders, type RunNote } from "../realistic/cli.js";
import { providerSetup, providerSetups, tracks, type TrackId } from "../realistic/setup.js";
import type { SlotProvider } from "../realistic/slots.js";
import { defaultCacheDir, prepareArtifacts, readArtifact, readArtifacts } from "./artifacts.js";
import { composeDownMs, deadlineGraceMs, runServicesAttempt } from "./attempt.js";
import { SpendGuard, parseProviderCaps } from "./budget.js";
import {
  attemptRecordSchema,
  projectEventSchema,
  projectOpen,
  servicePathSchema,
  type AttemptRecord,
  type ServicePath,
} from "./record.js";
import {
  servicesSiteData,
  summaryMarkdown,
  type Missing,
  type NotRun,
  type RunInfo,
} from "./summary.js";

export const recordsFile = "services-attempts.jsonl";
const ownedFile = "owned.jsonl";

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const positiveInt = (name: string, value: string | undefined) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`--${name} must be a positive integer, got ${value}`);

  return parsed;
};

function sdkCommit(): string {
  const pinned = process.env.BENCH_COLLECTION_COMMIT?.trim();

  if (pinned) return pinned;

  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

const runInfoSchema = z.object({
  id: z.string(),
  sdkCommit: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  location: z.string(),
  settings: z.record(z.string(), z.string()),
  /** The run's effective timing settings and placement; null in runs from before they were recorded. */
  conditions: z
    .object({
      attemptTimeoutMs: z.number(),
      daemonReadyMs: z.number(),
      /** Per provider: each placement variable its adapter reads, and its value (null when unset). */
      placement: z.record(z.string(), z.record(z.string(), z.string().nullable())).default({}),
    })
    .nullable()
    .default(null),
  artifacts: z.object({ node: z.string(), fixture: z.string(), native: z.string() }),
});

const ownedSchema = z.object({ provider: z.string(), id: z.string(), attemptId: z.string() });

/** projects.jsonl: each Compose project claim before `up`, and the line that resolves it. */
const projectsFile = "projects.jsonl";

/** submissions.jsonl: one line just before each create request. */
const submissionsFile = "submissions.jsonl";

const submissionSchema = z.object({
  provider: z.string(),
  attemptId: z.string(),
  /** False on the line an attempt writes when it ended before sending the create it announced. */
  sent: z.boolean().optional(),
});

/** run.json as written by `run`: its identity plus the unique ownership label of its sandboxes. */
const runFileSchema = runInfoSchema.extend({
  /** Absent in runs from before it existed; those folders are not swept by label (see sweep). */
  ownerLabel: z.string().min(1).optional(),
  /** Providers the run admitted, so a later sweep knows where to look. */
  providers: z.array(z.string()).optional(),
  /** What the run set out to do: every admitted provider, each path, attempts 1..attempts. */
  plan: z
    .object({ paths: z.array(servicePathSchema), attempts: z.number().int().positive() })
    .nullable()
    .default(null),
  /**
   * How the run ended: `complete` only when every planned attempt has a result and nothing stopped
   * admission; `stopped` (budget, signal, an unreconciled deletion, a provider stopped early) or
   * `failed` (a worker error) otherwise. `running` until the run finalizes, so a folder left by a
   * crash says so.
   */
  disposition: z.enum(["running", "complete", "stopped", "failed"]).default("running"),
});

/**
 * Placement variables each adapter reads (packages/sdk providers), recorded per provider so runs
 * placed differently are never pooled. Region values, never secrets.
 */
const placementEnv = new Map([
  ["modal", ["MODAL_SANDBOX_REGION"]],
  ["daytona", ["DAYTONA_TARGET"]],
  ["buddy", ["BUDDY_REGION"]],
  ["archil", ["ARCHIL_REGION"]],
  ["sandboxer", ["SANDBOXER_REGION"]],
]);

/** A file's text; null only when it does not exist, so a real read error is never an empty file. */
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Every line that parses; a torn or foreign line is counted, never fatal (crash recovery). A file
 * that exists but cannot be read comes back as `error`, so recovery reports it as unchecked.
 */
async function readJournal<T>(path: string, schema: z.ZodType<T>) {
  const items: T[] = [];
  let bad = 0;
  let text: string | null;

  try {
    text = await readText(path);
  } catch (error) {
    return {
      items,
      bad,
      error: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;

    try {
      items.push(schema.parse(JSON.parse(line)));
    } catch {
      bad++;
    }
  }

  return { items, bad, error: null };
}

/** The notes that explain a provider with fewer attempts than planned; other kinds are skipped. */
const notRunNoteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("provider-skipped"), provider: z.string(), reason: z.string() }),
  z.object({
    kind: z.literal("budget-stop"),
    provider: z.string(),
    attempt: z.number(),
    path: z.string(),
    spentUSD: z.number(),
    reservedUSD: z.number(),
  }),
]);

async function readNotRun(dir: string, runId: string): Promise<NotRun[]> {
  const { items, error } = await readJournal(join(dir, "notes.jsonl"), notRunNoteSchema);

  if (error) throw new Error(`Cannot read the run's notes: ${error}`);

  return items.map((n) => ({
    runId,
    provider: n.provider,
    reason:
      n.kind === "provider-skipped"
        ? n.reason
        : `spend cap reached before attempt ${n.attempt} ${n.path} ($${n.spentUSD.toFixed(2)} spent, $${n.reservedUSD.toFixed(2)} reserved); no later attempt ran`,
  }));
}

/** Every line, strictly: the summary publishes nothing from a file it cannot fully read. */
async function readRecords(path: string): Promise<AttemptRecord[]> {
  const text = await readText(path);

  if (text === null) return [];

  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      const parsed = attemptRecordSchema.safeParse(JSON.parse(line));

      if (!parsed.success) throw new Error(`${path}:${index + 1}: ${parsed.error.message}`);

      return parsed.data;
    });
}

/**
 * IDs this run created whose deletion no record confirms, by provider; creates whose outcome is
 * unknown (no ID, deletion unconfirmed) by provider; and the count of unreadable journal lines.
 */
async function unconfirmedOwned(
  out: string,
  live: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  /** In-memory unknown creates by provider, in case their rows never reached the disk. */
  /** In-memory unknown creates: attempt ID to provider. */
  liveUnknown: ReadonlyMap<string, string> = new Map(),
  /** Attempts this process saw finish, in case their rows never reached the disk. */
  liveDone: ReadonlySet<string> = new Set(),
) {
  const owned = await readJournal(join(out, ownedFile), ownedSchema);
  const records = await readJournal(join(out, recordsFile), attemptRecordSchema);

  const confirmed = new Set(
    records.items.flatMap((r) => (r.deletionConfirmed ? r.sandboxIds : [])),
  );

  const known = new Map<string, Set<string>>();

  const add = (provider: string, id: string) => {
    if (!confirmed.has(id)) known.set(provider, (known.get(provider) ?? new Set()).add(id));
  };

  for (const entry of owned.items) add(entry.provider, entry.id);

  for (const [provider, ids] of live) for (const id of ids) add(provider, id);

  // An attempt row whose deletion is unconfirmed names IDs too, even when owned.jsonl missed one.
  for (const r of records.items)
    if (!r.deletionConfirmed) for (const id of r.sandboxIds) add(r.provider, id);
  // Unknown creates by attempt ID, so a row on disk and its in-memory copy count once.
  const unknownAttempts = new Map<string, string>();
  const bump = (provider: string, attemptId: string) => unknownAttempts.set(attemptId, provider);

  for (const r of records.items)
    if (!r.deletionConfirmed && r.sandboxIds.length === 0) bump(r.provider, r.attemptId);

  // A create submitted with no attempt row at all (a crash mid-attempt) is unknown as well, unless
  // the ownership journal shows what it made.
  const submissions = await readJournal(join(out, submissionsFile), submissionSchema);
  const recorded = new Set(records.items.map((r) => r.attemptId));
  const ownedAttempts = new Set(owned.items.map((o) => o.attemptId));

  const notSent = new Set(
    submissions.items.flatMap((s) => (s.sent === false ? [s.attemptId] : [])),
  );

  for (const sub of submissions.items)
    if (
      sub.sent !== false &&
      !notSent.has(sub.attemptId) &&
      !recorded.has(sub.attemptId) &&
      !ownedAttempts.has(sub.attemptId) &&
      !liveDone.has(sub.attemptId)
    )
      bump(sub.provider, sub.attemptId);

  for (const [attemptId, provider] of liveUnknown) bump(provider, attemptId);
  const unresolved = new Map<string, number>();

  for (const provider of unknownAttempts.values())
    unresolved.set(provider, (unresolved.get(provider) ?? 0) + 1);

  // Project claims journaled before `up`, even when the attempt row never reached the disk.
  const projects = await readJournal(join(out, projectsFile), projectEventSchema);
  const claims = new Map<string, (typeof projects.items)[number]>();
  const key = (e: { attemptId: string; daemon: string }) => `${e.attemptId} ${e.daemon}`;

  for (const event of projects.items)
    if (event.state === "pending") claims.set(key(event), event);
    else claims.delete(key(event));

  const pending = [...claims.values()];

  return {
    known,
    unresolved,
    /**
     * Attempts whose Compose project obligation no sandbox deletion resolves: an open project in
     * its row, or a claim on a daemon that was already there with no line resolving it.
     */
    openProjects: [
      ...new Set([
        ...records.items.flatMap((r) => (projectOpen(r) ? [r.attemptId] : [])),
        ...pending.flatMap((c) => (c.provenance === "as-found" ? [c.attemptId] : [])),
      ]),
    ],
    /** Unresolved claims on daemons launched inside their sandbox: a clean sweep resolves them. */
    launchedProjects: [
      ...new Set(pending.flatMap((c) => (c.provenance === "launched" ? [c.attemptId] : []))),
    ],
    unreadable: owned.bad + records.bad + submissions.bad + projects.bad,
    /** Journals that exist but could not be read: what they held is unknown. */
    unreadableFiles: [owned.error, records.error, submissions.error, projects.error].filter(
      (error): error is string => error !== null,
    ),
  };
}

/**
 * notes.jsonl writes that never throw: a note that cannot be written goes to stderr, and listing
 * and deletion carry on without it.
 */
export const bestEffortNotes =
  (path: string) =>
  (entry: RunNote): Promise<void> =>
    appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`).catch(
      (error: Error) => {
        process.stderr.write(
          `Could not write ${path} (${error.message}); going on without this note: ${JSON.stringify(entry)}\n`,
        );
      },
    );

/** Wait for a sandbox from an unknown-outcome create to show up in its provider's listing. */
const visibilityWindowMs = 60_000;

/**
 * The realistic sweep (label discovery, then every known ID), with a fallback: when it throws
 * before reaching the providers (a torn Modal App journal), every known ID is still deleted by ID.
 */
async function sweepRun(input: {
  label: string;
  entries: readonly SlotProvider[];
  note: (entry: RunNote) => Promise<void>;
  out: string;
  known: ReadonlyMap<string, ReadonlySet<string>>;
}) {
  try {
    return await sweepProviders(input.label, input.entries, input.note, input.out, {
      known: input.known,
    });
  } catch (error) {
    await input
      .note({ kind: "sweep-error", error: error instanceof Error ? error.message : String(error) })
      .catch(() => {});
    let undeleted = 0;

    for (const entry of input.entries)
      for (const id of input.known.get(entry.name) ?? []) {
        const removed = await Promise.race([
          entry.provider.destroy(id).then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 120_000)),
        ]);

        if (!removed) undeleted++;
        await input
          .note({ kind: "leftover", provider: entry.name, id, removed, via: "fallback" })
          .catch(() => {});
      }

    // The label listing never ran, so the run cannot claim nothing else is left.
    return { unchecked: input.entries.length, failed: 1, undeleted };
  }
}

/** The destroy deadline an attempt gets after its own timeout (runServicesAttempt's default). */
const destroyWindowMs = 120_000;

/**
 * How long a sandbox can bill past the attempt's timeout: the hard-deadline grace, native
 * diagnostics, the cleanup window (a late create and the destroy share it), and slack for the
 * bounded journal calls.
 */
const billablePastTimeoutMs = Math.max(
  deadlineGraceMs + 30_000 + composeDownMs + 30_000 + destroyWindowMs + 1000 + 60_000,
  // A sandbox whose create lost its response can live until the hard lifetime the realistic
  // loader gives each provider that takes one: the slot (our timeout) plus 15 minutes.
  15 * 60_000,
);

/**
 * Factory options for this suite's adapters. Modal runs Docker only on its VM runtime (docs.ts).
 * Where an adapter can end a sandbox on its own, it is told to, so one this run loses track of
 * cannot bill for long: Superserve pauses it after the attempt's slot plus 15 minutes of active
 * time and deletes it on pause, and Boat stops it after that long. Adapters that take a create
 * lifetime get the same bound from the realistic loader; Upstash and Buddy take none.
 */
export function servicesFactory(
  adapter: string,
  timeoutMs: number,
  modalRuntime: "gvisor" | "vm" | null,
): FactoryOptions | undefined {
  const lifetimeMs = timeoutMs + 15 * 60_000;

  if (adapter === "modal") return modalRuntime ? { runtime: modalRuntime } : undefined;

  if (adapter === "superserve") return { autoPauseMs: lifetimeMs, autoDeleteMs: 0 };

  if (adapter === "boat") return { ttlSeconds: Math.ceil(lifetimeMs / 1000) };

  return undefined;
}

async function run(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      providers: { type: "string" },
      paths: { type: "string", default: "compose,native" },
      attempts: { type: "string", default: "3" },
      track: { type: "string", default: "same-machine" },
      run: { type: "string" },
      out: { type: "string" },
      cache: { type: "string", default: defaultCacheDir },
      "max-dollars": { type: "string", default: "15" },
      "provider-max-dollars": { type: "string" },
      "attempt-timeout-ms": { type: "string", default: "1500000" },
      "daemon-ready-ms": { type: "string", default: "45000" },
      concurrency: { type: "string", default: "4" },
      location: { type: "string", default: "unknown" },
      "modal-runtime": { type: "string" },
    },
  });

  if (!values.run || !values.out || !values.providers)
    throw new Error("services run needs --providers, --run and --out");
  const track = z.enum(tracks).parse(values.track) satisfies TrackId;
  const paths = list(values.paths).map((p) => servicePathSchema.parse(p));

  if (!paths.length) throw new Error("--paths names no path");

  if (new Set(paths).size !== paths.length) throw new Error("--paths names a path twice");

  if (new Set(list(values.providers)).size !== list(values.providers).length)
    throw new Error("--providers names a provider twice");
  const attempts = positiveInt("attempts", values.attempts);
  const timeoutMs = positiveInt("attempt-timeout-ms", values["attempt-timeout-ms"]);
  const daemonReadyMs = positiveInt("daemon-ready-ms", values["daemon-ready-ms"]);
  const concurrency = positiveInt("concurrency", values.concurrency);

  const modalRuntime =
    values["modal-runtime"] === undefined
      ? null
      : z.enum(["gvisor", "vm"]).parse(values["modal-runtime"]);

  const guard = new SpendGuard(
    Number(values["max-dollars"]),
    parseProviderCaps(values["provider-max-dollars"]),
  );

  const setups = list(values.providers).map(providerSetup);
  const cache = resolve(values.cache);
  const artifacts = await readArtifacts(cache);
  const out = resolve(values.out);
  const runId = values.run;
  await mkdir(join(out, "outputs"), { recursive: true });

  const info = {
    id: runId,
    // Unique per collection: a sweep deletes only this run's sandboxes, even when another run
    // reuses the same --run name in another folder.
    ownerLabel: `${runId}-${randomBytes(4).toString("hex")}`,
    sdkCommit: sdkCommit(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    location: values.location,
    // Per provider: the setting applies to that provider's rows only.
    settings: modalRuntime ? { modal: `runtime=${modalRuntime}` } : {},
    conditions: {
      attemptTimeoutMs: timeoutMs,
      daemonReadyMs,
      placement: Object.fromEntries(
        setups.map((s) => [
          s.name,
          Object.fromEntries(
            (placementEnv.get(s.adapter) ?? []).map((name) => [name, process.env[name] ?? null]),
          ),
        ]),
      ),
    },
    plan: { paths, attempts },
    disposition: "running",
    artifacts: {
      node: artifacts.node.sha256,
      fixture: artifacts.fixture.sha256,
      native: artifacts.native.sha256,
    },
  } satisfies z.infer<typeof runFileSchema>;

  // `wx`: a run folder is never reused for a new collection.
  await writeFile(join(out, "run.json"), `${JSON.stringify(info, null, 2)}\n`, { flag: "wx" });
  const notesPath = join(out, "notes.jsonl");
  const note = bestEffortNotes(notesPath);

  const entries: { setup: (typeof setups)[number]; entry: SlotProvider }[] = [];

  for (const setup of setups) {
    // Modal runs Docker only on its VM runtime (docs.ts); the default runtime is gVisor.
    const extra = servicesFactory(setup.adapter, timeoutMs, modalRuntime);

    const loaded = await loadSlotProvider(
      setup,
      track,
      timeoutMs,
      undefined,
      out,
      undefined,
      extra,
    );

    if (loaded.kind === "skipped") {
      await note({ kind: "provider-skipped", provider: setup.name, reason: loaded.note });
      process.stderr.write(`${setup.name}: skipped: ${loaded.note}\n`);
    } else entries.push({ setup, entry: loaded.entry });
  }

  await writeFile(
    join(out, "run.json"),
    `${JSON.stringify({ ...info, providers: entries.map((e) => e.entry.name) }, null, 2)}\n`,
  );
  let stopping = false;

  const stop = () => {
    stopping = true;
    process.stderr.write("Stopping admission; running attempts finish, then the sweep runs\n");
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const cached = new Map<string, Promise<Uint8Array>>();

  const read = (hash: string) => {
    let pending = cached.get(hash);

    if (!pending) {
      pending = readArtifact(cache, hash);
      cached.set(hash, pending);
    }

    return pending;
  };

  // Every ID as it is created, in memory too: the sweep must not depend on the journal write.
  const live = new Map<string, Set<string>>();
  // Unknown creates and finished attempts, in memory for the same reason.
  const unknownLive = new Map<string, string>();
  const done = new Set<string>();
  // Cleanups of creates that answered after their attempt returned: awaited before the end.
  const lateCleanups = new Set<Promise<void>>();
  // Attempts whose Compose project may still run on a daemon that outlives the sandbox.
  const projectsOpen = new Set<string>();

  // An attempt whose sandbox may still exist (a create with an unknown outcome, or a deletion that
  // was not confirmed) holds admission for the whole run while it is reconciled, so no provider
  // starts an attempt on top of spend the guard cannot see. True once every such attempt was
  // proven gone; false keeps admission closed for the rest of the run.
  let hold: Promise<boolean> = Promise.resolve(true);

  const reconcile = async (entry: SlotProvider, record: AttemptRecord): Promise<boolean> => {
    // A create with no ID can never be proven absent, so it never clears the hold. Its provider runs
    // nothing else now, so its label is listed and whatever carries it deleted at once, then again
    // once the visibility window has passed, without waiting for the other workers.
    if (record.sandboxIds.length === 0) {
      for (const discovery of ["immediate", "after-window"] as const) {
        if (discovery === "after-window")
          await new Promise((resolve) => setTimeout(resolve, visibilityWindowMs));

        const swept = await sweepRun({
          label: info.ownerLabel,
          entries: [entry],
          note,
          out,
          known: new Map(),
        });

        await note({
          kind: "unknown-create-discovery",
          provider: entry.name,
          attemptId: record.attemptId,
          discovery,
          ...swept,
        });
      }

      return false;
    }

    const swept = await sweepRun({
      label: info.ownerLabel,
      entries: [entry],
      note,
      out,
      known: new Map([[entry.name, new Set(record.sandboxIds)]]),
    });

    await note({
      kind: "reconciled",
      provider: entry.name,
      attemptId: record.attemptId,
      ...swept,
    }).catch(() => {});

    return !swept.failed && !swept.undeleted && !swept.unchecked;
  };

  const runProvider = async ({ setup, entry }: (typeof entries)[number]) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Alternate the path order so neither path always runs first on a provider.
      const order: ServicePath[] = attempt % 2 === 1 ? [...paths] : [...paths].reverse();

      for (const path of order) {
        if (!(await hold)) stopping = true;

        if (stopping) return;

        // Reserved through the attempt's own timeout and its destroy window.
        const reservation = guard.reserve(
          entry.name,
          attemptBudget(setup, track, timeoutMs + billablePastTimeoutMs),
        );

        if (!reservation) {
          await note({
            kind: "budget-stop",
            provider: entry.name,
            attempt,
            path,
            ...guard.state(),
          });
          process.stderr.write(`${entry.name}: stopped at attempt ${attempt} ${path}: budget\n`);

          return;
        }

        const attemptId = `${entry.name}-${path}-${attempt}`;

        const record = await runServicesAttempt(
          {
            runId,
            ownerLabel: info.ownerLabel,
            attemptId,
            attempt,
            path,
            track,
            entry,
            artifacts,
            timeoutMs,
            daemonReadyMs,
          },
          {
            read,
            onLateCleanup: (work) => {
              const tracked = work.catch(() => {}).finally(() => lateCleanups.delete(tracked));
              lateCleanups.add(tracked);
            },
            onSubmit: (provider, id) =>
              appendFile(
                join(out, submissionsFile),
                `${JSON.stringify({ provider, attemptId: id, at: new Date().toISOString() })}\n`,
              ),
            onNotSent: (provider, id) =>
              appendFile(
                join(out, submissionsFile),
                `${JSON.stringify({ provider, attemptId: id, sent: false, at: new Date().toISOString() })}\n`,
              ),
            onProject: (event) =>
              appendFile(
                join(out, projectsFile),
                `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`,
              ),
            onSandbox: async (provider, id) => {
              live.set(provider, (live.get(provider) ?? new Set()).add(id));
              await appendFile(
                join(out, ownedFile),
                `${JSON.stringify({ provider, id, attemptId, at: new Date().toISOString() })}\n`,
              );
            },
            estimate: (ms) => attemptBudget(setup, track, ms),
            outputDir: join(out, "outputs"),
            destroyTimeoutMs: destroyWindowMs,
          },
        );

        done.add(attemptId);

        // The project's obligation is its own: whatever happens to the sandbox below, no sandbox
        // reconciliation or sweep resolves it.
        if (projectOpen(record)) {
          projectsOpen.add(attemptId);
          await note({
            kind: "project-open",
            provider: entry.name,
            attemptId,
            project: record.daemon?.project ?? null,
            method: record.daemon?.method ?? null,
          });
        }

        // A sandbox that may still be running keeps its whole reservation and this provider takes
        // no more attempts. Admission closes for every provider until it is reconciled, right now;
        // the sweeps at the end retry anything left.
        if (!record.deletionConfirmed) {
          if (record.sandboxIds.length === 0) unknownLive.set(attemptId, entry.name);

          const held = Promise.all([hold, reconcile(entry, record)]).then(
            ([before, cleared]) => before && cleared,
          );

          hold = held;
          await note({
            kind: "deletion-unconfirmed",
            provider: entry.name,
            attemptId,
            ids: record.sandboxIds,
          });
          await appendFile(join(out, recordsFile), `${JSON.stringify(record)}\n`);

          if (await held)
            process.stderr.write(
              `${attemptId}: deletion unconfirmed, then reconciled; ${entry.name} stops, the others go on\n`,
            );
          else {
            stopping = true;
            process.stderr.write(
              `${attemptId}: deletion unconfirmed and not reconciled; admission stops for the whole run\n`,
            );
          }

          return;
        }

        guard.settle(reservation, record.estimatedUSD);
        await appendFile(join(out, recordsFile), `${JSON.stringify(record)}\n`);

        const o = record.outcome;
        process.stdout.write(
          `${attemptId}: ${o.kind === "green" ? `green, services up ${((record.metrics.servicesUpMs ?? 0) / 1000).toFixed(1)} s, ${record.daemon?.method ?? "native"}` : o.kind === "unsupported" ? `unsupported: ${o.reason}` : `failed at ${o.stage}: ${o.reason}`}; cleanup ${record.cleanup}\n`,
        );
      }
    }
  };

  const queue = [...entries];
  let disposition: "complete" | "stopped" | "failed" = "failed";

  try {
    // A worker that fails stops admission everywhere; the others finish their attempt, and the
    // sweep below runs whatever happened.
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let next = queue.shift(); next && !stopping; next = queue.shift())
          await runProvider(next).catch(async (error: Error) => {
            stopping = true;
            await note({
              kind: "worker-error",
              provider: next?.entry.name ?? "?",
              error: error.message,
            }).catch(() => {});
            throw error;
          });
      }),
    );

    const failed = results.some((r) => r.status === "rejected");

    if (failed) process.exitCode = 1;

    const planned = entries.flatMap(({ entry }) =>
      paths.flatMap((path) =>
        Array.from({ length: attempts }, (_, i) => `${entry.name}-${path}-${i + 1}`),
      ),
    );

    disposition = failed
      ? "failed"
      : !stopping && planned.every((id) => done.has(id))
        ? "complete"
        : "stopped";
  } finally {
    const { known, unresolved, unreadable, unreadableFiles } = await unconfirmedOwned(
      out,
      live,
      unknownLive,
      done,
    );

    // Recovery read less than the journals hold: the sweeps still run by label and every known ID,
    // but the run cannot claim nothing is left.
    if (unreadable || unreadableFiles.length) {
      await note({ kind: "journal-unreadable", lines: unreadable, files: unreadableFiles }).catch(
        () => {},
      );
      process.stderr.write(
        `Recovery could not read every journal entry (${unreadable} lines; files: ${unreadableFiles.join("; ") || "none"}); recovery is unchecked\n`,
      );
      process.exitCode = 1;
    }

    const sweepInput = {
      label: info.ownerLabel,
      entries: entries.map((e) => e.entry),
      note,
      out,
      known,
    };

    let swept = await sweepRun(sweepInput);
    const unknownCreates = [...unresolved.values()].reduce((a, b) => a + b, 0);

    // A create with an unknown outcome may surface in a listing only later: sweep again after a
    // bounded wait, and still report it, because no listing can prove it never existed.
    if (unknownCreates) {
      await new Promise((resolve) => setTimeout(resolve, visibilityWindowMs));
      // Refreshed: an ID learned after the first sweep (a late create error) is deleted too.
      const refreshed = await unconfirmedOwned(out, live, unknownLive, done);
      swept = await sweepRun({ ...sweepInput, known: refreshed.known });
      await note({ kind: "unresolved-creates", byProvider: Object.fromEntries(unresolved) }).catch(
        () => {},
      );
      process.stderr.write(
        `${unknownCreates} creates had an unknown outcome and no ID (${[...unresolved].map(([p, n]) => `${p} ${n}`).join(", ")}); swept twice ${visibilityWindowMs / 1000} s apart. Check those accounts.\n`,
      );
      process.exitCode = 1;
    }

    // Late cleanups already under way finish first, within one destroy window.
    if (lateCleanups.size)
      await Promise.race([
        Promise.all(lateCleanups),
        new Promise((resolve) => setTimeout(resolve, destroyWindowMs)),
      ]);

    // Drain: IDs learned while the sweeps ran (a create that answered late) are deleted by ID,
    // a bounded number of times, before anything is reported.
    const attempted = new Map([...known].map(([p, ids]) => [p, new Set(ids)]));

    for (let round = 0; round < 3; round++) {
      const latest = await unconfirmedOwned(out, live, unknownLive, done);
      const fresh = new Map<string, Set<string>>();

      for (const [provider, ids] of latest.known)
        for (const id of ids)
          if (!attempted.get(provider)?.has(id)) {
            fresh.set(provider, (fresh.get(provider) ?? new Set()).add(id));
            attempted.set(provider, (attempted.get(provider) ?? new Set()).add(id));
          }

      if (!fresh.size) break;
      const more = await sweepRun({ ...sweepInput, known: fresh });
      swept = {
        unchecked: Math.max(swept.unchecked, more.unchecked),
        failed: swept.failed + more.failed,
        undeleted: swept.undeleted + more.undeleted,
      };
    }

    await writeFile(
      join(out, "run.json"),
      `${JSON.stringify({ ...info, providers: entries.map((e) => e.entry.name), endedAt: new Date().toISOString(), disposition }, null, 2)}\n`,
    );
    const spend = guard.state();
    process.stdout.write(
      `Estimated spend $${(spend.spentUSD + spend.reservedUSD).toFixed(3)} (list price, unconfirmed deletions at their full reservation); reports in ${out}\n`,
    );

    if (swept.failed || swept.undeleted || swept.unchecked) {
      process.stderr.write(`Sweep left work: ${JSON.stringify(swept)}; see ${notesPath}\n`);
      process.exitCode = 1;
    }

    const journaled = await unconfirmedOwned(out, live, unknownLive, done);
    // A claim on a daemon launched inside its sandbox is resolved only by a sweep that left nothing.
    const clean = !swept.failed && !swept.undeleted && !swept.unchecked;

    failOnOpenProjects(
      [
        ...new Set([
          ...projectsOpen,
          ...journaled.openProjects,
          ...(clean ? [] : journaled.launchedProjects),
        ]),
      ],
      notesPath,
    );
  }
}

/**
 * Compose projects that may still run on a daemon that outlived its sandbox: no sweep can remove
 * them, so they are named and the command fails, every time, until someone removes them by hand.
 */
function failOnOpenProjects(attemptIds: readonly string[], notesPath: string) {
  if (!attemptIds.length) return;

  process.stderr.write(
    `Compose project cleanup unresolved for ${attemptIds.join(", ")}: each project may still run on a daemon that outlived its sandbox (projectCleanup: open); see ${notesPath}\n`,
  );
  process.exitCode = 1;
}

async function summary(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string", multiple: true },
      to: { type: "string" },
      /** Publish runs that did not complete, listing every planned attempt without a result. */
      partial: { type: "boolean", default: false },
    },
  });

  if (!values.out?.length) throw new Error("services summary needs --out DIR (repeatable)");
  const dirs = [...new Set(values.out.map((dir) => resolve(dir)))];

  if (dirs.length !== values.out.length)
    throw new Error("services summary got the same --out twice");
  const runs: RunInfo[] = [];
  const records: AttemptRecord[] = [];
  const notRun: NotRun[] = [];

  const missing: Missing[] = [];
  const incomplete: string[] = [];

  for (const dir of dirs) {
    const run = runFileSchema.parse(JSON.parse(await readFile(join(dir, "run.json"), "utf8")));
    const rows = await readRecords(join(dir, recordsFile));
    runs.push(run);
    records.push(...rows);
    notRun.push(...(await readNotRun(dir, run.id)));

    // Every planned attempt needs a result: a run cut short publishes a smaller sample.
    const have = new Set(rows.map((r) => r.attemptId));

    const absent = (run.providers ?? []).flatMap((provider) =>
      (run.plan?.paths ?? []).flatMap((path) =>
        Array.from({ length: run.plan?.attempts ?? 0 }, (_, i) => ({
          runId: run.id,
          provider,
          path,
          attempt: i + 1,
        })).filter((m) => !have.has(`${provider}-${path}-${m.attempt}`)),
      ),
    );

    missing.push(...absent);

    if (run.disposition !== "complete" || run.plan === null || absent.length)
      incomplete.push(
        `${run.id} (disposition ${run.disposition}${run.plan === null ? ", no attempt plan recorded" : ""}${absent.length ? `, ${absent.length} planned attempts without a result` : ""})`,
      );
  }

  if (incomplete.length && !values.partial)
    throw new Error(
      `Not every run completed: ${incomplete.join("; ")}. Rerun them, or pass --partial to publish what ran and list what did not.`,
    );

  const site = servicesSiteData({
    records,
    runs,
    notRun,
    partial: values.partial ? { incomplete, missing } : undefined,
  });

  const first = dirs[0] ?? ".";
  const to = resolve(values.to ?? join(first, "services.json"));
  await writeFile(to, `${JSON.stringify(site, null, 2)}\n`);
  await writeFile(join(first, "summary.md"), summaryMarkdown(site));
  process.stdout.write(`Wrote ${to}\n`);
  process.stdout.write(summaryMarkdown(site));
}

async function sweep(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string" },
      run: { type: "string" },
      providers: { type: "string" },
      track: { type: "string", default: "same-machine" },
    },
  });

  if (!values.out || !values.run) throw new Error("services sweep needs --out and --run");
  const out = resolve(values.out);
  const runFile = runFileSchema.parse(JSON.parse(await readFile(join(out, "run.json"), "utf8")));

  // The folder's journal and the label must belong to the same collection.
  if (runFile.id !== values.run)
    throw new Error(`${out} holds run ${runFile.id}, not ${values.run}; refusing to sweep`);

  // A folder from before unique labels shares its label with any run that reused the name.
  if (!runFile.ownerLabel)
    throw new Error(
      `${out} predates unique ownership labels; its label ${runFile.id} may be shared, so it is not swept by label. Delete its journaled IDs (owned.jsonl) by hand.`,
    );
  const label = runFile.ownerLabel;
  const track = z.enum(tracks).parse(values.track);
  const notesPath = join(out, "notes.jsonl");
  const note = bestEffortNotes(notesPath);

  const { known, unresolved, unreadable, unreadableFiles, openProjects, launchedProjects } =
    await unconfirmedOwned(out);

  for (const error of unreadableFiles) await note({ kind: "journal-unreadable", error });

  const names = values.providers
    ? list(values.providers)
    : (runFile.providers ?? providerSetups.map((s) => s.name));

  const entries: SlotProvider[] = [];
  let unreachable = 0;
  const extra = runFile.settings.modal === "runtime=vm" ? { runtime: "vm" } : undefined;

  for (const name of names) {
    let reason: string;

    try {
      const loaded = await loadSlotProvider(
        providerSetup(name),
        track,
        0,
        undefined,
        out,
        undefined,
        name === "modal" ? extra : undefined,
      );

      if (loaded.kind === "ready") {
        entries.push(loaded.entry);
        continue;
      }

      reason = loaded.note;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }

    // A provider the run used that this process cannot reach is unchecked work, never dropped.
    const admitted = runFile.providers?.includes(name) ?? false;
    const outstanding = (known.get(name)?.size ?? 0) + (unresolved.get(name) ?? 0);

    if (admitted || outstanding) {
      unreachable++;
      await note({
        kind: "sweep-unreachable",
        provider: name,
        reason,
        ids: [...(known.get(name) ?? [])],
      });
    }
  }

  // Outstanding work on a provider --providers left out is unchecked, never silently skipped.
  for (const provider of new Set([...known.keys(), ...unresolved.keys()]))
    if (!names.includes(provider)) {
      unreachable++;
      await note({ kind: "sweep-excluded", provider, ids: [...(known.get(provider) ?? [])] });
    }

  const swept = await sweepRun({ label, entries, note, out, known });
  const unknownCreates = [...unresolved.values()].reduce((a, b) => a + b, 0);
  const unchecked = swept.unchecked + unreachable + unreadable + unreadableFiles.length;
  // A claim on a daemon launched inside its sandbox is resolved only by a sweep that left nothing.
  const clean = !swept.failed && !swept.undeleted && !unchecked;
  const open = [...new Set([...openProjects, ...(clean ? [] : launchedProjects)])];

  process.stdout.write(
    `Swept ${entries.length} providers: ${JSON.stringify({ ...swept, unreachable, unreadableJournalLines: unreadable, unreadableJournals: unreadableFiles.length, unresolvedCreates: unknownCreates, openProjects: open.length })}; see ${notesPath}\n`,
  );

  if (swept.failed || swept.undeleted || unchecked || unknownCreates) process.exitCode = 1;
  failOnOpenProjects(open, notesPath);
}

export async function servicesCommand(args: string[]) {
  const [command, ...rest] = args;

  switch (command) {
    case "prepare": {
      const { values } = parseArgs({
        args: rest,
        options: { cache: { type: "string", default: defaultCacheDir } },
      });

      const artifacts = await prepareArtifacts(resolve(values.cache));
      process.stdout.write(`${JSON.stringify(artifacts, null, 2)}\n`);

      return;
    }

    case "run":
      return run(rest);
    case "summary":
      return summary(rest);
    case "sweep":
      return sweep(rest);
    default:
      process.stdout.write(
        "bun bench services prepare [--cache DIR]\n" +
          "bun bench services run --providers a,b --run ID --out DIR [--paths compose,native] [--attempts 3] [--track same-machine|default] [--max-dollars 15] [--provider-max-dollars a=2] [--attempt-timeout-ms 1500000] [--daemon-ready-ms 45000] [--concurrency 4] [--location TEXT] [--modal-runtime gvisor|vm] [--cache DIR]\n" +
          "bun bench services summary --out DIR [--out DIR2] [--to services.json]\n" +
          "bun bench services sweep --out DIR --run ID [--providers a,b]\n",
      );
  }
}
