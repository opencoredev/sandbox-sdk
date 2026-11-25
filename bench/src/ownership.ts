import { z } from "zod";
import { open, readFile, rm } from "node:fs/promises";
import { isMissingFile, journalFiles } from "./files.js";
import { dirname } from "node:path";
import type { Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import { deadline } from "./timing.js";
import { adapterComputeTier, isAbsent, type LookupEvidence } from "./existence.js";
import { tierLabel } from "./microsandbox.js";

/** A Microsandbox tier whose sandboxes a run owns only with the matching tier label and compute type. */
export type ComputeTier = "standard" | "shared";

export class UnverifiedOwnershipError extends Error {
  constructor(readonly unverifiedSandboxId: string) {
    super("Resource ownership unverified; see cleanupReview");
  }
}

/** A Microsandbox DELETE was accepted, but an exact read still finds the sandbox; it stays journaled. */
export class DeletionUnconfirmedError extends Error {
  constructor(readonly sandboxId: string) {
    super("Deletion accepted, but the sandbox still reads; see cleanupReview");
  }
}

/** What decides whether a journal is another run's and still holds cleanup entries. */
const journalOwner = z.object({
  runId: z.string(),
  resources: z.array(z.unknown()).default([]),
  apps: z.array(z.unknown()).default([]),
});

const printableRun = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);

/**
 * Refuse to start `run` where another run's journal still lists resources or Apps: the new run
 * would overwrite it, and `bench reap` for that run could no longer find them. A journal of the
 * same run, an empty one, or one that does not parse is left to be overwritten. `force` skips this.
 */
export async function assertJournalFree(path: string, run: string, force: boolean) {
  if (force) return;
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return;
  }

  const owner = journalOwner.safeParse(raw);

  if (!owner.success || owner.data.runId === run) return;
  const entries = owner.data.resources.length + owner.data.apps.length;

  if (entries === 0) return;
  const other = printableRun.safeParse(owner.data.runId);
  const name = other.success ? `run ${other.data}` : "another run";

  throw new Error(
    `${path} holds ${entries} cleanup entries of ${name}. Reap that run first (bun bench reap --run ID --out the same directory), or choose another --out; --force overwrites its journal.`,
  );
}

/** Replace the journal only after its complete contents have reached disk. */
export async function writeOwnership(path: string, data: string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;

  try {
    const file = await open(temporary, "wx", 0o600);

    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }

    await journalFiles.rename(temporary, path);
    const directory = await open(dirname(path), "r");

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface CleanupReview {
  provider: string;
  id: string;
  kind: "sandbox" | "snapshot" | "snapshot-source" | "allocation-attempt" | "service";
  reason: string;
  status?: "checking" | "unresolved";
}

export interface CleanupResolution extends CleanupReview {
  resolution: "absent";
  evidence: LookupEvidence;
}

export function recordAbsentResolution(
  reviews: CleanupReview[],
  resolutions: CleanupResolution[],
  provider: string,
  id: string,
  evidence: LookupEvidence,
) {
  if (!isAbsent(evidence)) return false;
  const entry = reviews.find((r) => r.provider === provider && r.id === id && r.kind === "sandbox");
  resolutions.push({
    provider,
    id,
    kind: "sandbox",
    reason: entry?.reason ?? "Exact native lookup confirmed absence",
    resolution: "absent",
    evidence,
  });

  for (const review of reviews.filter(
    (r) => r.provider === provider && r.id === id && r.kind === "sandbox",
  ))
    reviews.splice(reviews.indexOf(review), 1);

  return true;
}

export function unresolvedCleanupReviews(reviews: CleanupReview[] = []) {
  return reviews.filter((r) => r.status !== "checking");
}

export interface CleanupRelease extends CleanupReview {
  releasedAt: string;
  proof: "live-run-sdk-labels";
}

/** Call only after fresh live ownership verification for this exact sandbox. */
export function recordVerifiedRelease(
  reviews: CleanupReview[],
  releases: CleanupRelease[],
  provider: string,
  id: string,
) {
  for (const entry of reviews.filter(
    (r) => r.provider === provider && r.id === id && r.kind === "sandbox",
  )) {
    releases.push({ ...entry, releasedAt: new Date().toISOString(), proof: "live-run-sdk-labels" });
    reviews.splice(reviews.indexOf(entry), 1);
  }
}

/**
 * The run's labels on a listed sandbox. With `tier` (a Microsandbox tier), its bench tier label must
 * name that tier too: a sandbox labelled for the other tier is never this tier's to delete.
 */
export function hasRunOwnership(
  info: Pick<SandboxInfo, "labels">,
  run: string,
  tier?: ComputeTier,
) {
  return (
    info.labels["sandbox-bench-run"] === run &&
    info.labels["sandbox-sdk"] === "1" &&
    (tier === undefined || info.labels[tierLabel] === tier)
  );
}

/** Listing is read-only; only the exact ID's live labels can establish ownership.
 * Newly created sandboxes may need bounded control-plane visibility retries. With `tier`, the tier
 * label must match and the adapter must list on that compute tier: it checks each listed sandbox's
 * `compute.type` against its own, so a sandbox on the other tier is never listed as owned. */
export async function verifyRunOwnership(
  provider: Provider,
  id: string,
  run: string,
  timeoutMs: number,
  visibilityBudgetMs = 0,
  { tier }: { tier?: ComputeTier } = {},
) {
  // An adapter on another (or the default) tier could list either tier's sandboxes.
  if (tier !== undefined && adapterComputeTier(provider) !== tier) return false;
  const end = performance.now() + Math.min(timeoutMs, visibilityBudgetMs || timeoutMs);
  let backoffMs = 100;

  for (;;) {
    try {
      const matches = await deadline(Math.max(1, end - performance.now()), () =>
        provider.list(visibilityBudgetMs ? {} : { "sandbox-bench-run": run, "sandbox-sdk": "1" }),
      );

      const exact = matches.find((info) => info.id === id);

      if (exact && hasRunOwnership(exact, run, tier)) return true;

      if (
        exact &&
        ((exact.labels["sandbox-bench-run"] !== undefined &&
          exact.labels["sandbox-bench-run"] !== run) ||
          (exact.labels["sandbox-sdk"] !== undefined && exact.labels["sandbox-sdk"] !== "1") ||
          (tier !== undefined && exact.labels[tierLabel] !== tier))
      )
        return false;
    } catch {
      /* Missing/unreadable metadata is retried only for a just-created resource. */
    }

    const remainingMs = end - performance.now();

    if (!visibilityBudgetMs || remainingMs <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, remainingMs)));
    backoffMs = Math.min(backoffMs * 2, 2000);
  }
}

export const snapshotProvenanceSchema = z.object({
  sourceId: z.string().min(1),
  runLabel: z.string().min(1),
  sdkLabel: z.literal("1"),
  verifiedAt: z.iso.datetime(),
});

export type SnapshotProvenance = z.infer<typeof snapshotProvenanceSchema>;

/** Capture proof at snapshot admission, while the source can still be verified live. */
export async function proveSnapshotSource(
  provider: Provider,
  sourceId: string,
  run: string,
  timeoutMs: number,
  visibilityBudgetMs: number,
  { tier }: { tier?: ComputeTier } = {},
): Promise<SnapshotProvenance> {
  if (!(await verifyRunOwnership(provider, sourceId, run, timeoutMs, visibilityBudgetMs, { tier })))
    throw new UnverifiedOwnershipError(sourceId);

  return { sourceId, runLabel: run, sdkLabel: "1", verifiedAt: new Date().toISOString() };
}
