/**
 * `bun bench expanded`: run the expanded scenario catalog on real providers.
 *
 *   --providers local,e2b      providers to run (required unless --list)
 *   --scenarios all|id,id      scenario ids (default all)
 *   --categories cpu,builds    keep only these categories
 *   --runs N                   samples per provider and scenario (default 1)
 *   --timeout-ms N             per-command timeout inside a scenario (default 120000)
 *   --out DIR                  where results.json, site-data.json and ownership.json go
 *                              (default results/expanded)
 *   --force                    overwrite another run's ownership journal in --out
 *   --list                     print the catalog and exit
 *
 * Every sample gets a fresh sandbox and a fresh random seed, and its outcome only counts after
 * the scenario's own verifier accepted the guest output for that seed.
 *
 * Cleanup works like the main harness's. Sandboxes carry the `sandbox-bench-run` label, and
 * `ownership.json` in --out journals each sandbox and every provider's connection fingerprint, so
 * `bun bench reap --run RUN_ID --out DIR --providers ...` finds what a crashed run left. A delete
 * acknowledgment is not proof: a sandbox stays journaled until an exact lookup finds it absent or
 * terminal. After the last sample, a final sweep lists the run's label on every provider, deletes
 * what is still there and looks again; any sandbox it cannot see gone is a cleanup error and stays
 * journaled for `reap`. SIGINT or SIGTERM stops the run and destroys its live sandboxes first; a
 * second signal exits at once, leaving any sandbox not yet confirmed gone in the journal.
 *
 * A run claims --out with `run.json` and gives it up only when it ends with nothing left to clean
 * up; a run that died keeps the claim, so reap it and then pass --force or choose another --out.
 */
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createSandbox, type CreateOptions, type Sandbox } from "@opencoredev/sandbox-sdk";
import { z } from "zod";
import { isAbsent, lookupSandbox, type LookupEvidence } from "../existence.js";
import { isMissingFile } from "../files.js";
import {
  assertJournalFree,
  hasRunOwnership,
  verifyRunOwnership,
  writeOwnership,
} from "../ownership.js";
import { loadProvider, type LoadedProvider, type ReadyProvider } from "../providers.js";
import { providerSetups } from "../realistic/setup.js";
import { DeadlineError, DeletionWork, deadline } from "../timing.js";
import { fingerprinted, sanitize } from "../v2-runner.js";
import { expandedScenarios, exportExpandedSiteData } from "./registry.js";
import {
  expandedCategories,
  type ExpandedCategory,
  type ExpandedRunSample,
  type ExpandedScenario,
} from "./types.js";

const commaList = z.string().transform((value) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

const positiveInt = (max: number) => z.coerce.number().int().positive().max(max);

const argsSchema = z.object({
  providers: commaList.pipe(z.array(z.string()).min(1, "--providers needs at least one name")),
  scenarios: commaList.pipe(z.array(z.string()).min(1)),
  categories: commaList.pipe(z.array(z.enum(expandedCategories))).optional(),
  runs: positiveInt(100),
  timeoutMs: positiveInt(3_600_000),
  out: z.string().min(1),
  force: z.boolean(),
});

export type ExpandedArgs = z.infer<typeof argsSchema>;

export type ParsedCommand =
  | { readonly kind: "list" }
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly args: ExpandedArgs };

export const usage =
  "bun bench expanded --providers local[,e2b,...] [--scenarios all|id,id] [--categories cpu,builds] [--runs 1] [--timeout-ms 120000] [--out results/expanded] [--force] | --list\nAfter a crash: bun bench reap --run RUN_ID --out DIR --providers local[,e2b,...]\n";

/** Parse `bun bench expanded` arguments. Throws with a usage hint on bad input. */
export function parseExpandedArgs(argv: readonly string[]): ParsedCommand {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      providers: { type: "string" },
      scenarios: { type: "string", default: "all" },
      categories: { type: "string" },
      runs: { type: "string", default: "1" },
      "timeout-ms": { type: "string", default: "120000" },
      out: { type: "string", default: "results/expanded" },
      force: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) return { kind: "help" };

  if (values.list) return { kind: "list" };

  const parsed = argsSchema.safeParse({
    providers: values.providers ?? "",
    scenarios: values.scenarios,
    categories: values.categories,
    runs: values.runs,
    timeoutMs: values["timeout-ms"],
    out: values.out,
    force: values.force,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    throw new Error(
      `Invalid arguments: ${issue ? `${issue.path.join(".")} ${issue.message}` : "unknown"}\n${usage}`,
    );
  }

  return { kind: "run", args: parsed.data };
}

/** The scenarios a run covers, in catalog order. Unknown ids or an empty selection throw. */
export function selectScenarios(
  catalog: readonly ExpandedScenario[],
  ids: readonly string[],
  categories: readonly ExpandedCategory[] | undefined,
): readonly ExpandedScenario[] {
  const all = ids.includes("all");

  if (!all) {
    const known = new Set(catalog.map((s) => s.id));
    const unknown = ids.filter((id) => !known.has(id));

    if (unknown.length) throw new Error(`Unknown expanded scenarios: ${unknown.join(", ")}`);
  }

  const selected = catalog.filter(
    (s) => (all || ids.includes(s.id)) && (!categories || categories.includes(s.category)),
  );

  if (selected.length === 0) throw new Error("No expanded scenarios match the selection");

  return selected;
}

/** The catalog as a fixed-width text table. */
export function catalogTable(catalog: readonly ExpandedScenario[]): string {
  const header = ["id", "category", "unit", "better", "label"];

  const rows = [header, ...catalog.map((s) => [s.id, s.category, s.unit, s.better, s.label])];

  const widths = header.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );

  const lines = rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  );

  return `${lines.join("\n")}\n${catalog.length} scenarios\n`;
}

/** The sample a sandbox or a failure belongs to. */
export interface SampleRef {
  readonly provider: string;
  readonly scenarioId: string;
  readonly run: number;
  readonly seed: number;
}

export interface ExpandedFailure extends SampleRef {
  readonly reason: string;
}

/** A sandbox the run could not confirm gone, still journaled for `reap`. */
export interface ExpandedCleanupError {
  readonly provider: string;
  /** Null when the final sweep could not list the provider's sandboxes at all. */
  readonly sandboxId: string | null;
  /** The sample that created it; null for one only the final sweep's listing found. */
  readonly sample: SampleRef | null;
  readonly reason: string;
}

export interface ExpandedResults {
  readonly version: 1;
  readonly runId: string;
  readonly startedAt: string;
  finishedAt: string | null;
  /** The signal that stopped the run early, if one did. */
  interrupted: NodeJS.Signals | null;
  readonly runs: number;
  readonly timeoutMs: number;
  readonly scenarioIds: readonly string[];
  readonly providers: readonly { name: string; kind: LoadedProvider["kind"]; note: string }[];
  readonly samples: ExpandedRunSample[];
  readonly failures: ExpandedFailure[];
  readonly cleanupErrors: ExpandedCleanupError[];
}

/** A caught error as redacted, bounded text for results.json. */
const errorText = (error: Error | string) =>
  sanitize(error instanceof Error ? error.message : error).slice(0, 2000);

const nonError = "Non-Error thrown";

/** One journal entry, in the shape `bun bench reap` reads from ownership.json. */
interface JournalResource {
  readonly provider: string;
  readonly id: string;
  readonly kind: "sandbox";
  readonly parent: null;
}

/**
 * The run's ownership journal, as `v2-runner.ts` keeps it: connection fingerprints written before
 * any create, each sandbox added once its create returns and removed once a lookup sees it gone.
 * Writes are serialized and atomic (`writeOwnership`). Live labels, not this file, authorize a
 * deletion: `reap` lists the run's label and verifies each ID before destroying it.
 */
class OwnershipJournal {
  private readonly resources = new Map<string, JournalResource>();
  private writes = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly runId: string,
    private readonly connectionFingerprints: Readonly<Record<string, string>>,
  ) {}

  persist(): Promise<void> {
    const data = JSON.stringify(
      {
        runId: this.runId,
        connectionFingerprints: this.connectionFingerprints,
        resources: [...this.resources.values()],
        apps: [],
      },
      null,
      2,
    );

    this.writes = this.writes.then(() => writeOwnership(this.path, data));

    return this.writes;
  }

  track(provider: string, id: string): Promise<void> {
    this.resources.set(`${provider}/${id}`, { provider, id, kind: "sandbox", parent: null });

    return this.persist();
  }

  release(provider: string, id: string): Promise<void> {
    this.resources.delete(`${provider}/${id}`);

    return this.persist();
  }
}

/**
 * How long a deletion has to be observed after its acknowledgment, as in `v2-runner.ts`: the
 * per-command timeout, at most 30 s.
 */
const goneWaitMs = (timeoutMs: number) => Math.min(timeoutMs, 30_000);

/**
 * Look `id` up at once, then every 0.1 to 1 s, until an exact lookup finds it absent or terminal
 * or `waitMs` runs out; returns the last lookup. Only that lookup, never a delete
 * acknowledgment or a listing, shows a sandbox is gone.
 */
async function waitUntilGone(
  provider: ReadyProvider,
  id: string,
  waitMs: number,
): Promise<LookupEvidence> {
  const end = performance.now() + waitMs;

  for (let delay = 0; ; delay = Math.min(1000, Math.max(100, delay * 2))) {
    if (delay > 0) await sleep(Math.min(delay, Math.max(0, end - performance.now())));

    const evidence = await lookupSandbox(
      provider.provider,
      id,
      Math.max(1, end - performance.now()),
    );

    if (isAbsent(evidence) || performance.now() >= end) return evidence;
  }
}

/** Why a lookup did not show the sandbox gone. */
function notGone(evidence: LookupEvidence): string {
  const state = evidence.nativeState ? ` (${evidence.nativeState})` : "";

  return `deletion not confirmed: the last exact lookup found it ${evidence.result}${state}`;
}

/** A sandbox this run created, journaled until it is confirmed gone. */
interface OwnedSandbox {
  readonly provider: ReadyProvider;
  readonly id: string;
  /** The SDK handle the first delete goes through; later deletes go to the provider by ID. */
  readonly box: Sandbox | null;
  readonly sample: SampleRef | null;
  /** Whether a delete went through `box` already: the handle sends at most one. */
  handleDeleted: boolean;
  /** Why the last cleanup attempt did not confirm it gone. */
  pending: string | null;
}

/**
 * Sandboxes this run created and has not seen gone. Each is cleaned up by one attempt at a time:
 * a sample's own cleanup and an interrupt share it. An attempt deletes the sandbox, then looks it
 * up until it is gone; only then does the sandbox leave the journal. A delete that has not
 * settled stays in `deletions`, so a later attempt waits on it instead of sending another.
 */
class LiveSandboxes {
  private readonly owned = new Map<string, OwnedSandbox>();
  private readonly attempts = new Map<string, Promise<boolean>>();
  private readonly deletions = new DeletionWork();

  constructor(
    private readonly journal: OwnershipJournal,
    private readonly runId: string,
    private readonly timeoutMs: number,
  ) {}

  /** Sandboxes not yet confirmed gone. */
  get size(): number {
    return this.owned.size;
  }

  async add(provider: ReadyProvider, box: Sandbox, sample: SampleRef): Promise<void> {
    this.owned.set(`${provider.name}/${box.id}`, {
      provider,
      id: box.id,
      box,
      sample,
      handleDeleted: false,
      pending: null,
    });
    await this.journal.track(provider.name, box.id);
  }

  /** Journal a sandbox only the final sweep's listing found, before deleting it. */
  async adopt(provider: ReadyProvider, id: string): Promise<void> {
    if (this.owned.has(`${provider.name}/${id}`)) return;

    this.owned.set(`${provider.name}/${id}`, {
      provider,
      id,
      box: null,
      sample: null,
      handleDeleted: false,
      pending: null,
    });
    await this.journal.track(provider.name, id);
  }

  /**
   * Delete the sandbox and wait until it is seen gone, all within `waitMs`; true once it is, and
   * out of the journal. False leaves it journaled with the reason in `pending`, for the final sweep.
   */
  clean(
    provider: ReadyProvider,
    id: string,
    waitMs = goneWaitMs(this.timeoutMs),
  ): Promise<boolean> {
    const key = `${provider.name}/${id}`;
    const running = this.attempts.get(key);

    if (running) return running;

    const attempt = this.attempt(key, waitMs).finally(() => this.attempts.delete(key));
    this.attempts.set(key, attempt);

    return attempt;
  }

  /**
   * The first delete goes through the handle the create returned. A delete by ID goes out only
   * once the exact ID still lists with this run's labels; without that proof none is sent, and
   * only an exact lookup that finds the sandbox gone takes it out of the journal. Deleting may use
   * half of `waitMs`, so a delete that never settles still leaves the lookups their time.
   */
  private async attempt(key: string, waitMs: number): Promise<boolean> {
    const entry = this.owned.get(key);

    if (!entry) return true;

    const { provider, id, box } = entry;
    const end = performance.now() + waitMs;
    const deleteEnd = end - waitMs / 2;
    const deleteLeft = () => Math.max(1, deleteEnd - performance.now());
    let deleteError: string | null = null;

    try {
      if (box && !entry.handleDeleted) {
        entry.handleDeleted = true;
        await deadline(deleteLeft(), () =>
          this.deletions.start(provider.name, id, () => box.destroy()),
        );
      } else if (await verifyRunOwnership(provider.provider, id, this.runId, deleteLeft()))
        await deadline(deleteLeft(), () =>
          this.deletions.start(provider.name, id, () => provider.provider.destroy(id)),
        );
      else deleteError = "no delete sent: the exact ID does not list with this run's labels";
    } catch (error) {
      deleteError =
        error instanceof DeadlineError
          ? "delete still unanswered at its deadline"
          : `delete failed: ${errorText(error instanceof Error ? error : nonError)}`;
    }

    let evidence: LookupEvidence;

    try {
      evidence = await waitUntilGone(provider, id, Math.max(1, end - performance.now()));
    } catch (error) {
      entry.pending = `existence lookup failed: ${errorText(error instanceof Error ? error : nonError)}`;

      return false;
    }

    if (!isAbsent(evidence)) {
      entry.pending = deleteError ? `${deleteError}; ${notGone(evidence)}` : notGone(evidence);

      return false;
    }

    this.owned.delete(key);
    await this.journal.release(provider.name, id);

    return true;
  }

  /** Clean every sandbox not yet seen gone. */
  async cleanAll(): Promise<void> {
    await Promise.allSettled(
      [...this.owned.values()].map((entry) => this.clean(entry.provider, entry.id)),
    );
  }

  /** The sandboxes `provider` still has journaled. */
  of(provider: ReadyProvider): readonly OwnedSandbox[] {
    return [...this.owned.values()].filter((entry) => entry.provider === provider);
  }
}

/**
 * The final sweep, after the last sample: list each provider's sandboxes under this run's label,
 * journal any the run lost track of, and delete and look up every one not yet seen gone, within
 * one shared wait. What is still not seen gone becomes a cleanup error and stays journaled.
 */
async function finalSweep(providers: readonly ReadyProvider[], state: RunState): Promise<void> {
  const end = performance.now() + goneWaitMs(state.timeoutMs);
  const left = () => Math.max(1, end - performance.now());

  await Promise.all(
    providers.map(async (provider) => {
      try {
        const listed = await deadline(left(), () =>
          provider.provider.list({ "sandbox-bench-run": state.runId }),
        );

        for (const info of listed)
          if (hasRunOwnership(info, state.runId)) await state.live.adopt(provider, info.id);
      } catch (error) {
        const reason = `final sweep could not list the run's sandboxes: ${errorText(error instanceof Error ? error : nonError)}`;
        state.results.cleanupErrors.push({
          provider: provider.name,
          sandboxId: null,
          sample: null,
          reason,
        });
        process.stdout.write(`CLEANUP ${provider.name}: ${reason}\n`);
      }

      await Promise.all(
        state.live.of(provider).map(async (entry) => {
          let failed: string | null = null;

          try {
            if (await state.live.clean(provider, entry.id, left())) return;
          } catch (error) {
            failed = errorText(error instanceof Error ? error : nonError);
          }

          const reason = failed ?? entry.pending ?? "deletion not confirmed";
          state.results.cleanupErrors.push({
            provider: provider.name,
            sandboxId: entry.id,
            sample: entry.sample,
            reason,
          });
          process.stdout.write(
            `CLEANUP ${provider.name} ${entry.id}: ${reason}; left journaled for reap\n`,
          );
        }),
      );
    }),
  );
}

/** The run-wide state a sample reads and updates. */
interface RunState {
  readonly runId: string;
  readonly timeoutMs: number;
  readonly results: ExpandedResults;
  readonly live: LiveSandboxes;
  /** Set by the first SIGINT or SIGTERM. */
  stopSignal: NodeJS.Signals | null;
}

/**
 * Adapters that write the run's labels into the guest after allocation: until that write, no label
 * marks the sandbox as this run's, so a crash in between leaves nothing `reap` can find.
 */
const guestLabeled: ReadonlySet<string> = new Set(["boxd", "archil", "beam"]);

/**
 * The hard lifetime a sample's sandbox is created with (`timeoutMs`), so the provider deletes one
 * the run lost track of: 10 minutes more than one command may take and at least 25 minutes, as
 * `sustained-cpu.ts` sizes its own. Null for an adapter the realistic setup table does not list as
 * accepting `timeoutMs`.
 */
export function sandboxLifetimeMs(adapter: string, timeoutMs: number): number | null {
  return providerSetups.some((s) => s.adapter === adapter && s.lifetime)
    ? Math.max(1_500_000, timeoutMs + 600_000)
    : null;
}

/** One verified sample on a fresh sandbox; the sandbox is destroyed whatever happens. */
async function runSample(
  provider: ReadyProvider,
  scenario: ExpandedScenario,
  run: number,
  state: RunState,
) {
  const seed = randomInt(0, 2 ** 32);
  const where = { provider: provider.name, scenarioId: scenario.id, run, seed };
  const started = performance.now();
  let box: Sandbox | undefined;

  try {
    const options: CreateOptions = { labels: { "sandbox-bench-run": state.runId } };
    const lifetimeMs = sandboxLifetimeMs(provider.name, state.timeoutMs);

    if (lifetimeMs !== null) options.timeoutMs = lifetimeMs;
    box = await createSandbox(provider.provider, options);
    await state.live.add(provider, box, where);

    if (state.stopSignal) throw new Error("not started: the run was interrupted");

    const outcome = await scenario.run(box, { seed, timeoutMs: state.timeoutMs });

    if (!Number.isFinite(outcome.value) || outcome.value <= 0)
      throw new Error(`non-positive value ${outcome.value}`);

    if (outcome.proof.trim().length < 8) throw new Error("proof shorter than 8 characters");

    const sample: ExpandedRunSample = {
      scenarioId: scenario.id,
      provider: provider.name,
      seed,
      value: outcome.value,
      unit: scenario.unit,
      better: scenario.better,
      proof: outcome.proof,
      wallMs: Math.round(performance.now() - started),
      details: outcome.details,
    };

    state.results.samples.push(sample);
    process.stdout.write(
      `PASS ${provider.name} ${scenario.id} run ${run}: ${outcome.value.toPrecision(4)} ${scenario.unit} (${sample.wallMs} ms)\n`,
    );
  } catch (error) {
    const text = errorText(error instanceof Error ? error : nonError);
    const reason = state.stopSignal ? `interrupted by ${state.stopSignal}: ${text}` : text;
    state.results.failures.push({ ...where, reason });
    process.stdout.write(`FAIL ${provider.name} ${scenario.id} run ${run}: ${reason}\n`);
  } finally {
    // Not yet gone stays journaled; the final sweep retries it and reports what it cannot clear.
    if (box && !(await state.live.clean(provider, box.id).catch(() => false)))
      process.stdout.write(
        `CLEANUP ${provider.name} ${scenario.id} ${box.id}: not confirmed gone; the final sweep retries it\n`,
      );
  }
}

const claimFile = z.object({ runId: z.string() });

/**
 * Claim `out` for `runId` by creating run.json exclusively, as `v2-runner.ts` does: of two runs
 * that both passed `assertJournalFree`, only one gets it. `force` takes the claim over.
 */
async function claimOutput(path: string, runId: string, force: boolean) {
  try {
    await writeFile(path, `${JSON.stringify({ runId })}\n`, { flag: force ? "w" : "wx" });
  } catch (error) {
    if (!z.object({ code: z.literal("EEXIST") }).safeParse(error).success) throw error;

    throw new Error(
      `${path} claims this --out for another run, which may still be running or may have died before its cleanup was confirmed. Reap that run (bun bench reap --run ID --out the same directory) and pass --force, or choose another --out.`,
    );
  }
}

/** Give up the claim, unless another run took it over with --force. */
async function releaseClaim(path: string, runId: string) {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  const claim = claimFile.safeParse(JSON.parse(text));

  if (claim.success && claim.data.runId === runId) await rm(path, { force: true });
}

/** Replace `path` through a temporary file in the same directory, so no reader sees half a file. */
async function replaceFile(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeResults(
  out: string,
  results: ExpandedResults,
  scenarios: readonly ExpandedScenario[],
) {
  await mkdir(out, { recursive: true });
  await replaceFile(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await replaceFile(
    join(out, "site-data.json"),
    `${JSON.stringify(exportExpandedSiteData(results.samples, scenarios), null, 2)}\n`,
  );
}

/** Shell convention: 128 plus the signal number (SIGINT 2, SIGTERM 15). */
const exitCodeFor = (signal: NodeJS.Signals) => (signal === "SIGINT" ? 130 : 143);

/** Where SIGINT and SIGTERM arrive: the process, or an EventEmitter in tests. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): void;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): void;
}

export interface ExpandedDependencies {
  readonly load?: typeof loadProvider;
  readonly catalog?: readonly ExpandedScenario[];
  readonly signals?: SignalSource;
}

/** Run the expanded catalog. Tests pass `load`, `catalog` and `signals` to avoid real adapters. */
export async function expandedCommand(argv: string[], dependencies: ExpandedDependencies = {}) {
  const { load = loadProvider, catalog = expandedScenarios, signals = process } = dependencies;

  const parsed = parseExpandedArgs(argv);

  if (parsed.kind === "help") {
    process.stdout.write(usage);

    return;
  }

  if (parsed.kind === "list") {
    process.stdout.write(catalogTable(catalog));

    return;
  }

  const args = parsed.args;
  const scenarios = selectScenarios(catalog, args.scenarios, args.categories);
  const out = resolve(args.out);
  const startedAt = new Date();
  const runId = `expanded-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
  const journalPath = join(out, "ownership.json");
  const claimPath = join(out, "run.json");

  // Before this run writes anything there: another run's journal must not be overwritten. The
  // claim stays until the run ends with nothing left to clean up, so the journal of a run that
  // died, even one whose first create never returned an ID, is never overwritten without --force.
  await mkdir(out, { recursive: true });
  await assertJournalFree(journalPath, runId, args.force);
  await claimOutput(claimPath, runId, args.force);

  const candidates: LoadedProvider[] = [];

  for (const name of args.providers) {
    try {
      candidates.push(await load(name));
    } catch (error) {
      candidates.push({
        kind: "skipped",
        name,
        note: errorText(error instanceof Error ? error : nonError),
      });
    }
  }

  // Only providers whose connection fingerprint the journal records: `reap` refuses any other, so
  // a sandbox created on one could never be cleaned up after a crash.
  const { loaded: fingerprintedProviders, connectionFingerprints } =
    await fingerprinted(candidates);

  const loaded = fingerprintedProviders.map(
    (p): LoadedProvider =>
      p.kind === "ready" &&
      guestLabeled.has(p.name) &&
      sandboxLifetimeMs(p.name, args.timeoutMs) === null
        ? {
            kind: "skipped",
            name: p.name,
            note: "Labels are written in the guest after allocation and the adapter takes no hard lifetime, so a crash before the label lands would leave a sandbox nothing finds",
          }
        : p,
  );

  const results: ExpandedResults = {
    version: 1,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    interrupted: null,
    runs: args.runs,
    timeoutMs: args.timeoutMs,
    scenarioIds: scenarios.map((s) => s.id),
    providers: loaded.map((p) => ({
      name: p.name,
      kind: p.kind,
      note: p.kind === "skipped" ? p.note : "",
    })),
    samples: [],
    failures: [],
    cleanupErrors: [],
  };

  for (const p of loaded)
    if (p.kind === "skipped") process.stdout.write(`SKIP ${p.name}: ${p.note}\n`);
  const ready = loaded.filter((p): p is ReadyProvider => p.kind === "ready");

  const journal = new OwnershipJournal(journalPath, runId, connectionFingerprints);

  // Before any create, so a run that dies before its first create returns still leaves the
  // fingerprints a reap needs.
  if (ready.length > 0) await journal.persist();

  const state: RunState = {
    runId,
    timeoutMs: args.timeoutMs,
    results,
    live: new LiveSandboxes(journal, runId, args.timeoutMs),
    stopSignal: null,
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (state.stopSignal) {
      process.stdout.write(`${signal} again: exiting now; reap the rest with the journal\n`);
      process.exit(exitCodeFor(signal));
    }

    state.stopSignal = signal;
    process.stdout.write(`${signal}: stopping, destroying ${state.live.size} live sandboxes\n`);
    void state.live.cleanAll();
  };

  process.stdout.write(
    `Run ${runId}: ${scenarios.length} scenarios x ${ready.length} providers x ${args.runs} runs\n` +
      `If it dies, clean up with: bun bench reap --run ${runId} --out ${out} --providers ${ready.map((p) => p.name).join(",")}\n`,
  );

  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);

  try {
    samples: for (let run = 1; run <= args.runs; run++)
      for (const provider of ready)
        for (const scenario of scenarios) {
          if (state.stopSignal) break samples;

          await runSample(provider, scenario, run, state);
          // Written after every sample, so an interrupted run keeps what it measured.
          await writeResults(out, results, scenarios);
        }

    // A sample whose create returned after the signal is destroyed by its own cleanup; this
    // catches anything still live.
    if (state.stopSignal) await state.live.cleanAll();

    await finalSweep(ready, state);
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  }

  results.interrupted = state.stopSignal;
  results.finishedAt = new Date().toISOString();
  await writeResults(out, results, scenarios);

  if (state.live.size === 0 && results.cleanupErrors.length === 0)
    await releaseClaim(claimPath, runId);
  process.stdout.write(
    `${results.samples.length} verified samples, ${results.failures.length} failures, ${results.cleanupErrors.length} cleanup errors${state.stopSignal ? `, interrupted by ${state.stopSignal}` : ""}; ${out}\n`,
  );

  if (state.stopSignal) process.exitCode = exitCodeFor(state.stopSignal);
  else if (ready.length === 0 || results.failures.length > 0 || results.cleanupErrors.length > 0)
    process.exitCode = 1;
}
