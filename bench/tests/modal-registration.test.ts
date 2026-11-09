import { describe, expect, it } from "vitest";
import { cloudProviders } from "../src/attempts.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { pricing } from "../src/pricing.js";
import { heldOpenProviders } from "../src/realistic/cli.js";
import { providerSetup } from "../src/realistic/setup.js";
import { attributionFor } from "../src/realistic/slots.js";
import { parseV2 } from "../src/v2-config.js";

describe("Modal bench registration", () => {
  it("is a cloud provider and in the default provider list", () => {
    expect(cloudProviders).toContain("modal");
    expect(parseV2([]).providers).toContain("modal");
  });

  it("runs both realistic tracks: same-machine pinned to 4 CPU / 8 GiB, default unsized", () => {
    const setup = providerSetup("modal");

    expect(setup).toMatchObject({ adapter: "modal", product: null, lifetime: true });
    expect(pricing[setup.pricingKey]).toBeDefined();
    expect(setup.tracks["same-machine"]).toMatchObject({
      size: { cpu: 4, memoryMb: 8192 },
      vcpu: 4,
      provisioned: { cpu: 4, memoryGiB: 8 },
      tooSmall: {},
    });
    // Unsized: Modal's 0.125 CPU / 128 MiB request, nproc 1, no memory limit, so no fit exclusions.
    expect(setup.tracks.default.size).toBeUndefined();
    expect(setup.tracks.default).toMatchObject({
      vcpu: 1,
      provisioned: { cpu: 0.125, memoryGiB: 0.125 },
      tooSmall: {},
    });
  });

  it("joins the held-open diagnostic", () => {
    expect(heldOpenProviders).toContain("modal");
  });

  it("has a billing rule: metered per App, one sandbox per App", () => {
    const rule = billingRule("modal", null);

    expect(rule).toMatchObject({
      pricingKey: "modal",
      reportedKind: "metered",
      attribution: "per-sandbox",
    });
    expect(attributionFor("modal").attribution).toBe("per-sandbox");
  });
});
