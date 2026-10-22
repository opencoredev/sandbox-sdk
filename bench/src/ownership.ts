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
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
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
export function recordAbsentResolution(reviews: CleanupReview[], resolutions: CleanupResolution[], provider: string, id: string, evidence: LookupEvidence) {
  if (!isAbsent(evidence)) return false;
  const entry = reviews.find(r => r.provider === provider && r.id === id && r.kind === "sandbox");
  resolutions.push({provider, id, kind: "sandbox", reason: entry?.reason ?? "Exact native lookup confirmed absence", resolution: "absent", evidence});
  for (const review of reviews.filter(r => r.provider === provider && r.id === id && r.kind === "sandbox")) reviews.splice(reviews.indexOf(review), 1);
  return true;
}
export function unresolvedCleanupReviews(reviews: CleanupReview[] = []) {return reviews.filter(r => r.status !== "checking");}
export interface CleanupRelease extends CleanupReview {
  releasedAt: string;
  proof: "live-run-sdk-labels";
}
/** Call only after fresh live ownership verification for this exact sandbox. */
export function recordVerifiedRelease(reviews: CleanupReview[], releases: CleanupRelease[], provider: string, id: string) {
  for (const entry of reviews.filter(r => r.provider === provider && r.id === id && r.kind === "sandbox")) {
    releases.push({...entry, releasedAt: new Date().toISOString(), proof: "live-run-sdk-labels"});
    reviews.splice(reviews.indexOf(entry), 1);
  }
}
export function hasRunOwnership(info: Pick<SandboxInfo, "labels">, run: string) {
  return info.labels["sandbox-bench-run"] === run && info.labels["sandbox-sdk"] === "1";
}
/** Listing is read-only. A journal, create error, or bare ID is never ownership proof. */
export async function verifyRunOwnership(provider: Provider, id: string, run: string, timeoutMs: number) {
  try {
    const matches = await deadline(timeoutMs, () => provider.list({"sandbox-bench-run": run, "sandbox-sdk": "1"}));
    return matches.some(info => info.id === id && hasRunOwnership(info, run));
  } catch { return false; }
}
