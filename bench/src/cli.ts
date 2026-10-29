import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseV2 } from "./v2-config.js";
import { loadProvider } from "./providers.js";
import { runV2, sanitize } from "./v2-runner.js";
import { collectMetadata } from "./publication.js";
import { writeV2 } from "./v2-report.js";

/** Run the bench CLI. Tests pass `load` to supply providers without importing adapters. */
export async function main(load: typeof loadProvider = loadProvider) {
  const args = process.argv.slice(2);

  if (args[0] === "billing") {
    await (await import("./billing.js")).billingCommand(args.slice(1));

    return;
  }

  if (args[0] === "attempts") {
    await (await import("./attempts.js")).attemptsCommand(args.slice(1));

    return;
  }

  if (args[0] === "merge") {
    const { mergeCommand } = await import("./merge.js");
    await mergeCommand(args.slice(1));

    return;
  }

  if (args[0] === "site-data") {
    const { siteDataCommand } = await import("./site-data.js");
    await siteDataCommand(args.slice(1));

    return;
  }

  if (args.includes("--v1")) {
    process.argv = process.argv.filter((v) => v !== "--v1");
    const legacy = await import("./cli-v1.js");
    await legacy.completion;

    return;
  }

  if (args.includes("--help")) {
    process.stdout.write(
      "bun bench merge [result-directory ...] [--out results/publication-final] [--exclude run-id] [--seed 45] [--policy path.json] (offline)\nbun bench attempts results/publication-final-v2 (offline)\nbun bench site-data [--report results/publication-final] [--out ../apps/bench-site/src/data/benchmark.json] [--public ../apps/bench-site/public] (offline)\nbun bench [reap] --providers local,e2b,daytona,upstash,boat,boxd,freestyle,tenki --runs 2 --bursts 3\n--omit-network-download true --burst-cohorts 3 --workload-runs N --scenarios all (or comma names) --concurrency 4 --provider-concurrency 1 --seed 45 --timeout-ms 180000 --ownership-visibility-ms 120000\n--max-sandboxes 100 --max-dollars 5 --provider-max-sandboxes boat=50 --provider-max-dollars boat=2 --account-limits tenki=5\n--run RUN_ID --out results/v2 | --v1 for legacy harness\n",
    );

    return;
  }

  const reap = args[0] === "reap";

  if (reap && !args.includes("--run")) throw new Error("reap requires explicit --run");
  const config = parseV2(reap ? args.slice(1) : args);
  const providers = [];

  for (const name of config.providers) {
    try {
      providers.push(await load(name, process.env, undefined, config));
    } catch (error) {
      providers.push({
        kind: "skipped" as const,
        name,
        note: sanitize(error instanceof Error ? error.message : "Factory failed"),
      });
    }
  }

  if (reap) {
    const { reapRun } = await import("./recovery.js");

    if (await reapRun(providers, config, sanitize)) process.exitCode = 1;

    return;
  }

  const out = resolve(config.out);
  const report = await runV2(providers, config, (r) => writeV2(r, out), collectMetadata(true));
  process.stdout.write(
    `Run ${report.runId}; ${report.samples.length} observations; reports: ${out}\n`,
  );

  for (const p of report.providers) process.stdout.write(`${p.name}: ${p.kind} ${p.note}\n`);

  if (
    !providers.some((p) => p.kind === "ready") ||
    report.samples.some((s) => s.outcome.kind === "failure") ||
    (report.admissionStopped?.length ?? 0) > 0 ||
    (report.cleanupReview?.length ?? 0) > 0 ||
    report.cleanup.some((c) => c.error || c.remaining.length)
  )
    process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .catch((error) => {
      process.stderr.write(
        sanitize(error instanceof Error ? error.message : "Benchmark failed") + "\n",
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      // Native SDK event subscriptions can keep a completed CLI alive after a failed operation.
      await Promise.all([
        new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
        new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
      ]);
      process.exit(process.exitCode ?? 0);
    });
