/**
 * `bun bench expanded`: run the expanded scenario catalog on real providers.
 *
 *   --providers local,e2b      providers to run (required unless --list)
 *   --scenarios all|id,id      scenario ids (default all)
 *   --categories cpu,builds    keep only these categories
 *   --runs N                   samples per provider and scenario (default 1)
 *   --timeout-ms N             per-command timeout inside a scenario (default 120000)
 *   --out DIR                  where results.json and site-data.json go (default results/expanded)
 *   --list                     print the catalog and exit
 *
 * Every sample gets a fresh sandbox and a fresh random seed, and its outcome only counts after
 * the scenario's own verifier accepted the guest output for that seed. Sandboxes carry the
 * `sandbox-bench-run` label, so a crashed run can be swept like any other bench run.
 */
import { randomInt } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import { z } from "zod";
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
});

export type ExpandedArgs = z.infer<typeof argsSchema>;

export type ParsedCommand =
  | { readonly kind: "list" }
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly args: ExpandedArgs };

export const usage =
  "bun bench expanded --providers local[,e2b,...] [--scenarios all|id,id] [--categories cpu,builds] [--runs 1] [--timeout-ms 120000] [--out results/expanded] | --list\n";

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

/** One verified sample on a fresh sandbox; the sandbox is destroyed whatever happens. */
async function runSample(
  provider: ReadyProvider,
  scenario: ExpandedScenario,
  context: { readonly run: number; readonly runId: string; readonly timeoutMs: number },
  results: ExpandedResults,
) {
  const seed = randomInt(0, 2 ** 32);
  const where = { provider: provider.name, scenarioId: scenario.id, run: context.run, seed };
  const started = performance.now();
  let box: Sandbox | undefined;

  try {
    box = await createSandbox(provider.provider, {
      labels: { "sandbox-bench-run": context.runId },
    });

    const outcome = await scenario.run(box, { seed, timeoutMs: context.timeoutMs });

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

    results.samples.push(sample);
    process.stdout.write(
      `PASS ${provider.name} ${scenario.id} run ${context.run}: ${outcome.value.toPrecision(4)} ${scenario.unit} (${sample.wallMs} ms)\n`,
    );
  } catch (error) {
    const reason = errorText(error instanceof Error ? error : nonError);
    results.failures.push({ ...where, reason });
    process.stdout.write(`FAIL ${provider.name} ${scenario.id} run ${context.run}: ${reason}\n`);
  } finally {
    if (box) {
      try {
        await box.destroy();
      } catch (error) {
        const reason = errorText(error instanceof Error ? error : nonError);
        results.cleanupErrors.push({ ...where, reason });
        process.stdout.write(`CLEANUP ${provider.name} ${scenario.id}: ${reason}\n`);
      }
    }
  }
}

async function writeResults(
  out: string,
  results: ExpandedResults,
  scenarios: readonly ExpandedScenario[],
) {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(
    join(out, "site-data.json"),
    `${JSON.stringify(exportExpandedSiteData(results.samples, scenarios), null, 2)}\n`,
  );
}

/** Run the expanded catalog. Tests pass `load` and `catalog` to avoid real adapters. */
export async function expandedCommand(
  argv: string[],
  load: typeof loadProvider = loadProvider,
  catalog: readonly ExpandedScenario[] = expandedScenarios,
) {
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

  process.stdout.write(
    `Run ${runId}: ${scenarios.length} scenarios x ${ready.length} providers x ${args.runs} runs\n`,
  );

  for (let run = 1; run <= args.runs; run++)
    for (const provider of ready)
      for (const scenario of scenarios) {
        await runSample(provider, scenario, { run, runId, timeoutMs: args.timeoutMs }, results);
        // Written after every sample, so an interrupted run keeps what it measured.
        await writeResults(out, results, scenarios);
      }

  results.finishedAt = new Date().toISOString();
  await writeResults(out, results, scenarios);
  process.stdout.write(
    `${results.samples.length} verified samples, ${results.failures.length} failures, ${results.cleanupErrors.length} cleanup errors; ${out}\n`,
  );

  if (ready.length === 0 || results.failures.length > 0 || results.cleanupErrors.length > 0)
    process.exitCode = 1;
}
