import type { AttemptRecord } from "../src/cost/attempt-record.js";
import type { BillingRule } from "../src/cost/billing-rules.js";
import type { CostSourceAudit } from "../src/cost/eligibility.js";

const start = Date.parse("2026-11-05T10:00:00.000Z");

export const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();

/** A completed 300 s same-spec attempt with a settled per-sandbox bill; override what a test needs. */
export function attempt(patch: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    version: 1,
    attemptId: `a-${Math.random().toString(36).slice(2)}`,
    provider: "upstash",
    product: null,
    profile: "fix-and-test",
    track: "same-spec",
    purpose: "headline",
    batch: 0,
    slot: 0,
    sandboxIds: ["sbx-1"],
    startedAt: at(0),
    finishedAt: at(300),
    lifecycle: { createdAt: at(2), deleteRequestedAt: at(298), deletedAt: at(300) },
    completion: { kind: "completed" },
    phases: [],
    allocation: {
      provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 10 },
      measured: { cpuQuota: 4, memoryGiB: 8 },
    },
    usage: null,
    cost: {
      kind: "billed",
      usd: 0.02,
      settled: true,
      attribution: "per-sandbox",
      source: "fixture",
    },
    ...patch,
  };
}

export const failed = (patch: Partial<AttemptRecord> = {}) =>
  attempt({
    completion: { kind: "incomplete", reason: "check-failed", detail: "fixture" },
    ...patch,
  });

export const cleanAudit: CostSourceAudit = {
  reconciliation: { kind: "reconciled", window: "profile-track", reportedUSD: 1, settledUSD: 1 },
  resolutionUSDPerAttempt: 0,
  provisional: null,
};

export function confirmed(rule: BillingRule): BillingRule {
  return {
    ...rule,
    confirmation: { kind: "confirmed-in-writing", date: "2026-11-10", reference: "fixture" },
  };
}
