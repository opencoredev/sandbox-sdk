import { describe, expect, it } from "vitest";
import { cloudProviders } from "../src/attempts.js";
import { pricing } from "../src/pricing.js";
import {
  billingModelLabel,
  billingRule,
  billingRules,
  type BillingRule,
} from "../src/cost/billing-rules.js";
import {
  billedTime,
  reportedCost,
  smallestSizeListPrice,
  usageListPrice,
  wholeMachineListPrice,
  type AttemptCostInput,
} from "../src/cost/columns.js";
import { attempt } from "./cost-fixtures.js";

const fx = { eurToUsd: 1.1, date: "2026-11-05" };

function rule(provider: string, product: string | null = null) {
  const found = billingRule(provider, product);

  if (!found) throw new Error(`No rule for ${provider}`);

  return found;
}

const input = (provider: string, patch: Parameters<typeof attempt>[0] = {}): AttemptCostInput => ({
  attempt: attempt({ provider, ...patch }),
  rule: rule(provider),
  fx,
});

describe("billing rules", () => {
  it("has a row for every cloud provider and Upstash Ephemeral, all unconfirmed", () => {
    for (const provider of cloudProviders) expect(billingRule(provider, null)).not.toBeNull();
    expect(billingRule("upstash", "ephemeral")).not.toBeNull();
    expect(billingRule("upstash-ephemeral", null)).toBe(billingRule("upstash", "ephemeral"));

    expect(billingRules.every((r) => r.confirmation.kind === "unconfirmed-from-docs")).toBe(true);
  });

  it("marks unknowns as unknown instead of guessing", () => {
    expect(rule("boat").settledChargeSource.kind).toBe("unknown");
    expect(rule("e2b").settledChargeSource.kind).toBe("unknown");
    expect(rule("boxd").countsFileCacheAsMemory.kind).toBe("unknown");
    expect(rule("upstash", "ephemeral").tariff.kind).toBe("unknown");
    expect(rule("tenki").attribution).toBe("none");
  });

  it("agrees with the price table wherever both state a billing increment", () => {
    for (const r of billingRules) {
      const price = r.pricingKey === null ? undefined : pricing[r.pricingKey];

      if (r.incrementSeconds.kind === "known" && price)
        expect(r.incrementSeconds.value).toBe(price.incrementSeconds);
    }
  });

  it("names each billing model", () => {
    expect(billingModelLabel(rule("boxd"))).toBe("bills active CPU and memory in use");
    expect(billingModelLabel(rule("boat"))).toBe("bills the whole machine while it exists");
    expect(billingModelLabel(rule("upstash", "ephemeral"))).toBeNull();
  });
});

/** E2B's row with its billing events marked known, as a written confirmation would. */
const withEvents = (): BillingRule => ({
  ...rule("e2b"),
  billingStarts: { kind: "known", value: "sandbox-created", source: "fixture" },
  billingStops: { kind: "known", value: "delete-confirmed", source: "fixture" },
});

describe("billed time", () => {
  it("uses the rule's events when observed", () => {
    expect(billedTime(attempt(), withEvents())).toEqual({
      seconds: 298,
      basis: "billing-events",
      assumptions: ["billing minimum unknown; none assumed"],
    });
  });

  it("falls back to the elapsed envelope and says so", () => {
    const time = billedTime(attempt({ createdAt: null, deleteRequestedAt: null }), withEvents());

    expect(time.seconds).toBe(300);
    expect(time.basis).toBe("elapsed-envelope");
    expect(time.assumptions).toContain("sandbox-created not observed; envelope edge used");

    expect(billedTime(attempt(), rule("daytona")).assumptions).toContain(
      "billing increment unknown; one second assumed",
    );
  });
});

describe("cost columns", () => {
  it("prices Modal's whole machine at the run's pinned region, like its costs", () => {
    const sized = (region?: string | null) =>
      wholeMachineListPrice({
        ...input("modal", {
          allocation: {
            provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 0 },
            measured: { cpuQuota: 4, memoryGiB: 8 },
          },
        }),
        ...(region === undefined ? {} : { region }),
      });

    const base = sized();
    const pinned = sized("us-east");

    expect(base.kind).toBe("list-price");
    expect(pinned.kind).toBe("list-price");

    if (base.kind !== "list-price" || pinned.kind !== "list-price") return;
    // 4 CPU and 8 GiB at Modal's sandbox rates for 300 s, then 1.75x for a narrow pinned region.
    const modal = pricing.modal;

    if (!modal) throw new Error("No Modal pricing");
    expect(base.usd).toBeCloseTo((4 * modal.cpuSecond + 8 * modal.memoryGiBSecond) * 300, 10);
    expect(pinned.usd).toBeCloseTo(base.usd * 1.75, 10);
    expect(sized("us").kind === "list-price" && sized("us")).toMatchObject({
      usd: expect.closeTo(base.usd * 1.15, 10),
    });
    expect(sized(null)).toEqual(base);
  });

  it("prices boxd's whole machine as a counterfactual in USD at the frozen rate", () => {
    const whole = wholeMachineListPrice(
      input("boxd", {
        allocation: {
          provisioned: { cpu: 4, memoryGiB: 16, diskGiB: 10 },
          measured: { cpuQuota: 4, memoryGiB: 16 },
        },
      }),
    );

    expect(whole.kind).toBe("list-price");

    if (whole.kind !== "list-price") return;
    expect(whole.counterfactual).toBe(true);
    // EUR 0.348/h for 300 s plus 10 GiB disk, at 1.1 USD/EUR.
    expect(whole.usd).toBeCloseTo((0.348 / 12 + (10 * 0.00008) / 12) * 1.1, 10);
  });

  it("prices boxd's usage from validated usage only", () => {
    const usage = {
      source: "provider-report",
      validated: true,
      cpuSeconds: 120,
      memoryGiBSeconds: 600,
      diskGiBSeconds: null,
    } as const;

    const priced = usageListPrice(input("boxd", { usage }));
    expect(priced.kind).toBe("list-price");

    if (priced.kind === "list-price")
      expect(priced.usd).toBeCloseTo(
        ((120 * 0.039 + 600 * 0.012 + 3000 * 0.00008) / 3600) * 1.1,
        12,
      );

    expect(usageListPrice(input("boxd", { usage: { ...usage, validated: false } })).kind).toBe(
      "unavailable",
    );

    expect(usageListPrice(input("boxd")).kind).toBe("unavailable");
  });

  it("reads 'not applicable' for a bundled or allocation-priced tariff's usage column", () => {
    expect(usageListPrice(input("boat")).kind).toBe("not-applicable");

    const used = {
      source: "provider-report",
      validated: true,
      cpuSeconds: 1,
      memoryGiBSeconds: 1,
      diskGiBSeconds: 1,
    } as const;

    expect(usageListPrice(input("daytona", { usage: used }))).toEqual({
      kind: "not-applicable",
      reason: "priced on the allocation, not on use",
    });
    const whole = wholeMachineListPrice(input("boat"));
    expect(whole).toMatchObject({ kind: "list-price", counterfactual: false });

    if (whole.kind === "list-price") expect(whole.usd).toBeCloseTo(0.036 / 12, 12);
  });

  it("adds list-price disk where the billing source leaves storage out, marked estimated", () => {
    const reported = reportedCost(input("upstash"));
    expect(reported.kind).toBe("billed");

    if (reported.kind !== "billed") return;
    expect(reported.storage).toBe("added-at-list-price");
    const disk = reported.parts.find((p) => p.label === "disk at list price");
    expect(disk?.estimated).toBe(true);
    expect(disk?.usd).toBeCloseTo((10 * 0.1 * 300) / (30 * 86400), 12);
    expect(reported.usd).toBeCloseTo(0.02 + (disk?.usd ?? 0), 12);
  });

  it("prices Tenki estimates from the billing rules, every part estimated", () => {
    const reported = reportedCost(
      input("tenki", { charge: { kind: "estimate", source: "rules" } }),
    );

    expect(reported.kind).toBe("estimate");

    if (reported.kind !== "estimate") return;
    expect(reported.usd).toBeCloseTo(
      (4 * 0.000014 + 8 * 0.0000045) * 300 + 5 * 0.00000003 * 300,
      12,
    );
    expect(reported.parts.every((p) => p.estimated)).toBe(true);
    expect(reported.assumptions).toContain("per-start fee unknown; none added");
  });

  it("costs nothing when nothing was created, and is unavailable without evidence", () => {
    expect(
      reportedCost(
        input("e2b", {
          sandboxIds: [],
          completion: { kind: "incomplete", reason: "create-failed", detail: "fixture" },
        }),
      ),
    ).toEqual({
      kind: "nothing-created",
      usd: 0,
    });

    expect(
      reportedCost(input("e2b", { charge: { kind: "unavailable", reason: "HTTP 500" } })).kind,
    ).toBe("unavailable");
  });

  it("prices the smallest sufficient size only for whole-allocation billing", () => {
    const smallest = smallestSizeListPrice({
      ...input("e2b"),
      size: { cpu: 2, memoryGiB: 4, seconds: 100.4 },
    });

    expect(smallest.kind).toBe("counterfactual");

    if (smallest.kind === "counterfactual")
      expect(smallest.usd).toBeCloseTo(((2 * 0.000014 + 4 * 0.0000045) * 3600 * 101) / 3600, 12);

    expect(
      smallestSizeListPrice({ ...input("boxd"), size: { cpu: 2, memoryGiB: 8, seconds: 100 } })
        .kind,
    ).toBe("not-applicable");

    expect(
      smallestSizeListPrice({ ...input("boat"), size: { cpu: 3, memoryGiB: 6, seconds: 100 } })
        .kind,
    ).toBe("unavailable");
  });
});
