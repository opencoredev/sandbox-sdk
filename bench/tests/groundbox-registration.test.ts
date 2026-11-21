import { memory } from "@opencoredev/sandbox-sdk/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestedSize } from "../src/allocation.js";
import { cloudProviders } from "../src/attempts.js";
import { collectProvider, decodeGroundbox, type Transport } from "../src/billing/providers.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { lookupSandbox } from "../src/existence.js";
import { estimateCost } from "../src/pricing.js";
import { missingCredentials } from "../src/providers.js";
import { provisionedAllocation } from "../src/provisioned-allocations.js";
import { heldOpenProviders } from "../src/realistic/cli.js";
import { providerSetup } from "../src/realistic/setup.js";
import { inspectSnapshot } from "../src/snapshots.js";

const usage = {
  sandbox_id: "sbx_abc123def456",
  running_seconds: 90,
  busy_core_hours: 0.01,
  memory_gb_hours: 0.2,
  storage_gb_hours: 0,
  compute_cost_micros: 2000,
  storage_cost_micros: 0,
  cost_micros: 2000,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Groundbox bench registration", () => {
  it("is a cloud provider with Groundbox's sizes and key", () => {
    expect(cloudProviders).toContain("groundbox");
    expect(missingCredentials("groundbox", {})).toEqual(["GROUNDBOX_API_KEY"]);
    expect(requestedSize("groundbox", "small")).toEqual({ cpu: 2, memoryGiB: 4 });
    expect(requestedSize("groundbox", "medium")).toEqual({ cpu: 4, memoryGiB: 8 });
    expect(provisionedAllocation("groundbox", null)).toMatchObject({ cpu: 2, memoryGiB: 4 });
  });

  it("prices vCPUs only: memory up to 4 GiB per vCPU and a running disk are included", () => {
    const hour = estimateCost("groundbox", 3_600_000, { cpu: 4, memoryGiB: 8, diskGiB: 59 });

    expect(hour).toBeCloseTo(4 * 0.04, 9);
  });

  it("runs same-machine on 4 vCPU / 8 GiB and joins the held-open test", () => {
    const setup = providerSetup("groundbox");

    expect(setup).toMatchObject({ adapter: "groundbox", lifetime: true, pricingKey: "groundbox" });
    expect(setup.tracks["same-machine"]).toMatchObject({
      size: { cpu: 4, memoryMb: 8192 },
      vcpu: 4,
    });
    expect(setup.tracks.default.size).toBeUndefined();
    expect(heldOpenProviders).toContain("groundbox");
  });

  it("has a metered, per-sandbox billing rule", () => {
    expect(billingRule("groundbox", null)).toMatchObject({
      pricingKey: "groundbox",
      reportedKind: "metered",
      attribution: "per-sandbox",
    });
  });
});

describe("Groundbox billing", () => {
  it("reads Groundbox's meter; it is final once the sandbox has ended", () => {
    expect(decodeGroundbox(usage, { ended: true })).toMatchObject({
      kind: "metered",
      usd: 0.002,
      scope: "sandbox-lifetime",
      complete: true,
    });
    expect(decodeGroundbox(usage, { ended: false })).toMatchObject({
      scope: "window",
      complete: false,
      confidence: "low",
    });
  });

  it("reads the state before the usage, with the key as a bearer token", async () => {
    const urls: string[] = [];

    const transport: Transport = async (url, headers) => {
      urls.push(url);
      expect(headers.Authorization).toBe("Bearer gbx_test");

      if (url.endsWith("/usage")) return usage;

      return { status: url.includes("sbx_gone") ? "stopped" : "running" };
    };

    const row = (id: string) => ({
      provider: "groundbox",
      id,
      scenarios: new Set(["sandbox-lifetime"]),
      startedAt: "2026-11-20T10:00:00.000Z",
      finishedAt: "2026-11-20T10:05:00.000Z",
      confirmedStopAt: null,
      app: null,
    });

    const result = await collectProvider(
      "groundbox",
      [row("sbx_gone"), row("sbx_live")],
      { GROUNDBOX_API_KEY: "gbx_test" },
      transport,
    );

    expect(
      result.sandboxes.map((s) => [s.id, s.cost.kind === "metered" && s.cost.complete]),
    ).toEqual([
      ["sbx_gone", true],
      ["sbx_live", false],
    ]);
    expect(urls.slice(0, 2)).toEqual([
      "https://api.groundbox.dev/v1/sandboxes/sbx_gone",
      "https://api.groundbox.dev/v1/sandboxes/sbx_gone/usage",
    ]);
  });
});

describe("Groundbox existence and snapshots", () => {
  it("a deleted sandbox, which still answers as stopped, is terminal", async () => {
    vi.stubEnv("GROUNDBOX_API_KEY", "gbx_test");
    vi.stubGlobal("fetch", async () => Response.json({ id: "sbx_gone", status: "stopped" }));

    const found = await lookupSandbox({ ...memory(), name: "groundbox" }, "sbx_gone", 1000);

    expect(found.result).toBe("terminal");
  });

  it("a deleted snapshot, which still answers, does not exist", async () => {
    vi.stubEnv("GROUNDBOX_API_KEY", "gbx_test");
    vi.stubGlobal("fetch", async () =>
      Response.json({ id: "snap_abc", status: "deleted", source_sandbox_id: "sbx_a" }),
    );

    expect(
      await inspectSnapshot("groundbox", { ...memory(), name: "groundbox" }, "sbx_a", "snap_abc"),
    ).toEqual({ exists: false });
  });
});
