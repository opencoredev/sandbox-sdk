import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ConfigV2 } from "./v2-config.js";
import type { LoadedProvider } from "./providers.js";
import {
  recordAbsentResolution,
  recordVerifiedRelease,
  hasRunOwnership,
  verifyRunOwnership,
  writeOwnership,
  type CleanupReview,
  type CleanupRelease,
  type CleanupResolution,
  snapshotProvenanceSchema,
} from "./ownership.js";
import { isAbsent, lookupSandbox, lookupSchema } from "./existence.js";
import { DeadlineError, DeletionWork, deadline } from "./timing.js";
import { snapshotsFromSource, deleteProvenSnapshot } from "./snapshots.js";
import { isMissingFile } from "./files.js";

/** results.json is rewritten with updated cleanup fields; everything else is kept as read. */
const resultsSchema = z.record(z.string(), z.json());

const resource = z.object({
  provider: z.string(),
  id: z.string(),
  kind: z.enum(["sandbox", "snapshot", "snapshot-source"]),
  parent: z.string().nullable(),
  snapshotProof: snapshotProvenanceSchema.optional(),
});

const reviewSchema = resource
  .omit({ parent: true, snapshotProof: true })
  .extend({ reason: z.string(), status: z.enum(["checking", "unresolved"]).optional() });

/** Recovery never treats a journal ID as permission to delete. */
export async function reapRun(
  providers: LoadedProvider[],
  config: ConfigV2,
  sanitize: (value: string) => string,
) {
  const path = join(config.out, "ownership.json");
  let journal: { runId: string; resources: z.infer<typeof resource>[] } | null = null;

  try {
    journal = z
      .object({ runId: z.string(), resources: z.array(resource) })
      .parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!isMissingFile(error)) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      process.stderr.write(
        "Ownership journal is corrupt; recovering only resources with this run's exact label and SDK marker. Snapshot IDs may require manual recovery.\n",
      );
    }
  }

  if (journal && journal.runId !== config.run)
    throw new Error("Ownership journal belongs to a different run; use its --out directory");
  let results: z.infer<typeof resultsSchema> | null = null;

  try {
    results = resultsSchema.parse(
      JSON.parse(await readFile(join(config.out, "results.json"), "utf8")),
    );
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const reviews: CleanupReview[] = z.array(reviewSchema).parse(results?.cleanupReview ?? []);

  const releases: CleanupRelease[] = z
    .array(reviewSchema.extend({ releasedAt: z.string(), proof: z.literal("live-run-sdk-labels") }))
    .parse(results?.cleanupReleased ?? []);

  const resolutions: CleanupResolution[] = z
    .array(reviewSchema.extend({ resolution: z.literal("absent"), evidence: lookupSchema }))
    .parse(results?.cleanupResolved ?? []);

  const review = (provider: string, id: string, kind: CleanupReview["kind"], reason: string) => {
    if (!reviews.some((r) => r.provider === provider && r.id === id && r.kind === kind))
      reviews.push({ provider, id: sanitize(id), kind, reason });
  };

  let failed = false;
  const deletions = new DeletionWork();

  for (const p of providers) {
    if (p.kind === "skipped") {
      process.stderr.write(`SKIP ${p.name}: ${p.note}\n`);
      continue;
    }

    const errors: string[] = [];
    const deletionErrors = new Map<string, string>();

    const resolveAbsent = async (id: string) => {
      await deletions.wait(p.name, id, Math.min(config["timeout-ms"] / 2, 30_000));
      const evidence = await lookupSandbox(p.provider, id, config["timeout-ms"]);

      if (!isAbsent(evidence)) {
        for (const item of reviews)
          if (item.provider === p.name && item.id === id && item.kind === "sandbox")
            item.status = "unresolved";

        return false;
      }

      recordAbsentResolution(reviews, resolutions, p.name, id, evidence);
      deletionErrors.delete(id);

      if (journal) {
        journal.resources = journal.resources.filter(
          (r) => !(r.provider === p.name && r.id === id && r.kind === "sandbox"),
        );
        await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");
      }

      return true;
    };

    const owned = async (id: string) =>
      verifyRunOwnership(
        p.provider,
        id,
        config.run,
        config["timeout-ms"],
        config["ownership-visibility-ms"],
      );

    const forget = async (entry: z.infer<typeof resource>) => {
      if (journal) {
        journal.resources = journal.resources.filter((r) => r !== entry);
        await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");
      }

      for (const item of reviews.filter(
        (r) => r.provider === entry.provider && r.id === entry.id && r.kind === entry.kind,
      ))
        reviews.splice(reviews.indexOf(item), 1);
    };

    const candidates = new Set(
      [...(journal?.resources ?? []), ...reviews].flatMap((r) =>
        r.provider === p.name && r.kind === "sandbox" ? [r.id] : [],
      ),
    );

    try {
      for (const info of await deadline(config["timeout-ms"], () =>
        p.provider.list({ "sandbox-bench-run": config.run, "sandbox-sdk": "1" }),
      ))
        if (hasRunOwnership(info, config.run)) candidates.add(info.id);
    } catch (error) {
      errors.push(sanitize(error instanceof Error ? error.message : "List failed"));
    }

    const deleteCandidate = async (id: string) => {
      if (!(await owned(id))) {
        if (!(await resolveAbsent(id)))
          review(
            p.name,
            id,
            "sandbox",
            "Live run label and SDK ownership marker unverified; no deletion attempted",
          );

        return;
      }

      try {
        if (reviews.some((r) => r.provider === p.name && r.id === id && r.kind === "sandbox")) {
          journal ??= { runId: config.run, resources: [] };

          if (
            !journal.resources.some(
              (r) => r.provider === p.name && r.id === id && r.kind === "sandbox",
            )
          )
            journal.resources.push({ provider: p.name, id, kind: "sandbox", parent: null });
          await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");
          recordVerifiedRelease(reviews, releases, p.name, id);
        }

        await deadline(config["timeout-ms"], () =>
          deletions.start(p.name, id, () => p.provider.destroy(id)),
        );

        for (const entry of journal?.resources ?? [])
          if (entry.provider === p.name && entry.kind === "sandbox" && entry.id === id)
            await forget(entry);
      } catch (error) {
        if (error instanceof DeadlineError && (await resolveAbsent(id))) return;
        review(
          p.name,
          id,
          "sandbox",
          "Deletion failed or timed out; exact existence remains unresolved",
        );
        deletionErrors.set(id, sanitize(error instanceof Error ? error.message : "Reap failed"));
      }
    };

    const sources = new Set(
      (journal?.resources ?? [])
        .filter((r) => r.provider === p.name && r.kind !== "sandbox")
        .flatMap((r) => (r.kind === "snapshot-source" ? [r.id] : r.parent ? [r.parent] : [])),
    );

    for (const id of candidates) if (!sources.has(id)) await deleteCandidate(id);

    const restoresUnresolved = [...candidates].some(
      (id) =>
        !sources.has(id) &&
        ((journal?.resources ?? []).some(
          (r) => r.provider === p.name && r.id === id && r.kind === "sandbox",
        ) ||
          reviews.some((r) => r.provider === p.name && r.id === id && r.kind === "sandbox")),
    );

    // Source-scoped discovery uses durable proof, even when the source no longer exists.
    for (const entry of journal?.resources ?? []) {
      if (entry.provider !== p.name || entry.kind !== "snapshot-source") continue;

      try {
        if (restoresUnresolved)
          throw new Error("Restore cleanup unresolved; snapshot and source retained");
        const proof = snapshotProvenanceSchema.parse(entry.snapshotProof);

        if (proof.sourceId !== entry.id || proof.runLabel !== config.run)
          throw new Error("Snapshot-source provenance mismatch");

        for (const snapshot of await deadline(config["timeout-ms"], () =>
          snapshotsFromSource(p.name, entry.id),
        )) {
          const item = {
            provider: p.name,
            id: snapshot.id,
            kind: "snapshot" as const,
            parent: entry.id,
            snapshotProof: proof,
          };

          journal?.resources.push(item);
          await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");
          await deleteProvenSnapshot(
            p.name,
            p.provider,
            item.id,
            item.parent,
            proof,
            config.run,
            config["timeout-ms"],
          );
          await forget(item);
        }

        await forget(entry);
      } catch (error) {
        review(
          p.name,
          entry.id,
          entry.kind,
          sanitize(error instanceof Error ? error.message : "Snapshot recovery failed"),
        );
      }
    }

    for (const entry of journal?.resources ?? []) {
      if (entry.provider !== p.name || entry.kind !== "snapshot") continue;

      try {
        if (restoresUnresolved)
          throw new Error("Restore cleanup unresolved; snapshot and source retained");
        await deleteProvenSnapshot(
          p.name,
          p.provider,
          entry.id,
          entry.parent,
          entry.snapshotProof,
          config.run,
          config["timeout-ms"],
        );
        await forget(entry);
      } catch (error) {
        review(
          p.name,
          entry.id,
          entry.kind,
          sanitize(error instanceof Error ? error.message : "Snapshot recovery failed"),
        );
      }
    }

    for (const id of candidates)
      if (sources.has(id)) {
        const held = (journal?.resources ?? []).some(
          (r) => r.provider === p.name && r.kind !== "sandbox" && (r.parent === id || r.id === id),
        );

        if (!held) await deleteCandidate(id);
        else if (!(await owned(id)) && !(await resolveAbsent(id)))
          review(
            p.name,
            id,
            "sandbox",
            "Source retained for snapshot recovery; live ownership unverified",
          );
      }

    // oxlint-disable-next-line unicorn/no-useless-spread -- resolving removes reviews while iterating.
    for (const item of [...reviews])
      if (item.provider === p.name && item.kind === "sandbox") await resolveAbsent(item.id);
    let count = 0;

    try {
      await deadline(config["timeout-ms"], async (signal) => {
        for (;;) {
          if (signal.aborted) return;

          const left = await p.provider.list({
            "sandbox-bench-run": config.run,
            "sandbox-sdk": "1",
          });

          count = left.filter((s) => hasRunOwnership(s, config.run)).length;

          if (
            !count ||
            left
              .filter((s) => hasRunOwnership(s, config.run))
              .every(
                (s) =>
                  sources.has(s.id) || reviews.some((r) => r.provider === p.name && r.id === s.id),
              )
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
    } catch (error) {
      errors.push(sanitize(error instanceof Error ? error.message : "Final list failed"));
    }

    process.stdout.write(`${p.name}: ${count} leftovers for ${config.run}\n`);
    errors.push(...deletionErrors.values());

    if (count || errors.length) failed = true;

    for (const error of errors) process.stderr.write(`${p.name}: ${error}\n`);
  }

  for (const entry of reviews) process.stderr.write(`cleanupReview: ${JSON.stringify(entry)}\n`);

  for (const entry of releases) process.stdout.write(`cleanupReleased: ${JSON.stringify(entry)}\n`);

  for (const entry of resolutions)
    process.stdout.write(`cleanupResolved: ${JSON.stringify(entry)}\n`);

  if (results || reviews.length || releases.length || resolutions.length) {
    const record = {
      ...(results ?? { runId: config.run }),
      cleanupReview: reviews,
      cleanupReleased: releases,
      cleanupResolved: resolutions,
    };

    await writeOwnership(join(config.out, "results.json"), JSON.stringify(record, null, 2) + "\n");
  }

  if (reviews.length || releases.length || resolutions.length) {
    const md = await readFile(join(config.out, "results.md"), "utf8").catch(() => "");
    await writeFile(
      join(config.out, "results.md"),
      md.replace(/^cleanup(?:Review|Released|Resolved):.*\n/gm, "") +
        `\ncleanupReview: ${JSON.stringify(reviews)}\ncleanupReleased: ${JSON.stringify(releases)}\ncleanupResolved: ${JSON.stringify(resolutions)}\n`,
    );
  }

  return failed || reviews.length > 0;
}
