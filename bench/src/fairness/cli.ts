/**
 * `bun bench fairness <check> [--providers a,b] [--concurrency 15] [--out DIR] [--run ID] [--merge-only]`
 *
 * Checks: security-probe, memory-honesty, disk-real, cpu-native, cpu-burst-10. Each runs every
 * listed provider on the same-machine track and writes `<out>/<check>.json`.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { providerSetups } from "../realistic/setup.js";
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
  type Report,
} from "./framework.js";
import { memoryHonesty } from "./memory-honesty.js";
import { securityProbe } from "./security-probe.js";

/** Every check, keyed by ID; the record type makes a missing one a compile error (tests check each key matches its id). */
export const checks = {
  "security-probe": securityProbe,
  "memory-honesty": memoryHonesty,
  "disk-real": diskReal,
  "cpu-native": cpuNative,
  "cpu-burst-10": cpuBurst,
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
});

export type FairnessCli = z.infer<typeof cliSchema>;

export const usage =
  "bun bench fairness <security-probe|memory-honesty|disk-real|cpu-native|cpu-burst-10> [--providers a,b] [--concurrency 15] [--out results/fairness/<check>] [--run ID] [--merge-only]\n";

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
  });
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
    const setups = cli.providers.flatMap((name) => providerSetups.filter((s) => s.name === name));
    process.stdout.write(`${cli.check} run ${runId}: ${setups.length} providers, out ${out}\n`);

    const { report, failures, cleanupProblems } = await runCheck(
      check,
      setups,
      { runId, out, concurrency: cli.concurrency },
      {
        open: openLiveSession,
        signal: controller.signal,
        progress: (line) => process.stdout.write(`${line}\n`),
      },
    );

    process.stdout.write(`${table(report)}Report: ${paths(out, cli.check).report}\n`);

    for (const failure of failures)
      process.stderr.write(`RUN FAILED ${failure.provider}: ${failure.error}\n`);

    for (const problem of cleanupProblems)
      process.stderr.write(`CLEANUP ${problem.provider}: ${problem.error}\n`);

    if (failures.length > 0 || cleanupProblems.length > 0) process.exitCode = 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
