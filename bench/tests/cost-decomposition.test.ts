import { describe, expect, it } from "vitest";
import { billingRule } from "../src/cost/billing-rules.js";
import {
  comparisonLine,
  decompose,
  providerLine,
  sumsToReported,
} from "../src/cost/decomposition.js";
import { attempt } from "./cost-fixtures.js";

const fx = { eurToUsd: 1.1, date: "2026-11-05" };

function rule(provider: string) {
  const found = billingRule(provider, null);

  if (!found) throw new Error(`No rule for ${provider}`);

  return found;
}

/** A 300 s boxd attempt on 4 vCPU / 16 GiB / 10 GiB that used 120 CPU-s and 600 GiB-s, metered at $0.003. */
const boxd = (patch: Parameters<typeof attempt>[0] = {}) =>
  attempt({
    provider: "boxd",
    allocation: {
      provisioned: { cpu: 4, memoryGiB: 16, diskGiB: 10 },
      measured: { cpuQuota: 4, memoryGiB: 16 },
    },
    usage: {
      source: "provider-report",
      validated: true,
      cpuSeconds: 120,
      memoryGiBSeconds: 600,
      diskGiBSeconds: null,
    },
    cost: {
      kind: "metered",
      usd: 0.003,
      settled: true,
      attribution: "per-machine",
      source: "meter",
    },
    ...patch,
  });

describe("within-provider decomposition", () => {
  it("splits whole machine minus reported into idle CPU, unused memory and a residual that sum exactly", () => {
    const d = decompose({ attempts: [boxd(), boxd({ batch: 1 })], rule: rule("boxd"), fx });
    expect(d.kind).toBe("decomposed");

    if (d.kind !== "decomposed") return;
    // Worked by hand per attempt: EUR 0.348/h x 300 s + 10 GiB disk; 1,080 idle vCPU-s at
    // EUR 0.039/h; 4,200 unused GiB-s at EUR 0.012/h; all x 1.1 USD/EUR.
    expect(d.wholeMachineUSD).toBeCloseTo(2 * 0.031973333, 8);
    expect(d.idleCpuUSD).toBeCloseTo(2 * 0.01287, 10);
    expect(d.unusedMemoryUSD).toBeCloseTo(2 * 0.0154, 10);
    expect(d.reportedUSD).toBeCloseTo(0.006, 12);
    expect(d.residualUSD).toBeCloseTo(2 * (0.031973333 - 0.003 - 0.01287 - 0.0154), 8);
    expect(sumsToReported(d)).toBe(true);
    expect(sumsToReported({ ...d, residualUSD: d.residualUSD + 0.001 })).toBe(false);
  });

  it("is unavailable for bundles and without validated usage", () => {
    expect(
      decompose({ attempts: [attempt({ provider: "boat" })], rule: rule("boat"), fx }),
    ).toEqual({
      kind: "unavailable",
      reason: "only for tariffs priced per unit of use",
    });

    expect(decompose({ attempts: [boxd({ usage: null })], rule: rule("boxd"), fx }).kind).toBe(
      "unavailable",
    );
  });
});

describe("plain-language lines", () => {
  const decomposition = decompose({ attempts: [boxd()], rule: rule("boxd"), fx });

  it("states the ratio and the measured dense change, and 'mainly' only from a decomposition", () => {
    const base = {
      provider: "boxd",
      kind: "metered",
      reportedUSD: 0.003,
      wholeMachineUSD: decomposition.kind === "decomposed" ? decomposition.wholeMachineUSD : 0,
      denseOverPaced: 4,
      provisional: null,
    } as const;

    expect(providerLine({ ...base, decomposition: null })).toBe(
      "boxd's usage meter showed 0.094 of what the whole machine would cost at its own list price, and removing the pauses raised its cost 4x.",
    );

    expect(providerLine({ ...base, decomposition })).toBe(
      "boxd's usage meter showed 0.094 of what the whole machine would cost at its own list price, and removing the pauses raised its cost 4x, mainly because of unused memory (53% of the difference).",
    );
  });

  it("drops 'mainly' when the decomposition describes different totals", () => {
    expect(
      providerLine({
        provider: "boxd",
        kind: "metered",
        reportedUSD: 90,
        wholeMachineUSD: 100,
        decomposition,
        denseOverPaced: null,
        provisional: null,
      }),
    ).toBe(
      "boxd's usage meter showed 0.9 of what the whole machine would cost at its own list price.",
    );
  });

  it("says 'charged' only for bills and marks provisional figures", () => {
    const line = providerLine({
      provider: "upstash",
      kind: "billed",
      reportedUSD: 0.01,
      wholeMachineUSD: 0.02,
      decomposition: null,
      denseOverPaced: null,
      provisional: "settles in 48 hours",
    });

    expect(line).toBe(
      "upstash charged 0.5 of what the whole machine would cost at its own list price. Provisional: settles in 48 hours.",
    );

    expect(
      providerLine({
        provider: "tenki",
        kind: "estimate",
        reportedUSD: 1,
        wholeMachineUSD: 1,
        decomposition: null,
        denseOverPaced: null,
        provisional: null,
      }),
    ).toMatch(/^We estimate tenki at 1 of/);

    expect(
      providerLine({
        provider: "e2b",
        kind: "metered",
        reportedUSD: 1,
        wholeMachineUSD: null,
        decomposition: null,
        denseOverPaced: null,
        provisional: null,
      }),
    ).toBeNull();
  });

  it("compares providers by observed difference with each billing model, no causes", () => {
    expect(
      comparisonLine(
        { provider: "upstash", kind: "billed", usd: 0.02, rule: rule("upstash") },
        { provider: "boxd", kind: "metered", usd: 0.003, rule: rule("boxd") },
      ),
    ).toBe(
      "upstash charged $0.02 per completed task (bills a fixed size per active hour); boxd's usage meter showed $0.003 per completed task (bills active CPU and memory in use): a difference of $0.017.",
    );
  });
});
