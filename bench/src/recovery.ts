import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ConfigV2 } from "./v2-config.js";
import type { LoadedProvider } from "./providers.js";
import { sleepingUnchecked } from "./sleeping.js";
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
import { snapshotsFromSource, deleteProvenSnapshot, settleJournaledSnapshot } from "./snapshots.js";
import { isMissingFile } from "./files.js";
import { cleanService, isRetrySlug, settleAllocationAttempt, tierLabel } from "./microsandbox.js";
import { microsandboxTier } from "./providers.js";
import { recordStop, stopJournalFile } from "./stops.js";
import {
  ambiguousAllocations,
  journalAppSchema,
  pendingForRun,
  prepareJournaledApps,
  reconcileDiscovered,
  type JournalApp,
} from "./modal-apps.js";

/** results.json is rewritten with updated cleanup fields; everything else is kept as read. */
const resultsSchema = z.record(z.string(), z.json());

const resource = z.object({
  provider: z.string(),
  id: z.string(),
  kind: z.enum(["sandbox", "snapshot", "snapshot-source", "allocation-attempt", "service"]),
  parent: z.string().nullable(),
  snapshotProof: snapshotProvenanceSchema.optional(),
  /** A Maritime save's idempotency key: present only while that save is unsettled. */
  idempotencyKey: z.string().optional(),
  /** A Microsandbox create's allocation marker, its restore source and when it was journaled. */
  allocId: z.string().optional(),
  sourceId: z.string().nullable().optional(),
  attemptedAt: z.string().optional(),
  /** The sandbox name a Microsandbox Service targets. */
  sandboxName: z.string().optional(),
  /** A Microsandbox Service's create: `created` once confirmed; absent (older journals) is `pending`. */
  serviceState: z.enum(["pending", "created"]).optional(),
  /** A Microsandbox capture's name; equal to `id` while unconfirmed. */
  snapshotName: z.string().optional(),
});

const reviewSchema = resource
  .pick({ provider: true, id: true, kind: true })
  .extend({ reason: z.string(), status: z.enum(["checking", "unresolved"]).optional() });

/** Recovery never treats a journal ID as permission to delete. */
export async function reapRun(
  providers: LoadedProvider[],
  config: ConfigV2,
  sanitize: (value: string) => string,
) {
  const path = join(config.out, "ownership.json");

  let journal: {
    runId: string;
    resources: z.infer<typeof resource>[];
    apps: JournalApp[];
  } | null = null;

  try {
    journal = z
      .object({
        runId: z.string(),
        resources: z.array(resource),
        // Older journals have no Apps: every sandbox is in the adapter's default App.
        apps: z.array(journalAppSchema).default([]),
      })
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

    /** Polls the exact lookup until it reads absent, within the run's timeout; false if it never does. */
    const confirmGone = async (id: string) => {
      const end = performance.now() + config["timeout-ms"];

      for (let backoffMs = 100; ; backoffMs = Math.min(backoffMs * 2, 2000)) {
        if (isAbsent(await lookupSandbox(p.provider, id, config["timeout-ms"]))) return true;
        const left = end - performance.now();

        if (left <= 0) return false;
        await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, left)));
      }
    };

    // Restores still tagged pending: owned by the exact tag read that listed them (Modal).
    const pendingOwned = new Set<string>();

    // A Microsandbox tier sweeps only its own tier's sandboxes: the adapter checks compute.type, and
    // the bench's tier label must match too, in every listing and in each exact ownership check.
    const tier = microsandboxTier(p.name);

    const owned = async (id: string) =>
      pendingOwned.has(id) ||
      verifyRunOwnership(
        p.provider,
        id,
        config.run,
        config["timeout-ms"],
        config["ownership-visibility-ms"],
        { tier },
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

    // A fresh process lists only the Apps it knows: prepare every journaled one (Modal) before
    // the listings that discover candidates and prove ownership. None is created here.
    try {
      await deadline(config["timeout-ms"], () =>
        prepareJournaledApps(p.provider, journal?.apps ?? []),
      );
    } catch (error) {
      errors.push(sanitize(error instanceof Error ? error.message : "App lookup failed"));
    }

    const journaled = (journal?.apps ?? []).filter((app) => app.provider === p.name);
    let reconciled = false;

    const runLabels = { "sandbox-bench-run": config.run, "sandbox-sdk": "1" };

    const sweepLabels = tier === undefined ? runLabels : { ...runLabels, [tierLabel]: tier };

    try {
      for (const info of await deadline(config["timeout-ms"], () => p.provider.list(sweepLabels)))
        if (hasRunOwnership(info, config.run, tier)) {
          candidates.add(info.id);
          // A sandbox whose create response was lost joins its App's journal entry.
          reconciled = reconcileDiscovered(journaled, p.name, info) || reconciled;
        }
    } catch (error) {
      errors.push(sanitize(error instanceof Error ? error.message : "List failed"));
    }

    // A restore allocated before its creator stopped stays tagged pending, so the listing above
    // never shows it. Journal each one before deleting it, so a crash here leaves a record too.
    try {
      for (const item of await deadline(config["timeout-ms"], () =>
        pendingForRun(p.provider, config.run),
      )) {
        pendingOwned.add(item.id);
        candidates.add(item.id);
        reconciled = reconcileDiscovered(journaled, p.name, item) || reconciled;
        journal ??= { runId: config.run, resources: [], apps: [] };

        if (
          !journal.resources.some(
            (r) => r.provider === p.name && r.id === item.id && r.kind === "sandbox",
          )
        ) {
          journal.resources.push({ provider: p.name, id: item.id, kind: "sandbox", parent: null });
          reconciled = true;
        }
      }
    } catch (error) {
      errors.push(sanitize(error instanceof Error ? error.message : "Pending listing failed"));
    }

    // Microsandbox creates journaled before they were sent: a sandbox carrying the attempt's marker
    // becomes a candidate, and anything else (a 404 however old, an unresolved spec, another marker)
    // stays under review, keeping a restore's snapshot and source.
    let attemptsUnresolved = false;

    for (const entry of (journal?.resources ?? []).filter(
      (r) => r.provider === p.name && r.kind === "allocation-attempt",
    )) {
      try {
        if (tier === undefined) throw new Error("Allocation attempt for a provider without them");

        const outcome = await deadline(config["timeout-ms"], () =>
          settleAllocationAttempt(
            {
              id: entry.id,
              allocId: entry.allocId,
              attemptedAt: entry.attemptedAt,
            },
            tier,
          ),
        );

        if (outcome.kind === "pending") {
          review(p.name, entry.id, "allocation-attempt", outcome.reason);

          if (entry.parent !== null) attemptsUnresolved = true;
          continue;
        }

        candidates.add(outcome.id);

        if (journal) {
          journal.resources = journal.resources.filter((r) => r !== entry);
          journal.resources.push({
            provider: p.name,
            id: outcome.id,
            kind: "sandbox",
            parent: null,
          });
          reconciled = true;
        }
      } catch (error) {
        review(
          p.name,
          entry.id,
          "allocation-attempt",
          sanitize(error instanceof Error ? error.message : "Allocation attempt lookup failed"),
        );

        if (entry.parent !== null) attemptsUnresolved = true;
      }
    }

    if (journal && reconciled) await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");

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
          journal ??= { runId: config.run, resources: [], apps: [] };

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

        // Microsandbox finishes a DELETE asynchronously: the sandbox, and so a restore's hold on its
        // snapshot and source, stays journaled until an exact read confirms it is gone.
        if (tier !== undefined && !(await confirmGone(id))) {
          review(
            p.name,
            id,
            "sandbox",
            "Deletion accepted, but the sandbox still reads; kept until an exact read confirms it is gone",
          );

          return;
        }

        // Billing settles a Modal App only after its sandbox's confirmed stop.
        await recordStop({
          path: join(config.out, stopJournalFile),
          provider: p.name,
          sandboxId: id,
        }).catch(() => {});

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
        .filter(
          (r) => r.provider === p.name && (r.kind === "snapshot" || r.kind === "snapshot-source"),
        )
        .flatMap((r) => (r.kind === "snapshot-source" ? [r.id] : r.parent ? [r.parent] : [])),
    );

    // An unresolved restore attempt keeps its source sandbox too.
    for (const r of journal?.resources ?? [])
      if (r.provider === p.name && r.kind === "allocation-attempt" && r.sourceId)
        sources.add(r.sourceId);

    for (const id of candidates) if (!sources.has(id)) await deleteCandidate(id);

    const restoresUnresolved =
      attemptsUnresolved ||
      [...candidates].some(
        (id) =>
          !sources.has(id) &&
          ((journal?.resources ?? []).some(
            (r) => r.provider === p.name && r.id === id && r.kind === "sandbox",
          ) ||
            reviews.some((r) => r.provider === p.name && r.id === id && r.kind === "sandbox")),
      );

    // Microsandbox Services journaled before they were made, deleted whether or not their sandbox is
    // gone, and only while they target that sandbox or nothing; others are never touched.
    const services = (journal?.resources ?? []).filter(
      (r) => r.provider === p.name && r.kind === "service",
    );

    for (const entry of services) {
      try {
        const outcome = await deadline(config["timeout-ms"], () =>
          cleanService({
            id: entry.id,
            parent: entry.parent,
            sandboxName: entry.sandboxName,
            state: entry.serviceState ?? "pending",
            superseded: services.some(
              (other) => other.parent === entry.parent && isRetrySlug(other.id, entry.id),
            ),
          }),
        );

        if (outcome.kind === "pending") {
          review(p.name, entry.id, entry.kind, outcome.reason);
          continue;
        }

        await forget(entry);
      } catch (error) {
        review(
          p.name,
          entry.id,
          entry.kind,
          sanitize(error instanceof Error ? error.message : "Service cleanup failed"),
        );
      }
    }

    // Source-scoped discovery uses durable proof, even when the source no longer exists.
    for (const entry of journal?.resources ?? []) {
      if (entry.provider !== p.name || entry.kind !== "snapshot-source") continue;

      try {
        if (restoresUnresolved)
          throw new Error("Restore cleanup unresolved; snapshot and source retained");
        const proof = snapshotProvenanceSchema.parse(entry.snapshotProof);

        if (proof.sourceId !== entry.id || proof.runLabel !== config.run)
          throw new Error("Snapshot-source provenance mismatch");

        const journaled = new Set(
          (journal?.resources ?? [])
            .filter((r) => r.provider === p.name && r.kind === "snapshot" && r.parent === entry.id)
            .map((r) => r.id),
        );

        for (const snapshot of await deadline(config["timeout-ms"], () =>
          snapshotsFromSource(p.name, entry.id, journaled),
        )) {
          const item = {
            provider: p.name,
            id: snapshot.id,
            kind: "snapshot" as const,
            parent: entry.id,
            snapshotProof: proof,
          };

          // Entries already journaled for this snapshot, such as a Maritime save still pending with its
          // idempotency key. Replace them with the confirmed snapshot entry BEFORE deleting: if the
          // delete succeeds on the server and drops its response, a later step must inspect/delete the
          // snapshot rather than replaying the save POST.
          const earlier = (journal?.resources ?? []).filter(
            (r) => r.provider === p.name && r.kind === "snapshot" && r.id === snapshot.id,
          );

          const previousResources = journal ? [...journal.resources] : null;

          if (journal) {
            journal.resources = journal.resources.filter((r) => !earlier.includes(r));
            journal.resources.push(item);
          }

          try {
            await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");
          } catch (error) {
            if (journal && previousResources) journal.resources = previousResources;
            throw error;
          }

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

    for (const entry of (journal?.resources ?? []).filter(
      (r) => r.provider === p.name && r.kind === "snapshot",
    )) {
      try {
        if (restoresUnresolved)
          throw new Error("Restore cleanup unresolved; snapshot and source retained");

        const settled = await settleJournaledSnapshot(p.name, entry, config["timeout-ms"]);

        if (settled.kind === "exists") {
          let confirmed = entry;

          // A Maritime save's key goes once it settles; a Microsandbox capture's name gives way to the
          // managed ID settlement confirmed, journaled before the delete so a by-name 404 can never
          // drop the snapshot it found.
          if (entry.idempotencyKey !== undefined || settled.id !== entry.id) {
            const { idempotencyKey: _, ...withoutKey } = entry;
            confirmed = { ...withoutKey, id: settled.id };

            if (journal) {
              const previousResources = [...journal.resources];
              journal.resources = journal.resources.map((r) => (r === entry ? confirmed : r));

              try {
                await writeOwnership(path, JSON.stringify(journal, null, 2) + "\n");
              } catch (error) {
                journal.resources = previousResources;
                throw error;
              }
            }
          }

          await deleteProvenSnapshot(
            p.name,
            p.provider,
            confirmed.id,
            confirmed.parent,
            confirmed.snapshotProof,
            config.run,
            config["timeout-ms"],
          );
          await forget(confirmed);
        } else {
          await forget(entry);
        }
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
          (r) =>
            r.provider === p.name &&
            (((r.kind === "snapshot" || r.kind === "snapshot-source") &&
              (r.parent === id || r.id === id)) ||
              (r.kind === "allocation-attempt" && r.sourceId === id)),
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

    // Copy first: resolving removes reviews while iterating.
    for (const item of Array.from(reviews))
      if (item.provider === p.name && item.kind === "sandbox") await resolveAbsent(item.id);
    let count = 0;

    try {
      await deadline(config["timeout-ms"], async (signal) => {
        for (;;) {
          if (signal.aborted) return;

          const [listed, pending] = await Promise.all([
            p.provider.list(sweepLabels),
            pendingForRun(p.provider, config.run),
          ]);

          // A pending restore still running is a leftover like any other.
          const left = [...listed.filter((s) => hasRunOwnership(s, config.run, tier)), ...pending];

          count = left.length;

          if (
            !count ||
            left.every(
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

    // A sleeping machine whose labels are only in its guest is invisible to list(), and reading
    // it would wake it, billed, whoever owns it. It may be this run's, so it is never counted as
    // no leftover: name it and fail, and a person decides.
    let asleep: string[] = [];

    try {
      const { provider } = p;

      asleep = await deadline(config["timeout-ms"], () => sleepingUnchecked(provider));
    } catch (error) {
      errors.push(sanitize(error instanceof Error ? error.message : "Sleeping listing failed"));
    }

    if (asleep.length)
      errors.push(
        `${asleep.length} sleeping machines could not be checked for ${config.run} without waking them: ${asleep.join(", ")}`,
      );

    process.stdout.write(
      `${p.name}: ${count} leftovers for ${config.run}${asleep.length ? `, ${asleep.length} sleeping machines unchecked` : ""}\n`,
    );

    // Creates whose outcome is still unknown stay journaled: no listing has tied a sandbox to
    // them, so their App's charge is never attributed to one sandbox.
    for (const app of journaled)
      if (ambiguousAllocations(app))
        process.stdout.write(
          `unresolvedAllocation: ${JSON.stringify({ provider: p.name, app: app.name, creates: ambiguousAllocations(app) })}\n`,
        );
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
