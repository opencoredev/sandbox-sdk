import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { requestedSize } from "../src/allocation.js";
import { archilControlUrl, archilSandboxBody } from "../src/archil.js";
import { cloudProviders } from "../src/attempts.js";
import {
  BillingHttpError,
  collectProvider,
  decodeArchil,
  type Transport,
} from "../src/billing/providers.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { collectionPolicy } from "../src/collection-policy.js";
import { classifyFailure } from "../src/merge.js";
import { estimateCost } from "../src/pricing.js";
import { missingCredentials } from "../src/providers.js";
import { provisionedAllocation } from "../src/provisioned-allocations.js";
import { accountCaps } from "../src/realistic/burst.js";
import { heldOpenProviders } from "../src/realistic/cli.js";
import { providerSetup } from "../src/realistic/setup.js";
import { parseV2 } from "../src/v2-config.js";
import type { Sample } from "../src/v2-model.js";

const usage = {
  vcpu_hours: 0.5,
  memory_gib_hours: 1,
  rates: { vcpu_hour: 0.055, memory_gib_hour: 0.02 },
  cost: 0.0475,
  as_of: "2026-11-21T10:08:00Z",
};

describe("Archil bench registration", () => {
  it("is a cloud provider with the adapter's sizes and one credential", () => {
    expect(cloudProviders).toContain("archil");
    expect(requestedSize("archil", "small")).toEqual({ cpu: 1, memoryGiB: 2 });
    expect(requestedSize("archil", "medium")).toEqual({ cpu: 2, memoryGiB: 4 });
    expect(requestedSize("archil", "large")).toEqual({ cpu: 4, memoryGiB: 8 });
    expect(provisionedAllocation("archil", null)).toEqual({ cpu: 1, memoryGiB: 2, diskGiB: 0 });
    expect(missingCredentials("archil", {})).toEqual(["ARCHIL_API_KEY"]);
    expect(missingCredentials("archil", { ARCHIL_API_KEY: "key" })).toEqual([]);
  });

  it("prices compute only, at the published rates", () => {
    const hour = estimateCost("archil", 3_600_000, { cpu: 4, memoryGiB: 8, diskGiB: 1000 });

    expect(hour).toBeCloseTo(4 * 0.055 + 8 * 0.02, 9);
  });

  it("runs the same-machine track on 4 vCPU / 8 GiB and the default on Archil's 1 / 2 GiB", () => {
    const setup = providerSetup("archil");

    expect(setup).toMatchObject({ adapter: "archil", lifetime: true, pricingKey: "archil" });
    expect(setup.tracks["same-machine"]).toMatchObject({
      size: { cpu: 4, memoryMb: 8192 },
      provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 0 },
    });
    expect(setup.tracks.default.size).toBeUndefined();
    expect(setup.tracks.default.provisioned).toEqual({ cpu: 1, memoryGiB: 2, diskGiB: 0 });
    expect(heldOpenProviders).toContain("archil");
  });

  it("has a billed, per-sandbox billing rule whose increment is unknown", () => {
    const rule = billingRule("archil", null);

    expect(rule).toMatchObject({
      pricingKey: "archil",
      reportedKind: "billed",
      attribution: "per-sandbox",
    });
    expect(rule?.incrementSeconds.kind).toBe("unknown");
  });

  it("refuses a disk size before the run, and keeps cpu:memory sizes", () => {
    expect(() => parseV2(["--size", "archil=4:8192:20"])).toThrow(/no disk size option/);
    expect(parseV2(["--size", "archil=4:8192"]).size.archil).toEqual({ cpu: 4, memoryMb: 8192 });
    // Other providers are unchanged.
    expect(parseV2(["--size", "daytona=4:8192:20"]).size.daytona).toMatchObject({ diskGb: 20 });
  });

  it("caps realistic bursts at the Developer plan's 20 sandboxes", () => {
    expect(accountCaps.get("archil")).toMatchObject({ sandboxes: 20 });
  });

  it("reads the control plane of the key's region", () => {
    expect(archilControlUrl(undefined)).toBe("https://control.green.us-east-1.aws.prod.archil.com");
    expect(archilControlUrl("aws-eu-west-1")).toBe(
      "https://control.green.eu-west-1.aws.prod.archil.com",
    );
    expect(() => archilControlUrl("mars-1")).toThrow(/Unknown ARCHIL_REGION/);
  });
});

describe("Archil failures", () => {
  const failed = (
    scenario: string,
    outcome: Partial<Extract<Sample["outcome"], { kind: "failure" }>>,
  ) =>
    ({
      provider: "archil",
      scenario,
      outcome: { kind: "failure" as const, note: "Archil request failed", ...outcome },
    }) satisfies Pick<Sample, "provider" | "scenario" | "outcome">;

  it("a create refused for the plan's cap is an account limit, not a provider failure", () => {
    expect(classifyFailure(failed("cold", { code: "quota" }))).toBe("provider-account-limit");
    expect(classifyFailure(failed("burst-25/cold", { code: "quota" }))).toBe(
      "provider-account-limit",
    );
    // A quota error that names a sandbox was admitted; another code is an operation failure.
    expect(classifyFailure(failed("cold", { code: "quota", sandboxId: "sbx-1" }))).toBe(
      "provider-operation",
    );
    expect(classifyFailure(failed("cold", { code: "provider" }))).toBe("provider-operation");
    expect(classifyFailure(failed("exec", { code: "quota" }))).toBe("provider-operation");
  });

  // PR 75 review (PRRT_kwDOTZ9UNs67Hvb3): a stress cohort counts a quota only on HTTP 429, or SDK
  // code quota with no status; the older Archil rule must not override that there.
  it.each([402, 403])(
    "a stress cohort's create refused with HTTP %i stays the provider's",
    (status) => {
      const refused = { code: "quota" as const, cause: { httpStatus: status } };

      for (const scenario of ["cpu-burst-4/cold", "survival-4/cold"])
        expect(classifyFailure(failed(scenario, refused))).toBe("provider-operation");

      // Outside stress cohorts the Archil rule still reads the adapter's quota code.
      for (const scenario of ["cold", "burst-25/cold"])
        expect(classifyFailure(failed(scenario, refused))).toBe("provider-account-limit");
    },
  );

  it("a stress cohort's create refused with HTTP 429 or a bare quota code is an account limit", () => {
    expect(
      classifyFailure(failed("cpu-burst-4/cold", { code: "quota", cause: { httpStatus: 429 } })),
    ).toBe("provider-account-limit");
    expect(classifyFailure(failed("survival-4/cold", { code: "quota" }))).toBe(
      "provider-account-limit",
    );
  });
});

describe("Archil coverage policy", () => {
  it("records both snapshot scenarios as not run on both tracks", () => {
    const rows = collectionPolicy().notRun.filter((row) => row.provider === "archil");

    expect(rows.map((row) => `${row.track}/${row.scenario}`).sort()).toEqual([
      "default/create-from-snapshot",
      "default/snapshot",
      "same-spec/create-from-snapshot",
      "same-spec/snapshot",
    ]);
  });
});

describe("Archil billing", () => {
  it("reports Archil's own cost, final once deleted and the meter has settled", () => {
    const endedAt = "2026-11-21T10:05:00.000Z";

    expect(decodeArchil({ success: true, data: usage }, { deleted: true, endedAt })).toMatchObject({
      kind: "billed",
      usd: 0.0475,
      scope: "sandbox-lifetime",
      complete: true,
      confidence: "high",
    });
    expect(decodeArchil(usage, { deleted: false, endedAt })).toMatchObject({
      complete: false,
      confidence: "low",
    });
    // Read within two minutes of the last sample: the last minute may still be missing.
    expect(
      decodeArchil({ ...usage, as_of: "2026-11-21T10:06:00Z" }, { deleted: true, endedAt }),
    ).toMatchObject({ complete: false, note: expect.stringContaining("provisional") });
    expect(decodeArchil({ ...usage, as_of: undefined }, { deleted: true, endedAt })).toMatchObject({
      complete: false,
    });
    expect(() =>
      decodeArchil({ success: true, data: { cost: 1 } }, { deleted: true, endedAt }),
    ).toThrow();
  });

  it("reads the sandbox ID from Archil's wire name, sandbox_id", () => {
    expect(
      archilSandboxBody.parse({
        success: true,
        data: { sandbox_id: "019d158e-7100-7000-8000-0123456789ab", status: "running", name: "x" },
      }),
    ).toEqual({ id: "019d158e-7100-7000-8000-0123456789ab", status: "running" });
    expect(() =>
      archilSandboxBody.parse({ success: true, data: { id: "x", status: "running" } }),
    ).toThrow();
  });

  it("collects usage per sandbox; a 404 or a deleted status makes it final", async () => {
    const urls: string[] = [];

    const transport: Transport = async (url, headers) => {
      urls.push(url);
      expect(headers.Authorization).toBe("Bearer ak_test");

      if (url.endsWith("/usage")) return { success: true, data: usage };

      if (url.endsWith("/sbx-gone")) throw new BillingHttpError(404);

      if (url.endsWith("/sbx-deleted"))
        return {
          success: true,
          data: {
            sandbox_id: "sbx-deleted",
            status: "deleted",
            finished_at: "2026-11-21T10:05:00Z",
          },
        };

      return { success: true, data: { sandbox_id: "sbx-live", status: "running" } };
    };

    const row = (id: string) => ({
      provider: "archil",
      id,
      scenarios: new Set(["sandbox-lifetime"]),
      startedAt: "2026-11-21T10:00:00.000Z",
      finishedAt: "2026-11-21T10:05:00.000Z",
      confirmedStopAt: null,
      app: null,
    });

    const result = await collectProvider(
      "archil",
      [row("sbx-gone"), row("sbx-deleted"), row("sbx-live")],
      { ARCHIL_API_KEY: "ak_test", ARCHIL_REGION: "aws-us-west-2" },
      transport,
    );

    expect(
      result.sandboxes.map((s) => [s.id, s.cost.kind === "billed" && s.cost.complete]),
    ).toEqual([
      // Already dropped: Archil no longer says when it ended, so the cost stays provisional.
      ["sbx-gone", false],
      ["sbx-deleted", true],
      ["sbx-live", false],
    ]);
    // Deletion is checked before the usage is read, on the key's region.
    expect(urls[0]).toBe(
      "https://control.green.us-west-2.aws.prod.archil.com/api/sandboxes/sbx-gone",
    );
    expect(urls[1]).toBe(
      "https://control.green.us-west-2.aws.prod.archil.com/api/sandboxes/sbx-gone/usage",
    );
  });

  it("makes no call without a key", async () => {
    const result = await collectProvider(
      "archil",
      [
        {
          provider: "archil",
          id: "sbx-1",
          scenarios: new Set(["sandbox-lifetime"]),
          startedAt: null,
          finishedAt: null,
          confirmedStopAt: null,
          app: null,
        },
      ],
      { TMPDIR: tmpdir() },
      async () => {
        throw new Error("no call expected");
      },
    );

    expect(result.sandboxes[0]?.cost).toMatchObject({
      kind: "unavailable",
      note: expect.stringContaining("Missing ARCHIL_API_KEY"),
    });
  });
});
