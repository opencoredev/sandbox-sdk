import { afterEach, describe, expect, it, vi } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { requestedSize } from "../src/allocation.js";
import { cloudProviders } from "../src/attempts.js";
import { collectProvider } from "../src/billing/providers.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { lookupSandbox } from "../src/existence.js";
import { lifetimeOptions } from "../src/lifetime.js";
import { estimateCost, pricing } from "../src/pricing.js";
import { missingCredentials, templateOptions } from "../src/providers.js";
import { provisionedAllocation } from "../src/provisioned-allocations.js";
import { heldOpenProviders } from "../src/realistic/cli.js";
import { providerSetup } from "../src/realistic/setup.js";
import {
  createNamedStyneSnapshot,
  inspectSnapshot,
  snapshotCleaner,
  snapshotsFromSource,
} from "../src/snapshots.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A fake Styne API: each call gets the next answer; the calls are kept. */
function styneApi(...answers: { status: number; json?: unknown }[]) {
  const calls: { url: string; method: string; headers: Headers; body?: string }[] = [];

  vi.stubEnv("STYNE_API_KEY", "styne_test_key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: init.body?.toString(),
      });
      const answer = answers.shift() ?? { status: 500 };

      return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), {
        status: answer.status,
      });
    }),
  );

  return calls;
}

const styneProvider = { ...memory(), name: "styne" };

describe("Styne bench registration", () => {
  it("is a cloud provider with Styne's sizes and its base template's allocation", () => {
    expect(cloudProviders).toContain("styne");
    expect(requestedSize("styne", "small")).toEqual({ cpu: 2, memoryGiB: 4 });
    expect(requestedSize("styne", "medium")).toEqual({ cpu: 4, memoryGiB: 8 });
    expect(requestedSize("styne", "large")).toEqual({ cpu: 8, memoryGiB: 16 });
    expect(provisionedAllocation("styne", null)).toEqual({ cpu: 4, memoryGiB: 8, diskGiB: 51 });
    expect(provisionedAllocation("styne", "xlarge")).toEqual({
      cpu: 16,
      memoryGiB: 32,
      diskGiB: 251,
    });
    expect(templateOptions("styne", "large")).toEqual({ template: "large" });
    expect(missingCredentials("styne", {})).toEqual(["STYNE_API_KEY"]);
  });

  it("prices each size at its published hourly rate, disk included", () => {
    expect(estimateCost("styne", 3_600_000, { cpu: 4, memoryGiB: 8, diskGiB: 51 })).toBeCloseTo(
      0.032,
      9,
    );
    expect(estimateCost("styne", 1_800_000, { cpu: 16, memoryGiB: 32, diskGiB: 251 })).toBeCloseTo(
      0.064,
      9,
    );
    expect(estimateCost("styne", 3_600_000, { cpu: 3, memoryGiB: 6, diskGiB: 51 })).toBeNull();
    expect(pricing.styne?.retrieved).toBe("2026-11-23");
  });

  it("is an estimate with no per-sandbox billing, and joins both realistic tracks and the held-open test", async () => {
    expect(billingRule("styne", null)).toMatchObject({
      pricingKey: "styne",
      reportedKind: "estimate",
      attribution: "none",
    });

    const transport = vi.fn(async () => ({}));

    const costs = await collectProvider(
      "styne",
      [
        {
          provider: "styne",
          id: "vm1",
          scenarios: new Set(["sandbox-lifetime"]),
          startedAt: "2026-11-23T10:00:00.000Z",
          finishedAt: "2026-11-23T10:05:00.000Z",
          confirmedStopAt: null,
          app: null,
        },
      ],
      { STYNE_API_KEY: "styne_test_key" },
      transport,
    );

    expect(costs.source).toMatch(/No per-sandbox billing endpoint/);
    expect(costs.sandboxes.map((s) => s.cost.kind)).toEqual(["unavailable"]);
    expect(transport).not.toHaveBeenCalled();

    const setup = providerSetup("styne");
    expect(setup).toMatchObject({ adapter: "styne", lifetime: true, pricingKey: "styne" });
    expect(setup.tracks["same-machine"]).toMatchObject({
      size: { cpu: 4, memoryMb: 8192 },
      provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 51 },
    });
    expect(setup.tracks.default.size).toBeUndefined();
    expect(heldOpenProviders).toContain("styne");
  });

  it("gets a factory lifetime, as Modal does", () => {
    expect(lifetimeOptions("styne", { "timeout-ms": 180_000 })).toEqual({
      timeoutMs: 180_000 * 19,
    });
    expect(() => lifetimeOptions("styne", { "lifetime-ms": { styne: 90_000_000 } })).toThrow(
      /24 hours/,
    );
  });
});

describe("Styne existence", () => {
  it("reads with GET only, and an ended sandbox's 410 or a 404 is absent", async () => {
    const calls = styneApi(
      { status: 200, json: { sandboxID: "vm1", state: "running" } },
      { status: 200, json: { sandboxID: "vm1", state: "paused" } },
      { status: 410, json: { error_code: "sandbox_ended", sandboxID: "vm1", state: "killed" } },
      { status: 410, json: { error_code: "node_loss" } },
      { status: 404, json: { error_code: "not_found" } },
      { status: 503, json: { error_code: "upstream_unavailable" } },
    );

    const results = [];

    for (let i = 0; i < 6; i++) results.push(await lookupSandbox(styneProvider, "vm1", 1000));

    expect(results.map((r) => r.result)).toEqual([
      "present",
      "present",
      "terminal",
      "terminal",
      "not-found",
      "unavailable",
    ]);
    expect(
      calls.every((c) => c.method === "GET" && c.url === "https://api.styne.ai/sandboxes/vm1"),
    ).toBe(true);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer styne_test_key");
  });
});

describe("Styne snapshots", () => {
  it("decodes sandboxID for provenance and reads a deleted name as absent", async () => {
    styneApi(
      { status: 200, json: { name: "bench-r-1", sandboxID: "vm1", snapshotID: "snap1" } },
      { status: 404, json: { error_code: "not_found" } },
      { status: 200, json: { name: "bench-r-1" } },
    );

    expect(await inspectSnapshot("styne", styneProvider, "vm1", "bench-r-1")).toEqual({
      exists: true,
      sourceId: "vm1",
    });
    expect(await inspectSnapshot("styne", styneProvider, "vm1", "bench-r-1")).toEqual({
      exists: false,
    });
    // Styne records a snapshot's source; one without it cannot authorize a delete.
    await expect(inspectSnapshot("styne", styneProvider, "vm1", "bench-r-1")).rejects.toThrow(
      /source metadata/,
    );
  });

  it("creates under the journaled name, lists by source, and deletes by name", async () => {
    const calls = styneApi(
      { status: 201, json: { name: "bench-r-1", sandboxID: "vm1" } },
      {
        status: 200,
        json: [
          { name: "bench-r-1", sandboxID: "vm1" },
          { name: "other", sandboxID: "vm2" },
        ],
      },
      { status: 204 },
      { status: 404, json: { error_code: "not_found" } },
    );

    expect(await createNamedStyneSnapshot("vm1", "bench-r-1")).toEqual({ id: "bench-r-1" });
    expect(JSON.parse(calls[0]!.body ?? "")).toEqual({ name: "bench-r-1" });
    expect(calls[0]!.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await snapshotsFromSource("styne", "vm1")).toEqual([
      { id: "bench-r-1", name: "bench-r-1" },
    ]);

    const clean = await snapshotCleaner("styne", styneProvider, "vm1");
    await clean("bench-r-1");
    await clean("bench-r-1");
    expect(calls.slice(2).map((c) => [c.method, c.url])).toEqual([
      ["DELETE", "https://api.styne.ai/snapshots/bench-r-1"],
      ["DELETE", "https://api.styne.ai/snapshots/bench-r-1"],
    ]);
  });
});
