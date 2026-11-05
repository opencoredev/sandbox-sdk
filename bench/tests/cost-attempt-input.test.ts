import { describe, expect, it } from "vitest";
import {
  attemptBillingSchema,
  costedAttempt,
  costedAttempts,
  elapsedSeconds,
} from "../src/cost/attempt-input.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { billedTime } from "../src/cost/columns.js";
import { attributionFor } from "../src/realistic/slots.js";
import { at, attempt, failed } from "./cost-fixtures.js";

function billingRuleOrThrow(provider: string) {
  const rule = billingRule(provider, null);

  if (!rule) throw new Error(`No rule for ${provider}`);

  return rule;
}

const billing = (attemptId: string) =>
  attemptBillingSchema.parse({
    attemptId,
    product: null,
    allocation: { provisioned: null, measured: { cpuQuota: null, memoryGiB: null } },
    usage: null,
    charge: { kind: "billed", usd: 0.01, settled: true, source: "fixture" },
  });

describe("cost adapter over the harness record", () => {
  it("keeps the record unchanged and derives outcome, lifecycle and elapsed time from it", () => {
    const a = attempt({
      attemptId: "x",
      createdAt: 3,
      deleteRequestedAt: 290,
      deletedAt: 299,
      endedAt: 299,
    });

    expect(a.record.schema).toBe("rw-attempt/1");
    expect(a.outcome).toBe("completed");
    expect(a.lifecycle).toEqual({
      createdAt: at(3),
      deleteRequestedAt: at(290),
      deletedAt: at(299),
    });
    expect(elapsedSeconds(a)).toBe(299);
  });

  it("ends the envelope at confirmed deletion, not when the host finished writing output", () => {
    // Deleted at 300 s, record finalised at 400 s after slow raw-output writes.
    const late = attempt({ endedAt: 400 });
    expect(elapsedSeconds(late)).toBe(300);
    expect(billedTime(late, billingRuleOrThrow("daytona")).seconds).toBe(300);
    expect(elapsedSeconds(attempt({ endedAt: 400, deletedAt: null }))).toBe(400);
  });

  it("rejects records no cost rule can use", () => {
    expect(() => attempt({ sandboxIds: [] })).toThrow(/completed without a sandbox/);
    expect(() => attempt({ endedAt: -1, deletedAt: null })).toThrow(/ends before it starts/);
  });

  it("leaves deletion unobserved when the harness could not confirm it", () => {
    expect(attempt({ deletedAt: null }).lifecycle.deletedAt).toBeNull();
    expect(attempt({ createdAt: null }).lifecycle.createdAt).toBeNull();
  });

  it("counts plan-limit and unavailable managed idle as not run, every other incomplete as a failure", () => {
    const reason = (r: "exceeds-plan-limit" | "not-available" | "unavailable" | "slot-timeout") =>
      failed({ completion: { kind: "incomplete", reason: r, detail: "fixture" } }).outcome;

    expect(reason("exceeds-plan-limit")).toBe("not-run");
    expect(reason("not-available")).toBe("not-run");
    expect(reason("unavailable")).toBe("incomplete");
    expect(reason("slot-timeout")).toBe("incomplete");
  });

  it("takes attribution from the record and drops it when the billing window was voided", () => {
    expect(attempt({ attribution: "account-window" }).attribution).toBe("account-window");
    expect(attempt({ attribution: "account-window", windowVoid: true }).attribution).toBe("none");
  });

  it("costs nothing without a sandbox and is unavailable when billing collected nothing", () => {
    expect(failed({ sandboxIds: [], billing: false }).charge).toEqual({ kind: "no-sandbox" });

    expect(attempt({ billing: false }).charge).toEqual({
      kind: "unavailable",
      reason: "no billing collected for this attempt",
    });
  });

  it("joins billing by attempt ID and rejects duplicates, strays and mismatches", () => {
    const one = attempt({ attemptId: "one", billing: false }).record;
    const two = attempt({ attemptId: "two", billing: false }).record;

    const joined = costedAttempts([one, two], [billing("two")]);
    expect(joined.map((a) => a.charge.kind)).toEqual(["unavailable", "billed"]);

    expect(() => costedAttempts([one], [billing("one"), billing("one")])).toThrow(
      /Duplicate billing/,
    );
    expect(() => costedAttempts([one], [billing("ghost")])).toThrow(/unknown attempt ghost/);
    expect(() => costedAttempts([one, one], [])).toThrow(/Duplicate attempt IDs/);
    expect(() => costedAttempt(one, billing("two"))).toThrow(/joined to attempt one/);
  });

  it("gives the scheduler its attribution from the billing-rules table", () => {
    expect(attributionFor("boxd")).toEqual({
      attribution: "per-machine",
      settlementMs: 15 * 60_000,
    });
    expect(attributionFor("superserve").attribution).toBe("account-window");
    expect(attributionFor("unknown-provider")).toEqual({ attribution: "none", settlementMs: null });
    expect(attributionFor("upstash").attribution).toBe(billingRule("upstash", null)?.attribution);
  });
});
