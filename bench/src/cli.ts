import { readFile } from "node:fs/promises";
import { z } from "zod";
import { snapshotCleaner, snapshotsFromSource } from "./snapshots.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseV2 } from "./v2-config.js";
import { loadProvider } from "./providers.js";
import { runV2, sanitize } from "./v2-runner.js";
import { writeOwnership } from "./ownership.js";
import { collectMetadata } from "./publication.js";
import { writeV2 } from "./v2-report.js";
import { deadline } from "./timing.js";
export async function main() {
  const args = process.argv.slice(2);
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
      "bun bench merge [result-directory ...] [--out results/publication-final] [--exclude run-id] [--seed 45] [--policy path.json] (offline)\nbun bench attempts results/publication-final-v2 (offline)\nbun bench site-data [--report results/publication-final] [--out ../apps/bench-site/src/data/benchmark.json] [--public ../apps/bench-site/public] (offline)\nbun bench [reap] --providers local,e2b,daytona,upstash,boat,boxd,freestyle,tenki --runs 2 --bursts 3\n--omit-network-download true --burst-cohorts 3 --workload-runs N --scenarios all (or comma names) --concurrency 4 --provider-concurrency 1 --seed 45 --timeout-ms 180000\n--max-sandboxes 100 --max-dollars 5 --provider-max-sandboxes boat=50 --provider-max-dollars boat=2 --account-limits tenki=5\n--run RUN_ID --out results/v2 | --v1 for legacy harness\n",
    );
    return;
  }
  const reap = args[0] === "reap";
  if (reap && !args.includes("--run")) throw new Error("reap requires explicit --run");
  const config = parseV2(reap ? args.slice(1) : args);
  const providers = [];
  for (const name of config.providers) {
    try {
      providers.push(await loadProvider(name, process.env, undefined, config));
    } catch (error) {
      providers.push({
        kind: "skipped" as const,
        name,
        note: sanitize(error instanceof Error ? error.message : "Factory failed"),
      });
    }
  }
  if (reap) {
    let failed = false;
    const journalSchema = z.object({
      runId: z.string(),
      resources: z.array(
        z.object({
          provider: z.string(),
          id: z.string(),
          kind: z.enum(["sandbox", "snapshot", "snapshot-source"]),
          parent: z.string().nullable(),
        }),
      ),
    });
    const path = resolve(config.out, "ownership.json");
    const journal = await readFile(path, "utf8")
      .then((v) => journalSchema.parse(JSON.parse(v)))
      .catch((e) => {
        if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return null;
        if (e instanceof SyntaxError || e instanceof z.ZodError) {
          process.stderr.write("Ownership journal is corrupt; recovering only resources with this run's exact label. Snapshot IDs may require manual recovery.\n");
          return null;
        }
        throw e;
      });
    if (journal && journal.runId !== config.run)
      throw new Error("Ownership journal belongs to a different run; use its --out directory");
    for (const p of providers) {
      if (p.kind === "skipped") {
        process.stderr.write(`SKIP ${p.name}: ${p.note}\n`);
        continue;
      }
      const errors: string[] = [];
      const attempt = async (work: () => Promise<void>) => {
        try { await work(); } catch (error) {
          errors.push(sanitize(error instanceof Error ? error.message : "Reap failed"));
        }
      };
      try {
        for (const resource of journal?.resources ?? [])
          if (resource.provider === p.name && resource.kind === "snapshot") await attempt(async () => {
            const clean = await snapshotCleaner(p.name, p.provider, resource.parent ?? "");
            try {
              await deadline(config["timeout-ms"], () => clean(resource.id));
            } catch (error) {
              if (
                !(error instanceof Error && /not.found|404|does not exist/i.test(error.message)) &&
                !(
                  error &&
                  typeof error === "object" &&
                  "code" in error &&
                  error.code === "not_found"
                )
              )
                throw error;
            }
            if (journal) {
              journal.resources = journal.resources.filter((v) => v !== resource);
              await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");
            }
          });
        const ids = new Set((journal?.resources ?? []).filter((v) => v.provider === p.name && v.kind === "sandbox").map((v) => v.id));
        const matches = await deadline(config["timeout-ms"], () =>
          p.provider.list({ "sandbox-bench-run": config.run }),
        ).catch((error) => { errors.push(sanitize(error instanceof Error ? error.message : "List failed")); return []; });
        for (const s of matches)
          if (s.labels["sandbox-bench-run"] === config.run) ids.add(s.id);
        for (const id of ids) await attempt(async () => {
          await deadline(config["timeout-ms"], () => p.provider.destroy(id));
          if (journal) {
            journal.resources = journal.resources.filter((v) => !(v.provider === p.name && v.kind === "sandbox" && v.id === id));
            await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");
          }
        });
        const left = await deadline(config["timeout-ms"], async () => {
          let result = await p.provider.list({ "sandbox-bench-run": config.run });
          while (result.some((s) => s.labels["sandbox-bench-run"] === config.run)) {
            await new Promise((r) => setTimeout(r, 2000));
            result = await p.provider.list({ "sandbox-bench-run": config.run });
          }
          return result;
        });
        for (const resource of journal?.resources ?? []) {
          if (resource.provider !== p.name || resource.kind !== "snapshot-source") continue;
          // An empty listing does not prove deletion when a journal-owned VM failed to delete.
          if (errors.length || journal?.resources.some((v) =>
            v.provider === p.name && v.kind === "sandbox" && v.id === resource.id)) continue;
          await attempt(async () => {
            for (const snapshot of await deadline(config["timeout-ms"], () => snapshotsFromSource(p.name, resource.id))) {
              const clean = await snapshotCleaner(p.name, p.provider, resource.id);
              await deadline(config["timeout-ms"], () => clean(snapshot.id));
            }
            if ((await deadline(config["timeout-ms"], () => snapshotsFromSource(p.name, resource.id))).length) throw new Error("Source snapshots are still deleting; retry reap");
            if (journal) journal.resources = journal.resources.filter((v) => v !== resource);
          });
        }
        if (journal) {
          await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");
        }
        const count = left.filter((s) => s.labels["sandbox-bench-run"] === config.run).length;
        process.stdout.write(`${p.name}: ${count} leftovers for ${config.run}\n`);
        if (count || errors.length) failed = true;
        for (const error of errors) process.stderr.write(`${p.name}: ${error}\n`);
      } catch (error) {
        failed = true;
        process.stderr.write(
          `${p.name}: ${sanitize(error instanceof Error ? error.message : "Reap failed")}\n`,
        );
      }
    }
    if (failed) process.exitCode = 1;
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
    report.cleanup.some((c) => c.error || c.remaining.length)
  )
    process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  process.stderr.write(
    sanitize(error instanceof Error ? error.message : "Benchmark failed") + "\n",
  );
  process.exitCode = 1;
}).finally(async () => {
  // Native SDK event subscriptions can keep a completed CLI alive after a failed operation.
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
    new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
  ]);
  process.exit(process.exitCode ?? 0);
});
