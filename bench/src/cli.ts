import { cpus, totalmem, platform, release, arch } from "node:os";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { parseConfig } from "./config.js";
import { loadProvider, checkBudget } from "./providers.js";
import { measureProvider } from "./runner.js";
import { markdown, writeReport } from "./report.js";
import type { Report } from "./model.js";

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(
      "bun bench --providers memory,local,e2b,vercel,daytona --runs 50 --out results/\nOptions: --warmup 2 --concurrency 1 --timeout-ms 30000 --max-sandboxes 100 --yes\nOutput paths are relative to bench/. Cloud budget includes warmups.\n",
    );
    return;
  }
  const config = parseConfig(process.argv.slice(2));
  const providers = [];
  for (const name of config.providers) {
    const provider = await loadProvider(name);
    providers.push(provider);
    if (provider.kind === "skipped") process.stderr.write(`SKIP ${name}: ${provider.note}\n`);
  }
  const plannedCloudSandboxes = checkBudget(providers, config);
  const versionData: unknown = JSON.parse(
    await readFile(new URL("../../packages/sdk/package.json", import.meta.url), "utf8"),
  );
  const { version } = z.object({ version: z.string() }).parse(versionData);
  const report: Report = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    sdkVersion: version,
    machine: {
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      ramBytes: totalmem(),
      os: `${platform()} ${release()}`,
      arch: arch(),
      runtime: `Bun ${process.versions.bun ?? "unknown"} (Node API ${process.versions.node})`,
    },
    config,
    plannedCloudSandboxes,
    methodology: {
      percentiles:
        "Nearest rank; successful measured samples only. Warmups excluded. Null statistics mean no successful samples.",
      cold: "Fresh sandbox create through first successful true command; includes SDK initialization, excludes provider module/factory load. Image/cache state is provider controlled.",
      files:
        "Binary 1024 and 10485760 bytes; combined write+read with byte equality validation included in timing.",
      cpu: "100 mocked-native calls per batch; process.cpuUsage user+system / 100 in ms/call. SDK minus raw is paired per batch; order alternates; serial after latency workers. Includes SDK bookkeeping, excludes fixture setup. Other host activity, GC and JIT can add noise.",
    },
    providers: [],
  };
  let unsafeCleanup = false;
  for (const provider of providers) {
    if (unsafeCleanup) {
      report.providers.push({
        kind: "skipped",
        name: provider.name,
        note: "Previous provider cleanup was unsafe; run stopped",
      });
      continue;
    }
    if (provider.kind === "skipped") report.providers.push(provider);
    else {
      process.stderr.write(
        `RUN ${provider.name}: ${config.runs} runs + ${config.warmup} warmups\n`,
      );
      const measured = await measureProvider(provider, config);
      report.providers.push(measured);
      unsafeCleanup = measured.cleanupFailures.length > 0;
    }
  }
  await writeReport(report, resolve(config.out));
  process.stdout.write(markdown(report));
  process.stderr.write(`Reports: ${resolve(config.out)}\n`);
  if (
    !providers.some((provider) => provider.kind === "ready") ||
    report.providers.some(
      (provider) =>
        provider.kind === "measured" &&
        (provider.cleanupFailures.length ||
          provider.warmupFailures.length ||
          provider.metrics.some((metric) => metric.failures.length)),
    )
  )
    process.exitCode = 1;
}
main().catch((error) => {
  process.stderr.write(
    `Benchmark refused/failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
  );
  process.exitCode = 1;
});
