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
 * `ownership.json` in --out journals each live sandbox and every provider's connection
 * fingerprint, so `bun bench reap --run RUN_ID --out DIR --providers ...` finds what a crashed
 * run left. SIGINT or SIGTERM stops the run and destroys its live sandboxes first; a second
 * signal exits at once, leaving any sandbox not yet destroyed in the journal for `reap`.
 */
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import { z } from "zod";
import { fingerprintOf } from "../connections.js";
import { assertJournalFree, writeOwnership } from "../ownership.js";
import { loadProvider, type LoadedProvider, type ReadyProvider } from "../providers.js";
import { sanitize } from "../v2-runner.js";
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

export interface ExpandedFailure {
  readonly provider: string;
  readonly scenarioId: string;
  readonly run: number;
  readonly seed: number;
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
  readonly cleanupErrors: ExpandedFailure[];
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
 * any create, each sandbox added once its create returns and removed once its destroy succeeds.
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
 * Sandboxes this run created and has not destroyed. Each is destroyed at most once: a sample's
 * own cleanup and an interrupt share the same attempt.
 */
class LiveSandboxes {
  private readonly owners = new Map<Sandbox, string>();
  private readonly destroying = new Map<Sandbox, Promise<void>>();

  constructor(private readonly journal: OwnershipJournal) {}

  get size(): number {
    return this.owners.size;
  }

  async add(provider: string, box: Sandbox): Promise<void> {
    this.owners.set(box, provider);
    await this.journal.track(provider, box.id);
  }

  destroy(box: Sandbox): Promise<void> {
    const pending = this.destroying.get(box);

    if (pending) return pending;

    const provider = this.owners.get(box) ?? "";

    const attempt = box.destroy().then(async () => {
      this.owners.delete(box);
      await this.journal.release(provider, box.id);
    });

    this.destroying.set(box, attempt);

    return attempt;
  }

  /** Destroy every live sandbox; failures stay journaled for `reap`. */
  async destroyAll(): Promise<void> {
    await Promise.allSettled([...this.owners.keys()].map((box) => this.destroy(box)));
  }
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
    box = await createSandbox(provider.provider, {
      labels: { "sandbox-bench-run": state.runId },
    });
    await state.live.add(provider.name, box);

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
    if (box) {
      try {
        await state.live.destroy(box);
      } catch (error) {
        const reason = errorText(error instanceof Error ? error : nonError);
        state.results.cleanupErrors.push({ ...where, reason });
        process.stdout.write(`CLEANUP ${provider.name} ${scenario.id}: ${reason}\n`);
      }
    }
  }
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

  // Before this run writes anything there: another run's journal must not be overwritten.
  await mkdir(out, { recursive: true });
  await assertJournalFree(journalPath, runId, args.force);

  const loaded: LoadedProvider[] = [];

  for (const name of args.providers) {
    try {
      loaded.push(await load(name));
    } catch (error) {
      loaded.push({
        kind: "skipped",
        name,
        note: errorText(error instanceof Error ? error : nonError),
      });
    }
  }

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

  // Each adapter's connection fingerprint, never the connection itself; `reap` reads only through
  // an adapter whose connection, rebuilt from its environment, has the same fingerprint.
  const fingerprints: Record<string, string> = {};

  for (const p of ready) {
    const value = await fingerprintOf(p.provider);

    if (value) fingerprints[p.name] = value;
  }

  const journal = new OwnershipJournal(journalPath, runId, fingerprints);

  // Before any create, so a run that dies before its first create returns still leaves the
  // fingerprints a reap needs.
  if (ready.length > 0) await journal.persist();

  const state: RunState = {
    runId,
    timeoutMs: args.timeoutMs,
    results,
    live: new LiveSandboxes(journal),
    stopSignal: null,
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (state.stopSignal) {
      process.stdout.write(`${signal} again: exiting now; reap the rest with the journal\n`);
      process.exit(exitCodeFor(signal));
    }

    state.stopSignal = signal;
    process.stdout.write(`${signal}: stopping, destroying ${state.live.size} live sandboxes\n`);
    void state.live.destroyAll();
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
    if (state.stopSignal) await state.live.destroyAll();
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  }

  results.interrupted = state.stopSignal;
  results.finishedAt = new Date().toISOString();
  await writeResults(out, results, scenarios);
  process.stdout.write(
    `${results.samples.length} verified samples, ${results.failures.length} failures, ${results.cleanupErrors.length} cleanup errors${state.stopSignal ? `, interrupted by ${state.stopSignal}` : ""}; ${out}\n`,
  );

  if (state.stopSignal) process.exitCode = exitCodeFor(state.stopSignal);
  else if (ready.length === 0 || results.failures.length > 0 || results.cleanupErrors.length > 0)
    process.exitCode = 1;
}
