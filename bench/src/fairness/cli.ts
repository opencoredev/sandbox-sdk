/**
 * `bun bench fairness <check> [--providers a,b] [--concurrency 15] [--out DIR] [--run ID] [--merge-only]`
 *
 * Checks: security-probe, memory-honesty, disk-real, cpu-native, cpu-burst-10, state-survival,
 * memory-pressure. Each runs every listed provider on the same-machine track and writes
 * `<out>/<check>.json`. `--max-dollars` reserves each provider's worst case (its sandboxes for the
 * check's whole lifetime at list price) and leaves out the providers that would pass the cap.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { attemptBudget } from "../realistic/cli.js";
import { providerSetups, type ProviderSetup } from "../realistic/setup.js";
import { cpuBurst } from "./cpu-burst.js";
import { cpuNative } from "./cpu-native.js";
import { diskReal } from "./disk-real.js";
import {
  checkIdSchema,
  mergeResults,
  openLiveSession,
  paths,
  runCheck,
  runFileSchema,
  type Check,
  type CheckId,
  type Outcome,
  type Report,
} from "./framework.js";
import { memoryHonesty } from "./memory-honesty.js";
import { memoryPressure } from "./memory-pressure.js";
import { securityProbe } from "./security-probe.js";
import { stateSurvival } from "./state-survival.js";

/** Every check, keyed by ID; the record type makes a missing one a compile error (tests check each key matches its id). */
export const checks = {
  "security-probe": securityProbe,
  "memory-honesty": memoryHonesty,
  "disk-real": diskReal,
  "cpu-native": cpuNative,
  "cpu-burst-10": cpuBurst,
  "state-survival": stateSurvival,
  "memory-pressure": memoryPressure,
} satisfies { readonly [K in CheckId]: Check<unknown> };

const cliSchema = z.object({
  check: checkIdSchema,
  providers: z.array(z.string()).min(1),
  concurrency: z.coerce.number().int().positive(),
  out: z.string().min(1),
  run: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' and '-'")
    .nullable(),
  mergeOnly: z.boolean(),
  maxDollars: z.coerce.number().positive().nullable(),
});

export type FairnessCli = z.infer<typeof cliSchema>;

export const usage =
  "bun bench fairness <security-probe|memory-honesty|disk-real|cpu-native|cpu-burst-10|state-survival|memory-pressure> [--providers a,b] [--concurrency 15] [--out results/fairness/<check>] [--run ID] [--max-dollars N] [--merge-only]\n";

export function parseCli(args: readonly string[]): FairnessCli {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      providers: { type: "string" },
      concurrency: { type: "string", default: "15" },
      out: { type: "string" },
      run: { type: "string" },
      "merge-only": { type: "boolean", default: false },
      "max-dollars": { type: "string" },
    },
  });

  if (positionals.length !== 1) throw new Error(`Name one check.\n${usage}`);
  const check = checkIdSchema.parse(positionals[0]);
  const known = providerSetups.map((s) => s.name);

  const providers =
    values.providers === undefined
      ? known
      : values.providers
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);

  const unknown = providers.filter((name) => !known.includes(name));

  if (unknown.length > 0)
    throw new Error(`Unknown provider ${unknown.join(", ")}; known: ${known.join(", ")}`);

  return cliSchema.parse({
    check,
    providers: [...new Set(providers)],
    concurrency: values.concurrency,
    out: values.out ?? `results/fairness/${check}`,
    run: values.run ?? null,
    mergeOnly: values["merge-only"],
    maxDollars: values["max-dollars"] ?? null,
  });
}

/**
 * Splits providers into those whose worst-case reservation fits `maxDollars` (in order) and those
 * left out. A provider's reservation is its sandboxes for the check's whole lifetime at list price.
 */
export function admitWithin(input: {
  readonly setups: readonly ProviderSetup[];
  readonly boxes: number;
  readonly lifetimeMs: number;
  readonly maxDollars: number | null;
}) {
  const admitted: { setup: ProviderSetup; usd: number }[] = [];
  const refused: { setup: ProviderSetup; usd: number }[] = [];
  let reserved = 0;

  for (const setup of input.setups) {
    const usd = attemptBudget(setup, "same-machine", input.lifetimeMs) * input.boxes;

    if (input.maxDollars !== null && reserved + usd > input.maxDollars)
      refused.push({ setup, usd });
    else {
      reserved += usd;
      admitted.push({ setup, usd });
    }
  }

  return { admitted, refused, reservedUSD: reserved };
}

const autoRunId = (check: CheckId) =>
  `${check}-${new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15)}`;

export function table(report: Report) {
  return report.providers
    .map(
      (p) =>
        `${p.provider.padEnd(18)} ${p.status.padEnd(9)} ${p.sandboxes.length} sandbox(es)${p.destroyed ? "" : " NOT CONFIRMED DESTROYED"}${p.reason ? ` (${p.reason.slice(0, 160)})` : ""}\n`,
    )
    .join("");
}

/**
 * 1 when a provider this invocation ran failed (a failed measurement is a report row, not an
 * exception), a run threw, or a sandbox was not confirmed destroyed; rows of providers it did not
 * run never count.
 */
export function exitCodeOf(outcome: Outcome, providers: readonly string[]) {
  const failed = outcome.report.providers.some(
    (p) => p.status === "failed" && providers.includes(p.provider),
  );

  return failed || outcome.failures.length > 0 || outcome.cleanupProblems.length > 0 ? 1 : 0;
}

export async function fairnessCommand(args: readonly string[]) {
  if (args.includes("--help") || args.length === 0) {
    process.stdout.write(usage);

    return;
  }

  const cli = parseCli(args);
  const out = resolve(cli.out);
  const check: Check<unknown> = checks[cli.check];

  if (cli.mergeOnly) {
    const report = await mergeResults(out, cli.check, check.resultSchema);
    process.stdout.write(`Merged ${report.providers.length} providers\n${table(report)}`);

    return;
  }

  const existing = await readFile(paths(out, cli.check).run, "utf8")
    .then((text) => runFileSchema.parse(JSON.parse(text)).run.id)
    .catch(() => null);

  const runId = cli.run ?? existing ?? autoRunId(cli.check);
  const controller = new AbortController();
  let interrupts = 0;

  const onSignal = () => {
    interrupts++;

    if (interrupts > 1) process.exit(130);
    process.stderr.write("Interrupted: stopping and destroying\n");
    controller.abort();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const budget = admitWithin({
      setups: cli.providers.flatMap((name) => providerSetups.filter((s) => s.name === name)),
      boxes: check.boxes,
      lifetimeMs: check.lifetimeMs,
      maxDollars: cli.maxDollars,
    });

    for (const { setup, usd } of budget.refused)
      process.stderr.write(
        `SKIPPED ${setup.name}: reserving $${usd.toFixed(2)} would pass --max-dollars ${cli.maxDollars}\n`,
      );

    const setups = budget.admitted.map((entry) => entry.setup);

    process.stdout.write(
      `${cli.check} run ${runId}: ${setups.length} providers, reserved $${budget.reservedUSD.toFixed(2)} at list price, out ${out}\n`,
    );

    const outcome = await runCheck(
      check,
      setups,
      { runId, out, concurrency: cli.concurrency },
      {
        open: openLiveSession,
        signal: controller.signal,
        progress: (line) => process.stdout.write(`${line}\n`),
      },
    );

    process.stdout.write(`${table(outcome.report)}Report: ${paths(out, cli.check).report}\n`);

    for (const failure of outcome.failures)
      process.stderr.write(`RUN FAILED ${failure.provider}: ${failure.error}\n`);

    for (const problem of outcome.cleanupProblems)
      process.stderr.write(`CLEANUP ${problem.provider}: ${problem.error}\n`);

    process.exitCode = budget.refused.length > 0 ? 1 : exitCodeOf(outcome, cli.providers);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
