/**
 * `bun bench realistic burst`: "Real tasks at once" (burst.ts) on real providers.
 *
 * Each provider gets `--rounds` rounds of `--size` Fix and test tasks started together on the
 * same-machine track, with the setup the headline runs use (setup.ts, loadSlotProvider). Providers
 * run `--parallel` at a time; two on one account never overlap. With `--control`, each burst round
 * is preceded by a control round of 1 task alone, so the slowdown divides by a solo time measured in
 * the same hour instead of the published solo median. Output in `--out`:
 *
 *   run.json         the run's identity (commit, times, location, size, rounds)
 *   attempts.jsonl   one attempt record per task, as the headline writes them (variant "concurrent")
 *   rounds.jsonl     per round: release and all-done times, listings before and after, leftovers;
 *                    and one line per provider not run, with the reason
 *   notes.jsonl      sandboxes as they are created, budget and sweep notes
 *   realtask-burst.json, summary.md   the site data file and a table (also `burst-summary`)
 *
 * Timing only: no billing windows and no costs. Spend is estimated at list price to keep the run
 * under `--budget-usd`.
 */
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { isMissingFile } from "../files.js";
import { sanitize } from "../v2-runner.js";
import { appJournalFile, stopJournalFile } from "./apps.js";
import {
  accountRefusal,
  allocationUnknown,
  billableLifetimeMs,
  isAccountLimit,
  roundRoleSchema,
  roundSpend,
  runPool,
  runRound,
  spendGuard,
  storedRecordSchema,
  summarizeProvider,
  uploadSeconds,
  within,
  type Leftover,
  type ProviderBurst,
  type RoundReport,
  type RoundRole,
  type RoundTask,
  type StoredRecord,
} from "./burst.js";
import {
  artifactPaths,
  attemptBudget,
  defaultArtifactDirs,
  defaultManifest,
  loadSlotProvider,
  regionsFile,
  sweepProviders,
  type RunNote,
} from "./cli.js";
import { harnessManifestFromFrozen } from "./frozen.js";
import { systemClock } from "./gaps.js";
import type { HarnessManifest } from "./manifest.js";
import { fileArtifacts, type ArtifactSource } from "./prepare.js";
import { providerRegion } from "../providers.js";
import { providerSetup, provisionedFor, provisionedOf, type ProviderSetup } from "./setup.js";
import type { SlotProvider } from "./slots.js";
import { sha256Hex } from "./steps.js";

const defaultSolo =
  "/home/leo/.t3/worktrees/sandbox-bench/15c0f164-c252cad79f79cc43/src/data/realistic.json";

const allProviders = [
  "boat",
  "boxd",
  "daytona",
  "e2b",
  "freestyle",
  "superserve",
  "tenki",
  "upstash",
  "upstash-ephemeral",
  "vercel",
  "modal",
  "baseten",
  "instabox",
  "beam",
];

const listingSchema = z.object({
  at: z.number(),
  ids: z.array(z.string()).readonly().nullable(),
  runIds: z.array(z.string()).readonly().nullable(),
  error: z.string().nullable(),
});

const roundLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("round"),
    provider: z.string(),
    /** Counted within the role. Files from before control rounds existed hold burst rounds only. */
    round: z.number().int(),
    role: roundRoleSchema.default("burst"),
    size: z.number().int(),
    startedAt: z.number(),
    /** null when a sandbox of the round was left unresolved; always a number in older files. */
    allDoneAt: z.number().nullable(),
    /** Tasks the provider admitted; absent in older files, where it is counted from the records. */
    admitted: z.number().int().nonnegative().optional(),
    /** Attempt IDs whose sandbox may still exist after the round's cleanup. */
    unresolved: z.array(z.string()).default([]),
    before: listingSchema,
    after: listingSchema,
    ownBefore: z.array(z.string()).readonly(),
    leftovers: z
      .array(
        z.object({
          id: z.string(),
          destroyed: z.boolean(),
          goneAfter: z.boolean(),
          confirmedAt: z.number().nullable().default(null),
        }),
      )
      .readonly(),
    attemptIds: z.array(z.string()),
  }),
  z.object({ kind: z.literal("not-run"), provider: z.string(), reason: z.string() }),
  /** A scheduled round that did not run (the spend ceiling, an earlier round's failure). */
  z.object({
    kind: z.literal("skipped"),
    provider: z.string(),
    role: roundRoleSchema,
    round: z.number().int(),
    reason: z.string(),
  }),
  /**
   * A round that threw before it finished (a record write, the runner). Some of its records may be
   * written; the export leaves them out of every count and publishes the reason.
   */
  z.object({
    kind: z.literal("failed"),
    provider: z.string(),
    role: roundRoleSchema,
    round: z.number().int(),
    reason: z.string(),
  }),
]);

type RoundLine = z.infer<typeof roundLineSchema>;

/** A rounds.jsonl line as written; defaults fill in when it is read. */
export type RoundLineInput = z.input<typeof roundLineSchema>;

/** How providers were scheduled: one at a time, or several at once (`--parallel` above 1). */
const runModeSchema = z.enum(["one-provider-at-a-time", "parallel"]);

const runInfoSchema = z.object({
  id: z.string(),
  sdkCommit: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  location: z.string(),
  size: z.number().int(),
  rounds: z.number().int(),
  track: z.literal("same-machine"),
  profile: z.literal("fix-and-test"),
  providers: z.array(z.string()),
  budgetUSD: z.number(),
  /** Run folders from before this field ran 3 providers at once. */
  mode: runModeSchema.default("parallel"),
  /** Whether each burst round was preceded by a 1-task control round. */
  control: z.boolean().default(false),
  /**
   * Providers with no provider-enforced lifetime, for which the budget was advisory rather than a
   * hard cap. Absent in older runs.
   */
  budgetAdvisoryFor: z.array(z.string()).optional(),
});

type RunInfo = z.infer<typeof runInfoSchema>;

/** The site's realistic data file: only the fields read here. */
const soloFileSchema = z.object({
  rows: z.array(
    z.looseObject({
      provider: z.string(),
      profile: z.string(),
      track: z.string(),
      variant: z.string(),
      medianWallS: z.number().nullable(),
    }),
  ),
});

/** Each provider's published solo median for same-machine Fix and test. */
export async function soloMedians(path: string): Promise<Map<string, number | null>> {
  const file = soloFileSchema.parse(JSON.parse(await readFile(path, "utf8")));

  return new Map(
    file.rows
      .filter(
        (r) =>
          r.variant === "headline" && r.track === "same-machine" && r.profile === "fix-and-test",
      )
      .map((r) => [r.provider, r.medianWallS]),
  );
}

async function readLines<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
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

const positiveInt = (name: string, value: string) => {
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

/** Files a burst run writes into its `--out` folder. A folder holding any of them is a used one. */
const runArtifacts = [
  "run.json",
  "attempts.jsonl",
  "rounds.jsonl",
  "notes.jsonl",
  appJournalFile,
  stopJournalFile,
  "realtask-burst.json",
];

/**
 * Refuses an `--out` folder that already holds a run: attempts and rounds are appended while
 * run.json is replaced, so a second run there would mix with the first. Separate runs go in
 * separate folders and are merged with burst-summary. This check fails fast, before artifacts are
 * read; `claimOutput` is what settles a race between two runs.
 */
export async function assertFreshOutput(out: string): Promise<void> {
  let names: string[];

  try {
    names = await readdir(out);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  const present = runArtifacts.filter((name) => names.includes(name));

  if (present.length)
    throw new Error(
      `${out} already holds a run (${present.join(", ")}); give each run its own --out folder and merge folders with burst-summary`,
    );
}

/**
 * Claims `out` for one run by creating its run.json exclusively: of two runs that both passed
 * `assertFreshOutput`, only one creates the file and the other stops before writing anything.
 */
export async function claimOutput(out: string, info: RunInfo): Promise<void> {
  await mkdir(out, { recursive: true });

  try {
    await writeFile(join(out, "run.json"), JSON.stringify(info, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(
        `${out} already holds a run (run.json was created by another run); give each run its own --out folder`,
      );
    throw error;
  }
}

/**
 * The lines for a provider that runs none of its schedule: every scheduled burst round as skipped,
 * then the reason it was not run.
 */
export function notRunLines({
  provider,
  schedule,
  reason,
}: {
  provider: string;
  schedule: readonly ScheduledRound[];
  reason: string;
}): RoundLineInput[] {
  const clean = sanitize(reason);

  return [
    ...skippedLines({ provider, steps: schedule, reason: clean }),
    { kind: "not-run", provider, reason: clean },
  ];
}

function skippedLines({
  provider,
  steps,
  reason,
}: {
  provider: string;
  steps: readonly ScheduledRound[];
  reason: string;
}): RoundLineInput[] {
  return steps.flatMap((step): RoundLineInput[] =>
    step.role === "burst"
      ? [{ kind: "skipped", provider, role: step.role, round: step.round, reason }]
      : [],
  );
}

/** Every artifact a profile's tasks read, by sha256, with a name for messages. */
export function requiredArtifacts(
  manifest: HarnessManifest,
  profileName: string,
): Map<string, string> {
  const profile = manifest.profiles[profileName];

  if (!profile) throw new Error(`The manifest has no ${profileName} profile`);
  const toolchain = manifest.toolchains[profile.toolchain.node];

  if (!toolchain) throw new Error(`The manifest has no ${profile.toolchain.node} toolchain`);
  const required = new Map<string, string>();

  // The sandbox's architecture is known only once it exists, so every architecture is required.
  for (const [arch, artifact] of Object.entries(toolchain.tarballs))
    if (artifact) required.set(artifact.sha256, `${profile.toolchain.node} toolchain (${arch})`);

  for (const [arch, artifact] of Object.entries(profile.dependencyCache?.archives ?? {}))
    if (artifact) required.set(artifact.sha256, `${profileName} dependency cache (${arch})`);

  for (const [name, patch] of Object.entries(profile.patches))
    required.set(patch.sha256, `${profileName} patch ${name}`);

  for (const step of profile.steps)
    if (step.op.kind === "write") required.set(step.op.blob, `${profileName} step ${step.id} blob`);

  return required;
}

/**
 * Reads and hash-checks every required artifact before any round, so no task's timed upload
 * includes reading local files, and a missing or corrupt file stops the run before anything is
 * created instead of failing tasks as if the provider had.
 */
export async function preloadArtifacts({
  required,
  found,
}: {
  required: ReadonlyMap<string, string>;
  found: ReadonlyMap<string, string>;
}): Promise<ArtifactSource> {
  const missing = [...required].flatMap(([sha, name]) => (found.has(sha) ? [] : [name]));

  if (missing.length) throw new Error(`Local artifacts missing: ${missing.join(", ")}`);
  const files = fileArtifacts(found);
  const loaded = new Map<string, Uint8Array>();

  for (const sha of required.keys()) loaded.set(sha, await files.read(sha));

  return {
    read: async (sha) => {
      const data = loaded.get(sha);

      if (!data) throw new Error(`Artifact ${sha} was not preloaded`);

      return data;
    },
  };
}

export type SpendGuard = ReturnType<typeof spendGuard>;

/** One provider's rounds, with everything that touches a provider or a file passed in. */
export interface ProviderRounds {
  readonly name: string;
  readonly schedule: readonly ScheduledRound[];
  readonly guard: SpendGuard;
  /** What one task reserves: list price through its billable lifetime. */
  readonly perTaskUSD: number;
  /**
   * The lifetime the provider enforces on each sandbox (the setup's `lifetime`); null when it
   * enforces none, so a sandbox the cleanup could not resolve may bill without end.
   */
  readonly hardLifetimeMs: number | null;
  /** A task's list price for `ms` of its sandbox. */
  price(record: StoredRecord, ms: number): number;
  runRound(step: ScheduledRound, batch: number): Promise<RoundReport>;
  writeRound(line: RoundLineInput): Promise<void>;
  notRun(reason: string): Promise<void>;
  note(entry: RunNote): Promise<void>;
  say(text: string): void;
  /** How long to wait while other providers' rounds hold the reservation. */
  sleep(ms: number): Promise<void>;
}

/**
 * Runs a provider's schedule under the spend guard. A round reserves every task's billable lifetime
 * and settles to its estimate, keeping the share of any task whose sandbox is unresolved; a round
 * that throws keeps its whole reservation and is marked failed. A round that leaves a sandbox
 * unresolved on a provider with no hard lifetime stops the guard, so no further round starts on any
 * provider. Burst rounds that do not run are written as skipped, and a provider whose first burst
 * round never ran is not run, whatever control ran.
 */
export async function runProviderRounds(run: ProviderRounds): Promise<void> {
  const { name, guard } = run;
  let burstRan = false;

  const skipRest = async (from: number, reason: string) => {
    for (const line of skippedLines({
      provider: name,
      steps: run.schedule.slice(from),
      reason: sanitize(reason),
    }))
      await run.writeRound(line);
  };

  /**
   * A sandbox with no bound on its spend may still exist: nothing more may start, on any provider.
   * Synchronous, so it takes effect before any file write that could fail; returns the note to
   * write, or null on a provider with a hard lifetime.
   */
  const unbounded = (label: string): RunNote | null => {
    if (run.hardLifetimeMs !== null) return null;
    const reason = `${name} ${label} may have left a sandbox running, and ${name} has no hard lifetime`;

    guard.stop(reason);

    return { kind: "budget-stop", provider: name, reason: sanitize(reason) };
  };

  for (const [index, step] of run.schedule.entries()) {
    const { role, round } = step;
    const label = role === "control" ? `control round ${round}` : `round ${round}`;
    const reserve = step.size * run.perTaskUSD;
    const stopped = guard.stopped();

    if (stopped !== null) {
      const reason = `spend guard stopped: ${stopped}`;

      await skipRest(index, reason);

      if (!burstRan) await run.notRun(reason);
      else run.say(`${name}: ${label} skipped: ${stopped}`);

      return;
    }

    // Other providers' rounds in flight may hold the reservation: wait for them to settle.
    let reserved = guard.reserve(reserve);

    while (!reserved && guard.couldFit(reserve)) {
      await run.sleep(5_000);
      reserved = guard.reserve(reserve);
    }

    if (!reserved) {
      const state = guard.state();
      await run.note({ kind: "budget-stop", provider: name, round, role, ...state, reserve });

      const reason = `spend ceiling: $${state.spentUSD.toFixed(2)} spent and $${state.reservedUSD.toFixed(2)} reserved, a round reserves $${reserve.toFixed(2)}, ceiling $${state.capUSD}`;

      await skipRest(index, reason);

      if (!burstRan) await run.notRun(reason);
      else run.say(`${name}: ${label} skipped at the spend ceiling`);

      return;
    }

    run.say(`${name}: ${label}, ${step.size} task${step.size === 1 ? "" : "s"}`);
    let report: RoundReport;

    try {
      report = await run.runRound(step, index + 1);
    } catch (error) {
      // Its sandboxes may have run, and some may still exist: it keeps its whole reservation, and
      // the guard stops before any write below can fail (the round may have thrown on a full disk).
      guard.settle({ reservedUSD: reserve, spentUSD: reserve });
      const stop = unbounded(label);
      const text = sanitize(error instanceof Error ? error.message : String(error));

      await run.note({ kind: "round-error", provider: name, round, role, error: text });
      // Some of its records may be written: the marker keeps them out of the published counts.
      await run.writeRound({
        kind: "failed",
        provider: name,
        role,
        round,
        reason: `${label} failed before it finished: ${text}`,
      });

      if (stop) await run.note(stop);
      await skipRest(index + 1, `${label} failed before it finished`);
      run.say(`${name}: ${label} failed before its tasks finished; see notes`);

      return;
    }

    if (role === "burst") burstRan = true;

    guard.settle({
      reservedUSD: reserve,
      spentUSD: roundSpend({
        records: report.records,
        leftovers: report.leftovers,
        perTaskUSD: run.perTaskUSD,
        hardLifetimeMs: run.hardLifetimeMs,
        price: run.price,
      }),
    });

    const stop = report.unresolved.length ? unbounded(label) : null;

    await run.writeRound({
      kind: "round",
      provider: name,
      round,
      role,
      size: step.size,
      startedAt: report.startedAt,
      allDoneAt: report.allDoneAt,
      admitted: report.admitted,
      unresolved: [...report.unresolved],
      before: report.before,
      after: report.after,
      ownBefore: report.ownBefore,
      leftovers: report.leftovers,
      attemptIds: report.records.map((r) => r.attemptId),
    });

    for (const record of report.records)
      run.say(
        `  ${name} ${record.slot.id}: ${record.burst.harness ? `our side: ${record.burst.harness.detail.slice(0, 160)}` : record.completion.kind === "completed" ? "completed" : `${record.completion.reason}: ${record.completion.detail.slice(0, 160)}`} (${Math.round((record.endedAt - record.startedAt) / 1000)} s, upload ${uploadSeconds(record)?.toFixed(1) ?? "n/a"} s)`,
      );

    const allDone =
      report.allDoneAt === null
        ? `not all done: ${report.unresolved.length} unresolved`
        : `all done in ${Math.round((report.allDoneAt - report.startedAt) / 1000)} s`;

    run.say(
      `${name}: ${label} ${allDone}; ${report.admitted}/${step.size} admitted; leftovers ${report.leftovers.length}; est. spent $${guard.state().spentUSD.toFixed(2)}`,
    );

    // A sandbox of this round may still be running. Even where the provider's lifetime bounds its
    // spend, a next round here would not run alone (a control) or at the requested size (a burst),
    // so this provider's schedule ends; without a lifetime the guard has stopped every provider.
    if (report.unresolved.length) {
      if (stop) await run.note(stop);
      const reason = `${label} left ${report.unresolved.length} sandbox(es) unresolved`;

      run.say(`${name}: ${reason}; no more rounds`);
      await skipRest(index + 1, reason);

      if (!burstRan) await run.notRun(reason);

      return;
    }

    // Every create refused by an account limit: another round would be refused too.
    if (report.records.length > 0 && report.records.every(isAccountLimit)) {
      const reason = `account limit: every create of ${label} was refused`;

      run.say(`${name}: every create was refused by an account limit; no more rounds`);
      await skipRest(index + 1, reason);

      if (!burstRan) await run.notRun(reason);

      return;
    }
  }
}

/**
 * Providers run at once: `--parallel` when given, else 1 with `--control` (a control round must run
 * alone, with no other provider's uploads on the host's network) and 3 without.
 */
export function parallelOf({
  parallel,
  control,
}: {
  parallel: string | undefined;
  control: boolean;
}): number {
  return positiveInt("parallel", parallel ?? (control ? "1" : "3"));
}

/**
 * Providers with no provider-enforced lifetime. A round's spend there is bounded only by its own
 * cleanup, so the budget is advisory for them, not a hard cap.
 */
export function budgetAdvisoryFor(setups: readonly Pick<ProviderSetup, "name" | "lifetime">[]) {
  return setups.flatMap((s) => (s.lifetime ? [] : [s.name]));
}

/** How long the final sweep may take on one provider; past it the run fails and says so. */
const sweepTimeoutMs = 15 * 60_000;

/** How long the final sweep waits for creates still in flight before it starts. */
const openCreateWaitMs = 150_000;

/**
 * The run's last cleanup. It first waits (bounded) for creates still in flight, so any sandbox they
 * name joins `owned` before anything is swept. Then each provider is swept on its own, all at once,
 * each under its own deadline, so one provider's slow deletions cannot use up another's time.
 * Records whose create may have allocated a sandbox no ID or label ties to the run (a lost reply on
 * a provider that labels after create, such as Boat) are named too: no sweep can clear them.
 * Returns what it could not clear; empty means clean.
 */
export async function finalSweep({
  runId,
  entries,
  note,
  out,
  owned,
  openCreates,
  namedLate = new Set<string>(),
  createWaitMs = openCreateWaitMs,
  providerDeadlineMs = sweepTimeoutMs,
  callTimeoutMs = 120_000,
}: {
  runId: string;
  entries: readonly SlotProvider[];
  note: (entry: RunNote) => Promise<void>;
  /** The run folder: its attempts.jsonl and journals. */
  out: string;
  owned: ReadonlyMap<string, ReadonlySet<string>>;
  openCreates: ReadonlySet<Promise<void>>;
  /** Attempts whose create named its sandbox after the record was written: owned and swept. */
  namedLate?: ReadonlySet<string>;
  createWaitMs?: number;
  providerDeadlineMs?: number;
  /** Bound on each provider call, as sweepProviders defaults it. */
  callTimeoutMs?: number;
}): Promise<string[]> {
  const problems: string[] = [];

  if (openCreates.size)
    await within(
      Promise.allSettled(openCreates).then(() => true),
      createWaitMs,
    );

  if (openCreates.size) {
    problems.push(
      `${openCreates.size} create(s) still had no answer after ${createWaitMs} ms; a sandbox they allocate is not swept`,
    );
    await note({ kind: "creates-open", count: openCreates.size, afterMs: createWaitMs }).catch(
      () => {},
    );
  }

  // Entries that share one adapter instance are swept together, as sweepProviders groups them.
  const groups = new Map<SlotProvider["provider"], SlotProvider[]>();

  for (const entry of entries)
    groups.set(entry.provider, [...(groups.get(entry.provider) ?? []), entry]);

  await Promise.all(
    [...groups.values()].map(async (group) => {
      const name = group.map((e) => e.name).join("+");

      const outcome = await within(
        sweepProviders(runId, group, note, out, {
          known: owned,
          callTimeoutMs,
        }).then(
          (result) => ({ kind: "swept", result }) as const,
          (error) =>
            ({
              kind: "threw",
              error: error instanceof Error ? error.message : String(error),
            }) as const,
        ),
        providerDeadlineMs,
      );

      if (outcome === null) {
        problems.push(`${name}: the sweep did not finish in ${providerDeadlineMs} ms`);
        await note({ kind: "sweep-timeout", provider: name, afterMs: providerDeadlineMs }).catch(
          () => {},
        );

        return;
      }

      if (outcome.kind === "threw") {
        problems.push(`${name}: the sweep threw: ${outcome.error}`);
        await note({ kind: "sweep-failed", provider: name, error: outcome.error }).catch(() => {});

        return;
      }

      const swept = outcome.result;

      await note({ kind: "sweep-result", provider: name, ...swept }).catch(() => {});

      if (swept.failed || swept.undeleted || swept.unchecked)
        problems.push(
          `${name}: the sweep left something (failed ${swept.failed}, undeleted ${swept.undeleted}, unchecked ${swept.unchecked})`,
        );
    }),
  );

  try {
    const unknown = (await readLines(join(out, "attempts.jsonl"), storedRecordSchema)).filter(
      (r) => r.runId === runId && allocationUnknown(r) && !namedLate.has(r.attemptId),
    );

    if (unknown.length) {
      problems.push(
        `${unknown.length} create(s) may have allocated a sandbox no ID or label ties to this run: ${unknown.map((r) => r.attemptId).join(", ")}`,
      );
      await note({
        kind: "unknown-allocations",
        attemptIds: unknown.map((r) => r.attemptId),
      }).catch(() => {});
    }
  } catch (error) {
    problems.push(
      `the attempt records could not be read for unknown allocations: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return problems;
}

export async function burstCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string", default: defaultManifest },
      out: { type: "string" },
      run: { type: "string" },
      providers: { type: "string" },
      tracks: { type: "string", default: "same-machine" },
      profile: { type: "string", default: "fix-and-test" },
      size: { type: "string", default: "5" },
      rounds: { type: "string", default: "2" },
      // Default 3, or 1 with --control: a control round must run alone, with no other provider's
      // uploads on the host's network. An explicit --parallel wins.
      parallel: { type: "string" },
      control: { type: "boolean", default: false },
      "budget-usd": { type: "string", default: "15" },
      solo: { type: "string", default: defaultSolo },
      location: { type: "string", default: "Boca Raton, FL (evo-1)" },
      "artifact-dir": { type: "string", multiple: true },
    },
  });

  if (!values.out || !values.run) throw new Error("realistic burst needs --out and --run");

  // The published comparison is same-machine Fix and test; nothing else is supported.
  if (values.tracks !== "same-machine")
    throw new Error("realistic burst runs the same-machine track only");

  if (values.profile !== "fix-and-test")
    throw new Error("realistic burst runs the fix-and-test profile only");
  const track = "same-machine" as const;
  const profileName = "fix-and-test" as const;
  const size = positiveInt("size", values.size);
  const rounds = positiveInt("rounds", values.rounds);
  const parallel = parallelOf({ parallel: values.parallel, control: values.control });
  const guard = spendGuard(Number(values["budget-usd"]));
  const runId = values.run;
  const out = resolve(values.out);

  // Before anything is written: a used folder is refused, and every artifact is read and checked.
  await assertFreshOutput(out);
  const frozenJson = await readFile(values.manifest, "utf8");
  const manifest = harnessManifestFromFrozen(frozenJson);
  const manifestSha256 = sha256Hex(frozenJson);
  const profile = manifest.profiles[profileName];

  if (!profile) throw new Error(`The manifest has no ${profileName} profile`);
  const slotMs = profile.slotTimeoutMs;

  const { found } = await artifactPaths(manifest, values["artifact-dir"] ?? defaultArtifactDirs);

  const source = await preloadArtifacts({
    required: requiredArtifacts(manifest, profileName),
    found,
  });

  const blobs = { get: (sha: string) => source.read(sha) };

  await mkdir(join(out, "outputs"), { recursive: true });
  const attemptsPath = join(out, "attempts.jsonl");
  const roundsPath = join(out, "rounds.jsonl");
  const notesPath = join(out, "notes.jsonl");

  const note = (entry: RunNote) =>
    appendFile(notesPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

  const writeRound = (line: RoundLineInput) =>
    appendFile(roundsPath, JSON.stringify(roundLineSchema.parse(line)) + "\n");

  const say = (text: string) =>
    process.stdout.write(`[${new Date().toISOString()}] ${sanitize(text)}\n`);

  const names = values.providers
    ? values.providers
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : allProviders;

  const setups = names.map(providerSetup);
  // A run with control rounds divides by its own; only a run without reads the published medians,
  // and reads them now so a missing file stops it before anything is created.
  const solo = values.control ? null : await soloMedians(values.solo);
  const soloPath = values.solo;
  const publishedSolo = async () => solo ?? soloMedians(soloPath);
  const advisory = budgetAdvisoryFor(setups);

  const info: RunInfo = {
    id: runId,
    sdkCommit: sdkCommit(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    location: values.location,
    size,
    rounds,
    track,
    profile: profileName,
    providers: names,
    budgetUSD: guard.state().capUSD,
    mode: parallel === 1 ? "one-provider-at-a-time" : "parallel",
    control: values.control,
    budgetAdvisoryFor: advisory,
  };

  await claimOutput(out, info);

  if (advisory.length)
    say(
      `Budget $${info.budgetUSD} is a hard cap only where the provider enforces a lifetime; for ${advisory.join(", ")} it is advisory: a round's spend there is bounded by its cleanup, not by the provider`,
    );

  const regions: Record<string, string | null> = {};

  for (const setup of setups) regions[setup.adapter] = providerRegion(setup.adapter, process.env);
  await writeFile(join(out, regionsFile), JSON.stringify(regions, null, 2) + "\n");

  const notRun = async (provider: string, reason: string) => {
    await writeRound({ kind: "not-run", provider, reason: sanitize(reason) });
    say(`${provider}: not run: ${reason}`);
  };

  const schedule = roundSchedule({ rounds, size, control: values.control });

  /** A provider stopped before any round: its whole schedule is skipped. */
  const notRunAtAll = async (provider: string, reason: string) => {
    for (const line of notRunLines({ provider, schedule, reason })) await writeRound(line);
    say(`${provider}: not run: ${reason}`);
  };

  const loaded: { setup: ProviderSetup; entry: SlotProvider }[] = [];

  for (const setup of setups) {
    const config = setup.tracks[track];
    const refusal = accountRefusal({ provider: setup.name, size, vcpu: config.vcpu });

    if (refusal) {
      await notRunAtAll(setup.name, refusal);
      continue;
    }

    const tooSmall = config.tooSmall[profileName];

    if (tooSmall) {
      await notRunAtAll(setup.name, tooSmall);
      continue;
    }

    // Fix and test has no profile factory (only Baseten's build does), so the plain adapter runs it.
    const result = await loadSlotProvider(setup, track, slotMs, join(out, "usage"), out);

    if (result.kind === "skipped")
      await notRunAtAll(setup.name, `adapter not loaded: ${result.note}`);
    else loaded.push({ setup, entry: result.entry });
  }

  // Every sandbox ID this run owns, per provider, live: the final sweep deletes these by ID even
  // when a listing fails or an attempt record was never written.
  const owned = new Map(loaded.map(({ setup }) => [setup.name, new Set<string>()]));
  // Creates still in flight, so the final sweep can wait for the sandboxes they name.
  const openCreates = new Set<Promise<void>>();
  // Attempts whose create named a sandbox after their record was written.
  const namedLate = new Set<string>();

  try {
    await runPool({
      items: loaded,
      parallel,
      account: ({ setup }) => setup.adapter,
      run: async ({ setup, entry }) => {
        const created = owned.get(setup.name) ?? new Set<string>();
        const provisioned = provisionedFor(setup, track, profileName);

        await runProviderRounds({
          name: setup.name,
          schedule,
          guard,
          perTaskUSD: attemptBudget(setup, track, billableLifetimeMs(slotMs), provisioned),
          hardLifetimeMs: setup.lifetime ? billableLifetimeMs(slotMs) : null,
          price: (record, ms) =>
            attemptBudget(setup, track, ms, provisionedOf(setup, track, record) ?? provisioned),
          runRound: (step, batch) =>
            runRound({
              runId,
              round: step.round,
              role: step.role,
              batch,
              size: step.size,
              manifest,
              manifestSha256,
              profileName,
              track,
              entry,
              clock: systemClock,
              blobs,
              prepare: { cacheBaseUrl: "sdk-upload", upload: { source } },
              outputDir: join(out, "outputs"),
              created,
              openCreates,
              namedLate,
              onRecord: (record) => appendFile(attemptsPath, JSON.stringify(record) + "\n"),
              onSandbox: (id) =>
                note({ kind: "sandbox", provider: setup.name, id, round: step.round }),
            }),
          writeRound,
          notRun: (reason) => notRun(setup.name, reason),
          note,
          say,
          sleep: (ms) => systemClock.sleep(ms),
        });
      },
    });
  } finally {
    // Always: nothing this run made is left running, whatever stopped it. Each provider is swept
    // on its own under its own deadline; whatever the sweep could not clear fails the run.
    const problems = await finalSweep({
      runId,
      entries: loaded.map((l) => l.entry),
      note,
      out,
      owned,
      openCreates,
      namedLate,
    });

    if (problems.length) {
      process.stderr.write(
        `The final sweep could not clear everything; see ${notesPath}\n${problems.map((p) => `  ${sanitize(p)}\n`).join("")}`,
      );
      process.exitCode = 1;
    }

    await writeFile(
      join(out, "run.json"),
      JSON.stringify({ ...info, endedAt: new Date().toISOString() }, null, 2) + "\n",
    );
    await note({ kind: "spend", ...guard.state() });
  }

  const data = await buildExport([out], publishedSolo);
  await writeFile(join(out, "realtask-burst.json"), JSON.stringify(data, null, 2) + "\n");
  await writeFile(join(out, "summary.md"), summaryMarkdown(data, guard.state().spentUSD));
  process.stdout.write(summaryMarkdown(data, guard.state().spentUSD));
}

/** One round in a provider's schedule. */
export interface ScheduledRound {
  readonly role: RoundRole;
  /** Counted within the role, from 1. */
  readonly round: number;
  readonly size: number;
}

/**
 * The order a provider's rounds run in: `rounds` burst rounds of `size`, each preceded by a 1-task
 * control round when `control` is set (control 1, burst 1, control 2, burst 2, ...).
 */
export function roundSchedule({
  rounds,
  size,
  control,
}: {
  rounds: number;
  size: number;
  control: boolean;
}): ScheduledRound[] {
  return Array.from({ length: rounds }, (_, i): ScheduledRound[] => {
    const burst: ScheduledRound = { role: "burst", round: i + 1, size };

    return control ? [{ role: "control", round: i + 1, size: 1 }, burst] : [burst];
  }).flat();
}

export interface BurstExport {
  readonly schema: 1;
  readonly generatedAt: string;
  readonly run: {
    readonly id: string;
    readonly mode: z.infer<typeof runModeSchema>;
    readonly sdkCommit: string;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly location: string;
  };
  readonly size: number;
  readonly rounds: number;
  readonly track: "same-machine";
  readonly profile: "fix-and-test";
  readonly providers: readonly ProviderBurst[];
}

/**
 * The site data file from one or more run folders. A provider in a later folder replaces the same
 * provider from an earlier one (a rerun), and every folder must share the run's size and rounds.
 * A folder run with `--control` divides by its own control tasks; one without divides by the
 * published solo median that `solo` reads, called only when such a folder is present.
 */
export async function buildExport(
  dirs: readonly string[],
  solo: () => Promise<ReadonlyMap<string, number | null>>,
): Promise<BurstExport> {
  const byProvider = new Map<
    string,
    { info: RunInfo; lines: RoundLine[]; records: StoredRecord[] }
  >();

  let first: RunInfo | null = null;

  for (const dir of dirs) {
    const info = runInfoSchema.parse(JSON.parse(await readFile(join(dir, "run.json"), "utf8")));

    if (first && (first.size !== info.size || first.rounds !== info.rounds))
      throw new Error(
        `${dir} ran ${info.size} x ${info.rounds}, not ${first.size} x ${first.rounds}`,
      );
    first ??= info;
    const lines = await readLines(join(dir, "rounds.jsonl"), roundLineSchema);

    const records = (await readLines(join(dir, "attempts.jsonl"), storedRecordSchema)).filter(
      (r) => r.runId === info.id,
    );

    // A provider whose only trace is its records (stopped before any round line) is kept too.
    for (const provider of new Set([...lines, ...records].map((l) => l.provider)))
      byProvider.set(provider, {
        info,
        lines: lines.filter((l) => l.provider === provider),
        records: records.filter((r) => r.provider === provider),
      });
  }

  if (!first) throw new Error("burst-summary needs at least one --out");

  const published = [...byProvider.values()].some((v) => !v.info.control)
    ? await solo()
    : new Map<string, number | null>();

  const order = [
    ...first.providers,
    ...[...byProvider.keys()].filter((p) => !first.providers.includes(p)),
  ];

  const providers = order.flatMap((provider): ProviderBurst[] => {
    const found = byProvider.get(provider);

    if (!found) return [];
    const notRunLine = found.lines.find((l) => l.kind === "not-run");
    const rounds = found.lines.flatMap((l) => (l.kind === "round" ? [l] : []));
    const burstRounds = rounds.filter((l) => l.role === "burst");

    const skipped = found.lines.flatMap((l) =>
      l.kind === "skipped" && l.role === "burst" ? [l.round] : [],
    );

    const failed = found.lines.flatMap((l) =>
      l.kind === "failed" ? [{ role: l.role, round: l.round, reason: l.reason }] : [],
    );

    const placed = new Map<
      string,
      { role: RoundRole; round: number; leftovers: readonly Leftover[] }
    >();

    for (const line of rounds)
      for (const id of line.attemptIds)
        placed.set(id, { role: line.role, round: line.round, leftovers: line.leftovers });

    // A round with tagged records but neither a round line nor a failed line stopped part way (the
    // process ended before writing either): it is reported, not silently left out.
    for (const record of found.records) {
      const at = record.burst;

      if (!at || placed.has(record.attemptId)) continue;

      if (failed.some((f) => f.role === at.role && f.round === at.round)) continue;
      failed.push({
        role: at.role,
        round: at.round,
        reason: "the round stopped before it finished, so its tasks are left out",
      });
    }

    // A tagged record counts only when a completed round line names it: a round that stopped
    // before its line (a crash, a failed write) never finished its cleanup, so how its sandboxes
    // ended is unknown. An older, untagged record is placed by the round line that names it, or,
    // with none, as a burst task of the round its batch says, as before control rounds existed.
    const tasks = (role: RoundRole): RoundTask[] =>
      found.records.flatMap((record) => {
        const line = placed.get(record.attemptId);

        if (record.burst && !line) return [];
        const at = record.burst ?? line ?? { role: "burst", round: record.batch };

        return at.role === role
          ? [{ round: at.round, record, leftovers: line?.leftovers ?? [] }]
          : [];
      });

    return [
      summarizeProvider({
        provider,
        tasks: tasks("burst"),
        rounds: burstRounds,
        skipped,
        failed,
        solo: found.info.control
          ? { kind: "same-day", tasks: tasks("control") }
          : { kind: "published", medianWallS: published.get(provider) ?? null },
        // A provider stopped before its first burst round is not run, whatever control ran.
        notRun:
          notRunLine?.kind === "not-run" && burstRounds.length === 0
            ? notRunLine.reason
            : undefined,
        redact: sanitize,
      }),
    ];
  });

  const runs = [...new Set([...byProvider.values()].map((v) => v.info))];
  const startedAt = runs.map((r) => r.startedAt).sort()[0] ?? first.startedAt;
  const ends = runs.map((r) => r.endedAt);

  const endedAt = ends.includes(null)
    ? null
    : (ends
        .filter((e) => e !== null)
        .sort()
        .at(-1) ?? null);

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    run: {
      id: [...new Set(runs.map((r) => r.id))].join("+"),
      mode: runs.every((r) => r.mode === "one-provider-at-a-time")
        ? "one-provider-at-a-time"
        : "parallel",
      sdkCommit: [...new Set(runs.map((r) => r.sdkCommit))].join("+"),
      startedAt,
      endedAt,
      location: first.location,
    },
    size: first.size,
    rounds: first.rounds,
    track: "same-machine",
    profile: "fix-and-test",
    providers,
  };
}

export function summaryMarkdown(data: BurstExport, spentUSD: number | null): string {
  const s = (v: number | null) => (v === null ? "n/a" : v.toFixed(1));

  const x = (v: number | null) => (v === null ? "n/a" : `${v.toFixed(2)}x`);

  const lines = data.providers.map((p) => {
    const failures = [
      ...(p.solo?.tasks ?? []).map((t) => ({ t, tag: `c${t.round}` })),
      ...p.tasks.map((t) => ({ t, tag: `r${t.round}` })),
    ]
      .flatMap(({ t, tag }) =>
        t.failure ? [`${tag} ${t.failure.stage}: ${t.failure.reason.slice(0, 120)}`] : [],
      )
      .concat(
        p.harnessFailures.map(
          (h) =>
            `${h.role === "control" ? "c" : "r"}${h.round} our side (${h.stage}): ${h.reason.slice(0, 120)}`,
        ),
      );

    const solo = p.solo ? ` (${p.solo.completed}/${p.solo.attempts})` : " (published)";

    return `| ${p.provider} | ${p.status === "ran" ? "ran" : `not run: ${p.reason}`} | ${s(p.medianWallS)} | ${s(p.soloMedianWallS)}${solo} | ${p.slowdownWithheld ? `withheld: ${p.slowdownWithheld}` : x(p.slowdown)} | ${x(p.slowdownWithoutUpload)} | ${s(p.medianUploadS)} / ${s(p.soloMedianUploadS)} | ${p.completed}/${p.attempts} | ${p.roundAllDoneS.map((v) => v.toFixed(0)).join(", ") || "n/a"} | ${failures.join("; ").replaceAll("|", "/") || "none"} |`;
  });

  return [
    `Real tasks at once: ${data.size} Fix and test tasks started together per round, ${data.rounds} rounds, same-machine track, providers ${data.run.mode === "one-provider-at-a-time" ? "one at a time" : "several at once"}. Run ${data.run.id} at ${data.run.sdkCommit.slice(0, 7)} from ${data.run.location}.`,
    "Timing only: billing windows were not reconciled and no cost is claimed.",
    spentUSD === null ? "" : `Estimated spend at list price: $${spentUSD.toFixed(2)}.`,
    "",
    "| Provider | Status | Median wall (s) | Solo median (s) | Slowdown | Without upload | Upload, at once / solo (s) | Completed | All done per round (s) | Failures |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...lines,
    "",
  ].join("\n");
}

export async function burstSummaryCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string", multiple: true },
      solo: { type: "string", default: defaultSolo },
      to: { type: "string" },
    },
  });

  if (!values.out?.length || !values.to) throw new Error("burst-summary needs --out and --to");

  const soloPath = values.solo;

  // Read only when some folder ran without control rounds.
  const data = await buildExport(
    values.out.map((d) => resolve(d)),
    () => soloMedians(soloPath),
  );

  await writeFile(resolve(values.to), JSON.stringify(data, null, 2) + "\n");
  process.stdout.write(summaryMarkdown(data, null));
}
