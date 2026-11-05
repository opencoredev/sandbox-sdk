import { describe, expect, it } from "vitest";
import { billingRule } from "../src/cost/billing-rules.js";
import {
  completionCounts,
  eligibility,
  sameMachineCompliance,
  type CostSourceAudit,
  type Eligibility,
  type EligibilityInput,
} from "../src/cost/eligibility.js";
import type { AttemptRecord } from "../src/cost/attempt-record.js";
import { attempt, cleanAudit, confirmed, failed } from "./cost-fixtures.js";

function rule(provider: string) {
  const found = billingRule(provider, null);

  if (!found) throw new Error(`No rule for ${provider}`);

  return found;
}

const ten = (patch: Partial<AttemptRecord> = {}) =>
  Array.from({ length: 10 }, (_, batch) => attempt({ batch, ...patch }));

function check(input: Partial<EligibilityInput> & { provider?: string }): Eligibility {
  const provider = input.provider ?? "upstash";

  return eligibility({
    rule: input.rule ?? rule(provider),
    comparison: input.comparison ?? "same-machine",
    attempts: input.attempts ?? ten({ provider }),
    audit: input.audit ?? cleanAudit,
  });
}

const kinds = (result: Eligibility) =>
  result.kind === "eligible" ? [] : result.reasons.map((r) => r.kind);

const metered = (patch: { settled?: boolean; attribution?: "per-machine" | "none" } = {}) =>
  ten({
    provider: "boxd",
    cost: {
      kind: "metered",
      usd: 0.01,
      settled: patch.settled ?? true,
      attribution: patch.attribution ?? "per-machine",
      source: "meter",
    },
  });

/** Our figure is (1 + residual) x a $1.00 settled charge. */
const reconciled = (
  residual: number,
  window: "profile-track" | "mixed-profiles" = "profile-track",
): CostSourceAudit => ({
  ...cleanAudit,
  reconciliation: { kind: "reconciled", window, reportedUSD: 1 + residual, settledUSD: 1 },
});

describe("eligibility table", () => {
  it("accepts billed, settled, attributable costs", () => {
    expect(check({})).toEqual({
      kind: "eligible",
      status: { costKind: "billed", settled: true, provisional: null },
    });
  });

  it("rejects unsettled bills (Daytona today)", () => {
    const result = check({
      provider: "daytona",
      attempts: ten({
        provider: "daytona",
        cost: {
          kind: "billed",
          usd: 0.02,
          settled: false,
          attribution: "per-sandbox",
          source: "x",
        },
      }),
    });

    // Daytona's analytics price may or may not include disk, so it is also provisional.
    expect(kinds(result)).toEqual(["unsettled", "provisional"]);
    expect(result.status.settled).toBe(false);
    expect(result.status.provisional).toBe("storage coverage of the billing source unknown");
  });

  it("holds a compute-only bill as provisional when the disk to add is unknown", () => {
    const attempts = ten({
      allocation: { provisioned: null, measured: { cpuQuota: 4, memoryGiB: 8 } },
    });

    expect(check({ attempts }).status.provisional).toBe(
      "billing source leaves storage out and the disk size is unknown",
    );
  });

  it("holds unreconciled meters as provisional", () => {
    const result = check({
      provider: "boxd",
      comparison: "tested-size",
      attempts: metered(),
      audit: {
        ...cleanAudit,
        reconciliation: { kind: "not-reconciled", reason: "no settled charge yet" },
      },
    });

    expect(kinds(result)).toEqual(["provisional"]);
    expect(result.status.provisional).toMatch(/not reconciled/);
  });

  it("accepts meters reconciled within 10% and rejects a wider residual", () => {
    const base = { provider: "boxd", comparison: "tested-size", attempts: metered() } as const;
    expect(check({ ...base, audit: reconciled(0.1) }).kind).toBe("eligible");
    expect(check({ ...base, audit: reconciled(-0.12) }).status.provisional).toMatch(/12\.0%/);
  });

  it("accepts a window mixing profiles only when each charge is attributable", () => {
    const base = {
      provider: "boxd",
      comparison: "tested-size",
      audit: reconciled(0.02, "mixed-profiles"),
    } as const;

    expect(check({ ...base, attempts: metered() }).kind).toBe("eligible");
    expect(kinds(check({ ...base, attempts: metered({ attribution: "none" }) }))).toEqual([
      "not-attributable",
      "provisional",
    ]);
  });

  it("carries a release-level provisional reason even when reconciled (boxd's rate drop)", () => {
    const result = check({
      provider: "boxd",
      comparison: "tested-size",
      attempts: metered(),
      audit: { ...reconciled(0.01), provisional: "unexplained Oct-to-Nov rate change" },
    });

    expect(kinds(result)).toEqual(["provisional"]);
  });

  it("accepts estimates only with confirmed rules and an isolated reconciled window", () => {
    const attempts = ten({ provider: "tenki", cost: { kind: "estimate", source: "rules" } });
    const base = { provider: "tenki", attempts } as const;
    const unconfirmed = check({ ...base, audit: reconciled(0.05) });
    expect(unconfirmed.kind).toBe("ineligible");

    if (unconfirmed.kind === "ineligible")
      expect(unconfirmed.reasons).toEqual([
        { kind: "unverified-estimate", missing: ["rules-confirmed-in-writing"] },
      ]);

    const noWindow = check({
      ...base,
      rule: confirmed(rule("tenki")),
      audit: reconciled(0.05, "mixed-profiles"),
    });

    expect(noWindow.kind === "ineligible" && noWindow.reasons[0]).toEqual({
      kind: "unverified-estimate",
      missing: ["isolated-window-reconciliation"],
    });

    expect(check({ ...base, rule: confirmed(rule("tenki")), audit: reconciled(0.05) }).kind).toBe(
      "eligible",
    );
  });

  it("allows one incomplete run and rejects two", () => {
    const one = [...ten().slice(0, 9), failed({ batch: 9 })];
    expect(check({ attempts: one }).kind).toBe("eligible");
    const two = [...ten().slice(0, 8), failed({ batch: 8 }), failed({ batch: 9 })];
    expect(kinds(check({ attempts: two }))).toEqual(["too-many-incomplete"]);
  });

  it("does not count runs that exceed the plan limit", () => {
    const attempts = [
      ...ten().slice(0, 8),
      failed({ batch: 8, completion: { kind: "not-run", reason: "exceeds-plan-limit" } }),
      failed({ batch: 9, completion: { kind: "not-run", reason: "exceeds-plan-limit" } }),
    ];

    expect(completionCounts(attempts)).toEqual({ attempts: 8, completed: 8, incomplete: 0 });
    expect(check({ attempts }).kind).toBe("eligible");
  });

  it("reports zero completions as did-not-complete", () => {
    const attempts = Array.from({ length: 3 }, (_, batch) =>
      failed({ batch, cost: { kind: "no-sandbox" }, sandboxIds: [] }),
    );

    expect(kinds(check({ attempts }))).toEqual(["did-not-complete", "too-many-incomplete"]);
  });

  it("rejects unavailable and mixed cost evidence", () => {
    const attempts = ten();
    attempts[3] = attempt({ batch: 3, cost: { kind: "unavailable", reason: "HTTP 500" } });
    expect(kinds(check({ attempts }))).toEqual(["cost-unavailable"]);
    attempts[3] = attempt({ batch: 3, cost: { kind: "estimate", source: "rules" } });
    expect(kinds(check({ attempts }))).toEqual(["mixed-cost-kinds"]);
  });
});

describe("same-machine compliance", () => {
  const sized = (cpuQuota: number | null, memoryGiB: number | null) =>
    ten({ allocation: { provisioned: null, measured: { cpuQuota, memoryGiB } } });

  it("needs exactly 4 vCPU by quota and memory within 10% of 8 GiB", () => {
    expect(sameMachineCompliance(sized(4, 7.3)).kind).toBe("compliant");
    expect(sameMachineCompliance(sized(4, 8.7)).kind).toBe("compliant");
    expect(sameMachineCompliance(sized(4, 7.1)).kind).toBe("non-compliant");
    expect(sameMachineCompliance(sized(8, 8)).kind).toBe("non-compliant");
    expect(sameMachineCompliance(sized(null, 8)).kind).toBe("unverified");
  });

  it("excludes boxd's 16 GiB machine from same-machine picks but not from the tested-size pick", () => {
    const attempts = metered().map((a) => ({
      ...a,
      allocation: {
        provisioned: { cpu: 4, memoryGiB: 16, diskGiB: 10 },
        measured: { cpuQuota: 4, memoryGiB: 16 },
      },
    }));

    const base = { provider: "boxd", attempts, audit: reconciled(0.01) } as const;
    expect(kinds(check({ ...base, comparison: "same-machine" }))).toEqual(["size"]);
    expect(check({ ...base, comparison: "tested-size" }).kind).toBe("eligible");
  });

  it("refuses inputs that mix providers or use diagnostics", () => {
    expect(() => check({ attempts: [attempt(), attempt({ purpose: "instrumented" })] })).toThrow();
    expect(() => check({ attempts: ten({ track: "default" }) })).toThrow(/same-spec/);
  });
});
