import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ConfigV2 } from "./v2-config.js";
import type { LoadedProvider } from "./providers.js";
import { hasRunOwnership, verifyRunOwnership, writeOwnership, type CleanupReview } from "./ownership.js";
import { deadline } from "./timing.js";
import { snapshotCleaner, snapshotsFromSource } from "./snapshots.js";
const resource = z.object({provider: z.string(), id: z.string(), kind: z.enum(["sandbox", "snapshot", "snapshot-source"]), parent: z.string().nullable()});
const reviewSchema = resource.omit({parent: true}).extend({reason: z.string()});

/** Recovery never treats a journal ID as permission to delete. */
export async function reapRun(providers: LoadedProvider[], config: ConfigV2, sanitize: (value: string) => string) {
  const path = join(config.out, "ownership.json");
  let journal: {runId: string; resources: z.infer<typeof resource>[]} | null = null;
  try { journal = z.object({runId: z.string(), resources: z.array(resource)}).parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      process.stderr.write("Ownership journal is corrupt; recovering only resources with this run's exact label and SDK marker. Snapshot IDs may require manual recovery.\n");
    }
  }
  if (journal && journal.runId !== config.run) throw new Error("Ownership journal belongs to a different run; use its --out directory");
  let results: Record<string, unknown> | null = null;
  try { results = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(config.out, "results.json"), "utf8"))); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
  const reviews: CleanupReview[] = z.array(reviewSchema).parse(results?.cleanupReview ?? []);
  const review = (provider: string, id: string, kind: CleanupReview["kind"], reason: string) => {
    if (!reviews.some(r => r.provider === provider && r.id === id && r.kind === kind)) reviews.push({provider, id: sanitize(id), kind, reason});
  };
  let failed = false;
  for (const p of providers) {
    if (p.kind === "skipped") { process.stderr.write(`SKIP ${p.name}: ${p.note}\n`); continue; }
    const errors: string[] = [];
    const owned = async (id: string) => verifyRunOwnership(p.provider, id, config.run, config["timeout-ms"]);
    const forget = async (entry: z.infer<typeof resource>) => {
      if (journal) {journal.resources = journal.resources.filter(r => r !== entry); await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");}
    };
    // Recover snapshots while the source is still live and its labels can be checked.
    for (const entry of journal?.resources ?? []) {
      if (entry.provider !== p.name || entry.kind === "sandbox" || reviews.some(r => r.provider === p.name && r.id === entry.id && r.kind === entry.kind)) continue;
      const parent = entry.kind === "snapshot-source" ? entry.id : entry.parent;
      if (!parent || !(await owned(parent))) {review(p.name, entry.id, entry.kind, "Live snapshot-parent run/SDK labels unverified; no deletion attempted"); continue;}
      if (!["daytona", "superserve"].includes(p.name)) {review(p.name, entry.id, entry.kind, "No source-scoped snapshot metadata verifier available; no deletion attempted"); continue;}
      try {
        const linked = await deadline(config["timeout-ms"], () => snapshotsFromSource(p.name, parent));
        if (entry.kind === "snapshot" && !linked.some(s => s.id === entry.id || s.name === entry.id)) {review(p.name, entry.id, entry.kind, "Snapshot is not verified as belonging to the labelled source; no deletion attempted"); continue;}
        const cleaner = await snapshotCleaner(p.name, p.provider, parent);
        const ids = entry.kind === "snapshot" ? [entry.id] : linked.map(s => s.id);
        for (const id of ids) {
          if (!(await owned(parent))) throw new Error("Snapshot parent ownership changed; no further deletion attempted");
          await deadline(config["timeout-ms"], () => cleaner(id));
        }
        await forget(entry);
      } catch (error) {errors.push(sanitize(error instanceof Error ? error.message : "Snapshot recovery failed"));}
    }
    const candidates = new Set((journal?.resources ?? []).filter(r => r.provider === p.name && r.kind === "sandbox").map(r => r.id));
    try {
      for (const info of await deadline(config["timeout-ms"], () => p.provider.list({"sandbox-bench-run": config.run, "sandbox-sdk": "1"})))
        if (hasRunOwnership(info, config.run)) candidates.add(info.id);
    } catch (error) {errors.push(sanitize(error instanceof Error ? error.message : "List failed"));}
    for (const id of candidates) {
      if (reviews.some(r => r.provider === p.name && r.id === id)) continue;
      if (!(await owned(id))) {review(p.name, id, "sandbox", "Live run label and SDK ownership marker unverified; no deletion attempted"); continue;}
      try {
        await deadline(config["timeout-ms"], () => p.provider.destroy(id));
        for (const entry of journal?.resources ?? []) if (entry.provider === p.name && entry.kind === "sandbox" && entry.id === id) await forget(entry);
      } catch (error) {errors.push(sanitize(error instanceof Error ? error.message : "Reap failed"));}
    }
    let count = 0;
    try {
      await deadline(config["timeout-ms"], async signal => {
        for (;;) {
          if (signal.aborted) return;
          const left = await p.provider.list({"sandbox-bench-run": config.run, "sandbox-sdk": "1"});
          count = left.filter(s => hasRunOwnership(s, config.run)).length;
          if (!count || left.filter(s => hasRunOwnership(s, config.run)).every(s => reviews.some(r => r.provider === p.name && r.id === s.id))) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      });
    } catch (error) {errors.push(sanitize(error instanceof Error ? error.message : "Final list failed"));}
    process.stdout.write(`${p.name}: ${count} leftovers for ${config.run}\n`);
    if (count || errors.length) failed = true;
    for (const error of errors) process.stderr.write(`${p.name}: ${error}\n`);
  }
  for (const entry of reviews) process.stderr.write(`cleanupReview: ${JSON.stringify(entry)}\n`);
  if (results || reviews.length) {
    const record = results ?? {runId: config.run};
    record.cleanupReview = reviews;
    await writeOwnership(join(config.out, "results.json"), JSON.stringify(record, null, 2) + "\n");
  }
  if (reviews.length) {
    const md = await readFile(join(config.out, "results.md"), "utf8").catch(() => "");
    await writeFile(join(config.out, "results.md"), md.replace(/^cleanupReview:.*\n/gm, "") + `\ncleanupReview: ${JSON.stringify(reviews)}\n`);
  }
  return failed || reviews.length > 0;
}
