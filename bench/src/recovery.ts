import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import type { MicrosandboxHooks } from "@opencoredev/sandbox-sdk/microsandbox";
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
import { fingerprintSchema, reapConnection } from "./connections.js";
import { DeadlineError, DeletionWork, deadline } from "./timing.js";
import { snapshotsFromSource, deleteProvenSnapshot, settleJournaledSnapshot } from "./snapshots.js";
import { isMissingFile } from "./files.js";
import {
  cleanService,
  isRetrySlug,
  isServiceSuperseded,
  probePendingService,
  readMicrosandboxSnapshot,
  settleAllocationAttempt,
  settleMicrosandboxCapture,
  tierLabel,
} from "./microsandbox.js";
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
  /** Server `created_at` from a confirmed Microsandbox Service create. */
  serviceCreatedAt: z.string().optional(),
  /** True once a retry slug proved this base slug hit a foreign 409 conflict. */
  serviceSuperseded: z.boolean().optional(),
  /** A Microsandbox capture's name; equal to `id` while unconfirmed. */
  snapshotName: z.string().optional(),
});

const settledSnapshotSchema = z.object({
  provider: z.string(),
  name: z.string(),
  id: z.string(),
});

const settledServiceSchema = z.object({
  provider: z.string(),
  id: z.string(),
});

const reviewSchema = resource
  .pick({ provider: true, id: true, kind: true })
  .extend({ reason: z.string(), status: z.enum(["checking", "unresolved"]).optional() });

function takesAttemptHooks(
  provider: Provider,
): provider is Provider & { setAttemptHooks(hooks: MicrosandboxHooks): void } {
  return "setAttemptHooks" in provider && typeof provider.setAttemptHooks === "function";
}

/** A journal from before connection fingerprints: it kept each connection's endpoints as text. */
const legacyConnections = z.object({ connections: z.record(z.string(), z.unknown()) });

/**
 * Recovery never treats a journal ID as permission to delete. It reads only through adapters whose
 * connection matches the fingerprint the run journaled, so it must run with the run's environment.
 */
export async function reapRun(
  providers: LoadedProvider[],
  config: ConfigV2,
  sanitize: (value: string) => string,
) {
  const path = join(config.out, "ownership.json");

  let journal: {
    runId: string;
    connectionFingerprints: Record<string, string>;
    resources: z.infer<typeof resource>[];
    apps: JournalApp[];
    settledSnapshots: z.infer<typeof settledSnapshotSchema>[];
    settledServices: z.infer<typeof settledServiceSchema>[];
    settledAttempts: z.infer<typeof settledServiceSchema>[];
  } | null = null;

  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));

    if (legacyConnections.safeParse(raw).success)
      throw new Error(
        "Ownership journal keeps connection endpoint text (written before connection fingerprints), which can hold a credential; reap refuses it. Clean up that run's sandboxes in the provider's console, then delete the journal",
      );

    journal = z
      .object({
        runId: z.string(),
        // Kept as read, so every rewrite of the journal still lets a later reap check connections.
        connectionFingerprints: z.record(z.string(), fingerprintSchema).default({}),
        resources: z.array(resource),
        // Older journals have no Apps: every sandbox is in the adapter's default App.
        apps: z.array(journalAppSchema).default([]),
        // Settled Microsandbox capture-name -> managed UUID aliases kept until results.json clears.
        settledSnapshots: z.array(settledSnapshotSchema).default([]),
        // Settled Microsandbox Service reviews kept until results.json clears.
        settledServices: z.array(settledServiceSchema).default([]),
        // Microsandbox allocation attempts promoted to sandboxes, kept until results.json clears.
        settledAttempts: z.array(settledServiceSchema).default([]),
      })
      .parse(raw);
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

  // Single serialized writer for ownership.json so a timed-out cleanup hook can never publish a
  // stale copy over newer journal state.
  let journalWriteChain = Promise.resolve();

  const persistJournal = () => {
    const next = journalWriteChain.then(() =>
      writeOwnership(path, JSON.stringify(journal, null, 2) + "\n"),
    );

    journalWriteChain = next.catch(() => {});

    return next;
  };

  /**
   * Durably promotes Service entries in `ownership.json` before publishing the promoted fields to
   * in-memory `journal.resources`, so a concurrent fallback sweep never observes an unpersisted
   * promotion while the rename is still in flight or after it rejects.
   */
  const persistServicePromotion = (
    targets: z.infer<typeof resource>[],
    createdAt: string | undefined,
  ) => {
    // Because in-memory promotion is only published after writeOwnership succeeds, entries that
    // already carry this state and timestamp are already durable on disk and need not wait behind
    // an unrelated in-flight write.
    const needsWrite = targets.some((entry) => {
      if (!journal || !journal.resources.includes(entry)) return false;
      const nextCreatedAt = createdAt ?? entry.serviceCreatedAt;

      return entry.serviceState !== "created" || entry.serviceCreatedAt !== nextCreatedAt;
    });

    if (!needsWrite) return Promise.resolve();

    const next = journalWriteChain.then(async () => {
      if (!journal) return;
      const updates = new Map<z.infer<typeof resource>, z.infer<typeof resource>>();

      for (const entry of targets) {
        if (!journal.resources.includes(entry)) continue;
        const nextCreatedAt = createdAt ?? entry.serviceCreatedAt;

        if (entry.serviceState === "created" && entry.serviceCreatedAt === nextCreatedAt) continue;
        const promoted: z.infer<typeof resource> = { ...entry, serviceState: "created" };

        if (nextCreatedAt !== undefined) promoted.serviceCreatedAt = nextCreatedAt;
        updates.set(entry, promoted);
      }

      if (updates.size === 0) return;

      const candidate = {
        ...journal,
        resources: journal.resources.map((r) => updates.get(r) ?? r),
      };

      await writeOwnership(path, JSON.stringify(candidate, null, 2) + "\n");

      for (const [entry, promoted] of updates) {
        entry.serviceState = "created";

        if (promoted.serviceCreatedAt !== undefined)
          entry.serviceCreatedAt = promoted.serviceCreatedAt;
      }
    });

    journalWriteChain = next.catch(() => {});

    return next;
  };

  for (const p of providers) {
    if (p.kind === "skipped") {
      process.stderr.write(`SKIP ${p.name}: ${p.note}\n`);

      // Its journaled cleanup is still owed: the entries stay and the reap fails.
      if (
        (journal?.resources ?? []).some((r) => r.provider === p.name) ||
        (journal?.apps ?? []).some((app) => app.provider === p.name)
      )
        failed = true;
      continue;
    }

    // Before any request: an adapter on another endpoint, account or scope reads the run's live
    // sandboxes as missing, which would be recorded as absence.
    const connection = await reapConnection(p.provider, journal?.connectionFingerprints[p.name]);

    if (connection.kind === "differs") {
      process.stderr.write(
        `SKIP ${p.name}: ${connection.reason}; reap must run with the environment the run used\n`,
      );
      failed = true;
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
        await persistJournal();
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

    // Service slugs already verified and deleted/conflicted by the adapter during this reap, so a
    // transient rename failure in the settlement hook still retires the entry in the Service sweep.
    const settledServicesInRun = new Set<string>();

    // Retire Service entries as soon as the adapter confirms deletion or foreign conflict during
    // destroy(), and persist verified attached identity before DELETE can fail and detach it.
    if (tier !== undefined && takesAttemptHooks(p.provider)) {
      p.provider.setAttemptHooks({
        serviceSettled: async ({ slug, outcome, createdAt }) => {
          if (!journal) return;

          const matching = journal.resources.filter(
            (r) => r.provider === p.name && r.kind === "service" && r.id === slug,
          );

          if (outcome === "created") {
            await persistServicePromotion(matching, createdAt);

            return;
          }

          if (outcome !== "deleted" && outcome !== "conflict") return;
          settledServicesInRun.add(slug);

          for (const entry of matching) await forget(entry);
        },
      });
    }

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
      const matchingReviews = reviews.filter(
        (r) =>
          r.provider === entry.provider &&
          r.kind === entry.kind &&
          (r.id === entry.id || (entry.snapshotName !== undefined && r.id === entry.snapshotName)),
      );

      if (journal) {
        const entryIndex = journal.resources.indexOf(entry);
        const hadEntry = entryIndex >= 0;
        let addedSettled = false;
        const newlySuperseded: z.infer<typeof resource>[] = [];

        if (entry.kind === "service" && hadEntry) {
          for (let i = 0; i < entryIndex; i++) {
            const other = journal.resources[i]!;

            if (
              other.provider === entry.provider &&
              other.kind === "service" &&
              other.parent === entry.parent &&
              isRetrySlug(entry.id, other.id) &&
              other.serviceSuperseded === undefined
            ) {
              other.serviceSuperseded = true;
              newlySuperseded.push(other);
            }
          }
        }

        if (hadEntry) journal.resources = journal.resources.filter((r) => r !== entry);

        if (
          entry.kind === "service" &&
          matchingReviews.length > 0 &&
          !journal.settledServices.some((s) => s.provider === entry.provider && s.id === entry.id)
        ) {
          journal.settledServices.push({ provider: entry.provider, id: entry.id });
          addedSettled = true;
        }

        try {
          await persistJournal();
        } catch (error) {
          if (hadEntry && !journal.resources.includes(entry))
            journal.resources.splice(Math.min(entryIndex, journal.resources.length), 0, entry);

          for (const other of newlySuperseded) delete other.serviceSuperseded;

          if (addedSettled)
            journal.settledServices = journal.settledServices.filter(
              (s) => !(s.provider === entry.provider && s.id === entry.id),
            );
          throw error;
        }
      }

      for (const item of matchingReviews) {
        const index = reviews.indexOf(item);

        if (index >= 0) reviews.splice(index, 1);
      }
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
        journal ??= {
          runId: config.run,
          connectionFingerprints: {},
          resources: [],
          apps: [],
          settledSnapshots: [],
          settledServices: [],
          settledAttempts: [],
        };

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

        // A review an earlier reap left under the attempt's name is settled: the sandbox entry,
        // keyed by ID, carries the cleanup from here. The marker outlives a failed results.json write.
        const settled = reviews.filter(
          (r) => r.provider === p.name && r.kind === "allocation-attempt" && r.id === entry.id,
        );

        for (const item of settled) reviews.splice(reviews.indexOf(item), 1);

        if (journal) {
          journal.resources = journal.resources.filter((r) => r !== entry);
          journal.resources.push({
            provider: p.name,
            id: outcome.id,
            kind: "sandbox",
            parent: null,
          });

          if (
            settled.length > 0 &&
            !journal.settledAttempts.some((s) => s.provider === p.name && s.id === entry.id)
          )
            journal.settledAttempts.push({ provider: p.name, id: entry.id });
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

    if (journal && reconciled) await persistJournal();

    // An attempt an earlier reap promoted, whose review results.json kept because its write failed.
    for (const item of Array.from(reviews))
      if (
        item.provider === p.name &&
        item.kind === "allocation-attempt" &&
        journal?.settledAttempts.some((s) => s.provider === p.name && s.id === item.id) &&
        !journal.resources.some(
          (r) => r.provider === p.name && r.kind === "allocation-attempt" && r.id === item.id,
        )
      )
        reviews.splice(reviews.indexOf(item), 1);

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
          journal ??= {
            runId: config.run,
            connectionFingerprints: {},
            resources: [],
            apps: [],
            settledSnapshots: [],
            settledServices: [],
            settledAttempts: [],
          };

          if (
            !journal.resources.some(
              (r) => r.provider === p.name && r.id === id && r.kind === "sandbox",
            )
          )
            journal.resources.push({ provider: p.name, id, kind: "sandbox", parent: null });
          await persistJournal();
          recordVerifiedRelease(reviews, releases, p.name, id);
        }

        if (tier !== undefined) {
          const allServices = (journal?.resources ?? []).filter(
            (r) => r.provider === p.name && r.kind === "service",
          );

          const unprovenServices = allServices.filter(
            (r, idx) =>
              r.parent === id &&
              r.sandboxName !== undefined &&
              (r.serviceState !== "created" || r.serviceCreatedAt === undefined) &&
              !isServiceSuperseded(allServices, idx),
          );

          for (const svc of unprovenServices) {
            const probed = await deadline(config["timeout-ms"], () =>
              probePendingService(svc.id, svc.sandboxName!),
            );

            if (probed.kind === "not-found" && svc.serviceState !== "created")
              throw new Error(
                `Pending Service ${svc.id} is still unresolved (404); retaining sandbox ${id} so a late create cannot detach without proof`,
              );

            if (probed.kind === "attached") {
              if (probed.createdAt === undefined)
                throw new Error(
                  `Attached Service ${svc.id} lacks creation timestamp; retaining sandbox ${id} for retry`,
                );
              await persistServicePromotion([svc], probed.createdAt);
            }
          }
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

        const retired = (journal?.resources ?? []).filter(
          (entry) => entry.provider === p.name && entry.kind === "sandbox" && entry.id === id,
        );

        for (const entry of retired) await forget(entry);
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

    // Drain any in-flight promotion/settlement writes from destroy() before the fallback Service
    // sweep inspects journaled Service entries.
    await journalWriteChain;

    // Microsandbox Services journaled before they were made, deleted whether or not their sandbox is
    // gone, and only while they target that sandbox or nothing; others are never touched.
    const services = (journal?.resources ?? []).filter(
      (r) => r.provider === p.name && r.kind === "service",
    );

    for (const [idx, entry] of services.entries()) {
      try {
        if (settledServicesInRun.has(entry.id)) {
          await forget(entry);
          continue;
        }

        const outcome = await deadline(config["timeout-ms"], () =>
          cleanService({
            id: entry.id,
            parent: entry.parent,
            sandboxName: entry.sandboxName,
            state: entry.serviceState ?? "pending",
            createdAt: entry.serviceCreatedAt,
            superseded: isServiceSuperseded(services, idx),
            onVerified: async (verifiedCreatedAt) => {
              await persistServicePromotion([entry], verifiedCreatedAt);
            },
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
          snapshotsFromSource(p.name, p.provider, entry.id, journaled),
        )) {
          // Entries already journaled for this snapshot, such as a Maritime save still pending with its
          // idempotency key, or a capture of this source journaled by its name. Replace them with the
          // confirmed snapshot entry BEFORE deleting: if the delete succeeds on the server and drops its
          // response, a later step must inspect/delete the snapshot rather than replaying the save POST.
          const earlier = (journal?.resources ?? []).filter(
            (r) =>
              r.provider === p.name &&
              r.kind === "snapshot" &&
              (r.id === snapshot.id ||
                (snapshot.name !== undefined && r.parent === entry.id && r.id === snapshot.name)),
          );

          // A capture journaled by name keeps that name on its ID entry, and as a name->ID alias, so
          // reviews keyed by the name settle with the ID once it is deleted.
          const alias =
            snapshot.name !== undefined && earlier.some((r) => r.id === snapshot.name)
              ? snapshot.name
              : undefined;

          const item: z.infer<typeof resource> = {
            provider: p.name,
            id: snapshot.id,
            kind: "snapshot",
            parent: entry.id,
            snapshotProof: proof,
          };

          if (alias !== undefined) item.snapshotName = alias;

          const previousResources = journal ? [...journal.resources] : null;
          const previousSettled = journal ? [...journal.settledSnapshots] : null;

          if (journal) {
            journal.resources = journal.resources.filter((r) => !earlier.includes(r));
            journal.resources.push(item);

            if (tier !== undefined && alias !== undefined)
              journal.settledSnapshots = [
                ...journal.settledSnapshots.filter(
                  (s) => !(s.provider === p.name && s.name === alias),
                ),
                { provider: p.name, name: alias, id: snapshot.id },
              ];
          }

          try {
            if (journal) await persistJournal();
          } catch (error) {
            if (journal && previousResources) journal.resources = previousResources;

            if (journal && previousSettled) journal.settledSnapshots = previousSettled;
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
      let current = entry;

      try {
        if (restoresUnresolved)
          throw new Error("Restore cleanup unresolved; snapshot and source retained");

        const settled = await settleJournaledSnapshot(
          p.name,
          p.provider,
          entry,
          config["timeout-ms"],
        );

        if (settled.kind === "exists") {
          // A Maritime save's key goes once it settles; a Microsandbox capture's name gives way to the
          // managed ID settlement confirmed, journaled before the delete so a by-name 404 can never
          // drop the snapshot it found. Also keep the name->UUID alias until results.json clears.
          const aliasMissing =
            tier !== undefined &&
            entry.snapshotName !== undefined &&
            !(journal?.settledSnapshots ?? []).some(
              (s) => s.provider === p.name && s.name === entry.snapshotName && s.id === settled.id,
            );

          if (entry.idempotencyKey !== undefined || settled.id !== entry.id || aliasMissing) {
            const { idempotencyKey: _, ...withoutKey } = entry;
            const confirmed = { ...withoutKey, id: settled.id };

            if (journal) {
              const previousResources = [...journal.resources];
              const previousSettled = [...journal.settledSnapshots];
              journal.resources = journal.resources.map((r) => (r === entry ? confirmed : r));

              if (tier !== undefined && entry.snapshotName !== undefined) {
                journal.settledSnapshots = [
                  ...journal.settledSnapshots.filter(
                    (s) => !(s.provider === p.name && s.name === entry.snapshotName),
                  ),
                  { provider: p.name, name: entry.snapshotName, id: settled.id },
                ];
              }

              try {
                await persistJournal();
              } catch (error) {
                journal.resources = previousResources;
                journal.settledSnapshots = previousSettled;
                throw error;
              }
            }

            if (settled.id !== entry.id) {
              const hasSettledReview = reviews.some(
                (r) =>
                  r.provider === entry.provider && r.id === confirmed.id && r.kind === entry.kind,
              );

              for (let i = reviews.length - 1; i >= 0; i--) {
                const item = reviews[i]!;

                if (
                  item.provider === entry.provider &&
                  item.id === entry.id &&
                  item.kind === entry.kind
                ) {
                  if (hasSettledReview) reviews.splice(i, 1);
                  else item.id = confirmed.id;
                }
              }
            }

            current = confirmed;
          }

          if (current.snapshotName !== undefined && current.snapshotName !== current.id) {
            const hasSettledReview = reviews.some(
              (r) =>
                r.provider === current.provider && r.id === current.id && r.kind === current.kind,
            );

            for (let i = reviews.length - 1; i >= 0; i--) {
              const item = reviews[i]!;

              if (
                item.provider === current.provider &&
                item.id === current.snapshotName &&
                item.kind === current.kind
              ) {
                if (hasSettledReview) reviews.splice(i, 1);
                else item.id = current.id;
              }
            }
          }

          await deleteProvenSnapshot(
            p.name,
            p.provider,
            current.id,
            current.parent,
            current.snapshotProof,
            config.run,
            config["timeout-ms"],
          );
          await forget(current);
        } else {
          await forget(entry);
        }
      } catch (error) {
        review(
          p.name,
          current.id,
          current.kind,
          sanitize(error instanceof Error ? error.message : "Snapshot recovery failed"),
        );
      }
    }

    // A prior reap may have deleted a Microsandbox snapshot and emptied the journal before failing
    // to write results.json. Settle any orphaned snapshot review by proving it absent on the API.
    if (tier !== undefined) {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      for (const item of reviews.filter((r) => r.provider === p.name && r.kind === "snapshot")) {
        const stillJournaled = (journal?.resources ?? []).some(
          (r) =>
            r.provider === p.name &&
            r.kind === "snapshot" &&
            (r.id === item.id || r.snapshotName === item.id),
        );

        if (stillJournaled) continue;

        try {
          const settledAlias = journal?.settledSnapshots.find(
            (s) => s.provider === p.name && s.name === item.id,
          );

          const exactId = settledAlias?.id ?? (uuidPattern.test(item.id) ? item.id : undefined);

          const absent =
            exactId !== undefined
              ? (await deadline(config["timeout-ms"], () => readMicrosandboxSnapshot(exactId))) ===
                undefined
              : (
                  await deadline(config["timeout-ms"], () =>
                    settleMicrosandboxCapture(item.id, config["timeout-ms"]),
                  )
                ).kind === "absent";

          if (absent) {
            const index = reviews.indexOf(item);

            if (index >= 0) reviews.splice(index, 1);
          }
        } catch {
          // Keep the review until absence can be proven.
        }
      }

      for (const item of reviews.filter((r) => r.provider === p.name && r.kind === "service")) {
        const stillJournaled = (journal?.resources ?? []).some(
          (r) => r.provider === p.name && r.kind === "service" && r.id === item.id,
        );

        if (stillJournaled) continue;

        if (journal?.settledServices.some((s) => s.provider === p.name && s.id === item.id)) {
          const index = reviews.indexOf(item);

          if (index >= 0) reviews.splice(index, 1);
        }
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

  // Drain any in-flight serialized ownership.json writes (e.g. from a timed-out cleanup hook) before
  // publishing results.json or returning.
  await journalWriteChain;

  if (results || reviews.length || releases.length || resolutions.length) {
    const record = {
      ...(results ?? { runId: config.run }),
      cleanupReview: reviews,
      cleanupReleased: releases,
      cleanupResolved: resolutions,
    };

    await writeOwnership(join(config.out, "results.json"), JSON.stringify(record, null, 2) + "\n");
  }

  // Once results.json is durably written, drop settled markers whose reviews cleared.
  if (
    journal &&
    (journal.settledSnapshots.length > 0 ||
      journal.settledServices.length > 0 ||
      journal.settledAttempts.length > 0)
  ) {
    const retainedSnapshots = journal.settledSnapshots.filter((alias) =>
      reviews.some(
        (r) =>
          r.provider === alias.provider &&
          r.kind === "snapshot" &&
          (r.id === alias.name || r.id === alias.id),
      ),
    );

    const retainedServices = journal.settledServices.filter((settled) =>
      reviews.some(
        (r) => r.provider === settled.provider && r.kind === "service" && r.id === settled.id,
      ),
    );

    const retainedAttempts = journal.settledAttempts.filter((settled) =>
      reviews.some(
        (r) =>
          r.provider === settled.provider && r.kind === "allocation-attempt" && r.id === settled.id,
      ),
    );

    if (
      retainedSnapshots.length !== journal.settledSnapshots.length ||
      retainedServices.length !== journal.settledServices.length ||
      retainedAttempts.length !== journal.settledAttempts.length
    ) {
      journal.settledSnapshots = retainedSnapshots;
      journal.settledServices = retainedServices;
      journal.settledAttempts = retainedAttempts;
      await persistJournal();
    }
  }

  const mdPath = join(config.out, "results.md");
  const md = await readFile(mdPath, "utf8").catch(() => null);

  if (reviews.length || releases.length || resolutions.length) {
    await writeFile(
      mdPath,
      (md ?? "").replace(/^cleanup(?:Review|Released|Resolved):.*\n/gm, "") +
        `\ncleanupReview: ${JSON.stringify(reviews)}\ncleanupReleased: ${JSON.stringify(releases)}\ncleanupResolved: ${JSON.stringify(resolutions)}\n`,
    );
  } else if (md !== null && /^cleanup(?:Review|Released|Resolved):/m.test(md)) {
    await writeFile(mdPath, md.replace(/^cleanup(?:Review|Released|Resolved):.*\n/gm, ""));
  }

  return failed || reviews.length > 0;
}
