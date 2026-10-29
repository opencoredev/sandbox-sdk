import { z } from "zod";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import { deadline } from "./timing.js";
import { isAbsent, type LookupEvidence } from "./existence.js";

export class UnverifiedOwnershipError extends Error {
  constructor(readonly unverifiedSandboxId: string) {
    super("Resource ownership unverified; see cleanupReview");
  }
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

    await rename(temporary, path);
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
  kind: "sandbox" | "snapshot" | "snapshot-source";
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

export function hasRunOwnership(info: Pick<SandboxInfo, "labels">, run: string) {
  return info.labels["sandbox-bench-run"] === run && info.labels["sandbox-sdk"] === "1";
}

/** Listing is read-only; only the exact ID's live labels can establish ownership.
 * Newly created sandboxes may need bounded control-plane visibility retries. */
export async function verifyRunOwnership(
  provider: Provider,
  id: string,
  run: string,
  timeoutMs: number,
  visibilityBudgetMs = 0,
) {
  const end = performance.now() + Math.min(timeoutMs, visibilityBudgetMs || timeoutMs);
  let backoffMs = 100;

  for (;;) {
    try {
      const matches = await deadline(Math.max(1, end - performance.now()), () =>
        provider.list(visibilityBudgetMs ? {} : { "sandbox-bench-run": run, "sandbox-sdk": "1" }),
      );

      const exact = matches.find((info) => info.id === id);

      if (exact && hasRunOwnership(exact, run)) return true;

      if (
        exact &&
        ((exact.labels["sandbox-bench-run"] !== undefined &&
          exact.labels["sandbox-bench-run"] !== run) ||
          (exact.labels["sandbox-sdk"] !== undefined && exact.labels["sandbox-sdk"] !== "1"))
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
): Promise<SnapshotProvenance> {
  if (!(await verifyRunOwnership(provider, sourceId, run, timeoutMs, visibilityBudgetMs)))
    throw new UnverifiedOwnershipError(sourceId);

  return { sourceId, runLabel: run, sdkLabel: "1", verifiedAt: new Date().toISOString() };
}
