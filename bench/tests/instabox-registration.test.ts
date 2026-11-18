import { describe, expect, it } from "vitest";
import { requestedSize } from "../src/allocation.js";
import { cloudProviders } from "../src/attempts.js";
import {
  BillingHttpError,
  collectProvider,
  decodeInstabox,
  instaboxUsageQuery,
  type Transport,
} from "../src/billing/providers.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { estimateCost, pricing } from "../src/pricing.js";
import { provisionedAllocation } from "../src/provisioned-allocations.js";
import { heldOpenProviders } from "../src/realistic/cli.js";
import { providerSetup } from "../src/realistic/setup.js";

const usage = {
  from: "2026-11-17T12:00:00Z",
  to: "2026-11-18T13:47:49Z",
  runningSeconds: 100,
  vcpuSeconds: 400,
  memGiBSeconds: 800,
  diskGiBSeconds: 2000,
  egressBytes: 3605,
};

describe("Instabox bench registration", () => {
  it("is a cloud provider with Instabox's sizes", () => {
    expect(cloudProviders).toContain("instabox");
    expect(requestedSize("instabox", "small")).toEqual({ cpu: 2, memoryGiB: 4 });
    expect(requestedSize("instabox", "medium")).toEqual({ cpu: 4, memoryGiB: 8 });
    expect(provisionedAllocation("instabox", null)).toMatchObject({ cpu: 4, memoryGiB: 8 });
  });

  it("prices compute only: the 20 GiB disk is included", () => {
    const hour = estimateCost("instabox", 3_600_000, { cpu: 4, memoryGiB: 8, diskGiB: 20 });

    expect(hour).toBeCloseTo(4 * 0.004 + 8 * 0.00225, 9);
  });

  it("runs both realistic tracks on 4 vCPU / 8 GiB and joins the held-open test", () => {
    const setup = providerSetup("instabox");

    expect(setup).toMatchObject({ adapter: "instabox", lifetime: true, pricingKey: "instabox" });
    expect(setup.tracks["same-machine"]).toMatchObject({
      size: { cpu: 4, memoryMb: 8192 },
      provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 20 },
    });
    expect(setup.tracks.default.size).toBeUndefined();
    expect(heldOpenProviders).toContain("instabox");
  });

  it("has a metered, per-sandbox billing rule", () => {
    expect(billingRule("instabox", null)).toMatchObject({
      pricingKey: "instabox",
      reportedKind: "metered",
      attribution: "per-sandbox",
    });
  });
});

describe("Instabox billing", () => {
  it("prices vCPU-seconds and GiB-seconds at the published rates", () => {
    const cost = decodeInstabox(usage, true);
    const rate = pricing.instabox!;

    expect(cost).toMatchObject({ kind: "metered", scope: "sandbox-lifetime", complete: true });
    expect(cost.kind === "metered" && cost.usd).toBeCloseTo(
      400 * rate.cpuSecond + 800 * rate.memoryGiBSecond,
      12,
    );
    expect(decodeInstabox(usage, false)).toMatchObject({ complete: false, confidence: "low" });
  });

  it("asks for a window from a day before the first sample to now", () => {
    const query = instaboxUsageQuery(
      { startedAt: "2026-11-18T10:00:00.000Z" },
      Date.parse("2026-11-18T12:00:00.000Z"),
    );

    expect(query.get("from")).toBe("2026-11-17T10:00:00.000Z");
    expect(query.get("to")).toBe("2026-11-18T12:00:00.000Z");
    expect(instaboxUsageQuery({ startedAt: null }).has("from")).toBe(false);
  });

  it("collects usage per machine; a 404 on the machine makes it final", async () => {
    const urls: string[] = [];

    const transport: Transport = async (url, headers) => {
      urls.push(url);
      expect(headers["X-API-Key"]).toBe("ibk_test");

      if (url.includes("/usage")) return usage;

      if (url.endsWith("/m_gone")) throw new BillingHttpError(404);

      return { id: "m_live" };
    };

    const row = (id: string) => ({
      provider: "instabox",
      id,
      scenarios: new Set(["sandbox-lifetime"]),
      startedAt: "2026-11-18T10:00:00.000Z",
      finishedAt: "2026-11-18T10:05:00.000Z",
      confirmedStopAt: null,
      app: null,
    });

    const result = await collectProvider(
      "instabox",
      [row("m_gone"), row("m_live")],
      { INSTABOX_API_KEY: "ibk_test" },
      transport,
    );

    expect(
      result.sandboxes.map((s) => [s.id, s.cost.kind === "metered" && s.cost.complete]),
    ).toEqual([
      ["m_gone", true],
      ["m_live", false],
    ]);
    expect(urls[0]).toMatch(/^https:\/\/api\.instabox\.sh\/v1\/machines\/m_gone\/usage\?to=/);
  });
});
