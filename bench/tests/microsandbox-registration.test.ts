import { afterEach, describe, expect, it, vi } from "vitest";
import { requestedSize } from "../src/allocation.js";
import { cloudProviders } from "../src/attempts.js";
import {
  collectProvider,
  decodeMicrosandbox,
  rateMicrosandboxRow,
  type MicrosandboxUsageRow,
  type Transport,
} from "../src/billing/providers.js";
import type { OwnedSandbox } from "../src/billing/input.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { lookupSandbox } from "../src/existence.js";
import { lifetimeOptions } from "../src/lifetime.js";
import { estimateCost, pricing } from "../src/pricing.js";
import {
  adapterSpec,
  loadProvider,
  microsandboxTier,
  type FactoryOptions,
} from "../src/providers.js";
import { provisionedAllocation } from "../src/provisioned-allocations.js";
import { heldOpenProviders } from "../src/realistic/cli.js";
import { providerSetup } from "../src/realistic/setup.js";
import { parseV2 } from "../src/v2-config.js";
import { restoreSize, sanitize } from "../src/v2-runner.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const tiers = ["microsandbox", "microsandbox-shared"] as const;

const row = (extra: Partial<MicrosandboxUsageRow> = {}): MicrosandboxUsageRow => ({
  sandbox_id: "00000000-0000-0000-0000-0000000000a1",
  compute_type: "standard",
  day: "2026-11-24T00:00:00Z",
  vcpu_seconds: 4 * 3600,
  mem_mib_seconds: 8 * 1024 * 3600,
  disk_mib_seconds: 64 * 1024 * 3600,
  ...extra,
});

const owned = (id: string, startedAt: string | null): OwnedSandbox => ({
  provider: "microsandbox",
  id,
  scenarios: new Set(["cold"]),
  startedAt,
  finishedAt: startedAt === null ? null : "2026-11-24T10:10:00.000Z",
  confirmedStopAt: null,
  app: null,
});

describe("Microsandbox bench registration: two tiers on one adapter", () => {
  it("registers both tiers as cloud providers with the adapter's presets and defaults", () => {
    for (const name of tiers) {
      expect(cloudProviders).toContain(name);
      expect(requestedSize(name, "small")).toEqual({ cpu: 1, memoryGiB: 1 });
      expect(requestedSize(name, "medium")).toEqual({ cpu: 2, memoryGiB: 4 });
      expect(requestedSize(name, "large")).toEqual({ cpu: 4, memoryGiB: 8 });
      expect(provisionedAllocation(name, null)).toEqual({ cpu: 1, memoryGiB: 0.5 });
      expect(lifetimeOptions(name, { "lifetime-ms": { [name]: 600_000 } })).toEqual({
        timeoutMs: 600_000,
      });
    }
  });

  it("resolves both names to the microsandbox subpath, each pinned to its tier", () => {
    expect(adapterSpec("microsandbox")).toEqual({
      subpath: "microsandbox",
      factory: "microsandbox",
      pinned: { computeType: "standard" },
    });
    expect(adapterSpec("microsandbox-shared").pinned).toEqual({ computeType: "shared" });
    expect(microsandboxTier("microsandbox")).toBe("standard");
    expect(microsandboxTier("microsandbox-shared")).toBe("shared");
    expect(microsandboxTier("maritime")).toBeUndefined();
    expect(adapterSpec("e2b")).toEqual({ subpath: "e2b", factory: "e2b", pinned: {} });
  });

  it("loads the shared tier through the microsandbox entry point with computeType pinned last", async () => {
    const imported: string[] = [];
    const seen: FactoryOptions[] = [];
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");

    const importer = async (specifier: string) => {
      imported.push(specifier);

      return {
        microsandbox: (options: FactoryOptions) => {
          seen.push(options);

          return memory();
        },
      };
    };

    const loaded = await loadProvider(
      "microsandbox-shared",
      { MSB_API_KEY: "msb_test_key_123456" },
      importer,
      { template: {}, product: {}, factory: { computeType: "standard" } },
    );

    expect(loaded.kind).toBe("ready");
    expect(imported).toEqual(["@opencoredev/sandbox-sdk/microsandbox"]);
    expect(seen).toEqual([expect.objectContaining({ computeType: "shared" })]);
  });

  it("skips a tier without MSB_API_KEY", async () => {
    const loaded = await loadProvider("microsandbox", {}, async () => ({}));

    expect(loaded).toMatchObject({ kind: "skipped", note: expect.stringContaining("MSB_API_KEY") });
  });

  it("prices each tier at its published rates: $0.220 and $0.035 an hour at 4 vCPU / 8 GiB / 64 GiB", () => {
    const size = { cpu: 4, memoryGiB: 8, diskGiB: 64 };

    expect(estimateCost("microsandbox", 3_600_000, size)).toBeCloseTo(0.22, 9);
    expect(estimateCost("microsandbox-shared", 3_600_000, size)).toBeCloseTo(0.035, 9);
    expect(pricing.microsandbox?.diskGiBSecond).toBeCloseTo(0.0000625 / 3600, 15);
    expect(pricing["microsandbox-shared"]?.cpuSecond).toBeCloseTo(0.007 / 3600, 15);
  });

  it("keeps both tiers out of the held-open diagnostic, provisional with no settlement edge", () => {
    for (const name of tiers) {
      expect(heldOpenProviders).not.toContain(name);
      expect(billingRule(name, null)).toMatchObject({
        pricingKey: name,
        reportedKind: "metered",
        attribution: "per-sandbox",
        settlementMs: null,
      });
    }
  });

  it("has a realistic setup per tier: same-machine 4/8 with a 64 GiB disk, default too small", () => {
    for (const name of tiers) {
      const setup = providerSetup(name);

      expect(setup).toMatchObject({ name, adapter: name, pricingKey: name, lifetime: true });
      expect(setup.tracks["same-machine"].size).toEqual({ cpu: 4, memoryMb: 8192, diskGb: 64 });
      expect(Object.keys(setup.tracks.default.tooSmall).sort()).toEqual(["build", "fix-and-test"]);
    }
  });

  it("accepts --size microsandbox=4:8192:64 and restores at CPU and memory only", () => {
    const config = parseV2(["--providers", "microsandbox", "--size", "microsandbox=4:8192:64"]);

    expect(config.size.microsandbox).toEqual({ cpu: 4, memoryMb: 8192, diskGb: 64 });
    expect(restoreSize("microsandbox", { cpu: 4, memoryMb: 8192, diskGb: 64 })).toEqual({
      cpu: 4,
      memoryMb: 8192,
    });
    expect(restoreSize("microsandbox-shared", { cpu: 2, memoryMb: 2048, diskGb: 10 })).toEqual({
      cpu: 2,
      memoryMb: 2048,
    });
    expect(restoreSize("microsandbox", "medium")).toBe("medium");
    // Other providers keep their size as it was.
    expect(restoreSize("modal", { cpu: 4, memoryMb: 8192, diskGb: 64 })).toEqual({
      cpu: 4,
      memoryMb: 8192,
      diskGb: 64,
    });
  });
});

describe("Microsandbox existence: read-only, failed is present", () => {
  for (const [status, body, expected] of [
    ["failed", 200, "present"],
    ["stopped", 200, "present"],
    ["running", 200, "present"],
    ["gone", 404, "not-found"],
  ] as const)
    it(`a ${status} read is ${expected}`, async () => {
      vi.stubEnv("MSB_API_KEY", "msb_test_key_123456");
      const id = "00000000-0000-0000-0000-0000000000b2";
      const methods: string[] = [];

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        methods.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);

        return body === 404
          ? Response.json({ error: { code: "sandbox_not_found" } }, { status: 404 })
          : Response.json({ id, name: "sbx-x", status, compute: { type: "standard" } });
      });

      const { memory } = await import("@opencoredev/sandbox-sdk/memory");
      const evidence = await lookupSandbox({ ...memory(), name: "microsandbox-shared" }, id, 5000);

      expect(evidence.result).toBe(expected);
      expect(methods).toEqual([`GET /v1/sandboxes/${id}`]);
    });
});

describe("Microsandbox billing: rated per row, never a false zero, always provisional", () => {
  it("rates each row at its own compute type", () => {
    expect(rateMicrosandboxRow(row())).toBeCloseTo(0.22, 9);
    expect(rateMicrosandboxRow(row({ compute_type: "shared" }))).toBeCloseTo(0.035, 9);

    const mixed = decodeMicrosandbox({
      id: row().sandbox_id,
      rows: [row(), row({ compute_type: "shared" })],
      workloadUsd: undefined,
    });

    expect(mixed).toMatchObject({ kind: "metered", complete: false, confidence: "low" });
    expect(mixed.kind === "metered" ? mixed.usd : 0).toBeCloseTo(0.255, 9);
  });

  it("is unavailable, not $0, when neither rows nor workloads name the sandbox", () => {
    expect(
      decodeMicrosandbox({ id: "other", rows: [row()], workloadUsd: undefined }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("uses costs.workloads alone as provisional, and notes a disagreeing amount", () => {
    expect(decodeMicrosandbox({ id: "x", rows: [], workloadUsd: 0.5 })).toMatchObject({
      kind: "metered",
      usd: 0.5,
      complete: false,
    });

    const noted = decodeMicrosandbox({ id: row().sandbox_id, rows: [row()], workloadUsd: 0.3 });

    expect(noted.kind === "metered" ? noted.note : "").toContain("costs.workloads says $0.300000");
    expect(noted.kind === "metered" ? noted.usd : 0).toBeCloseTo(0.22, 9);
  });

  it("reads both usage endpoints once for the run window, and never zeroes a journal-only ID", async () => {
    const urls: string[] = [];

    const transport: Transport = async (url, headers) => {
      urls.push(url);
      expect(headers.Authorization).toBe("Bearer msb_test_key_123456");

      if (url.includes("/v1/billing/usage/sandbox")) return { rows: [row()], sandboxes: [] };

      return { costs: { workloads: {}, incomplete: false, daily: [] } };
    };

    const costs = await collectProvider(
      "microsandbox",
      [owned(row().sandbox_id, "2026-11-24T10:00:00.000Z"), owned("journal-only", null)],
      { MSB_API_KEY: "msb_test_key_123456" },
      transport,
    );

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/v1/billing/usage/sandbox?from=2026-11-24T10%3A00%3A00.000Z&to=");
    expect(urls[1]).toContain("/v1/billing/usage?from=");
    expect(costs.sandboxes.map((s) => s.cost.kind)).toEqual(["metered", "unavailable"]);

    for (const sandbox of costs.sandboxes)
      if (sandbox.cost.kind !== "unavailable") expect(sandbox.cost.complete).toBe(false);
  });
});

describe("Microsandbox credentials in benchmark records", () => {
  it("sanitize removes msb_ keys and msb_pat_ tokens not in the environment", () => {
    const text = "failed with msb_live_abcdef123 and msb_pat_xyz-987_q in /v1/x";
    const clean = sanitize(text);

    expect(clean).not.toContain("msb_live_abcdef123");
    expect(clean).not.toContain("msb_pat_xyz-987_q");
    expect(clean).toContain("/v1/x");
  });
});
