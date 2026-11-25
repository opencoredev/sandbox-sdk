import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maritime } from "@opencoredev/sandbox-sdk/maritime";
import { requestedSize } from "../src/allocation.js";
import { cloudProviders } from "../src/attempts.js";
import {
  collectProvider,
  decodeMaritime,
  maritimeUsageQuery,
  type MaritimeInfo,
  type MaritimeUsageRecord,
  type Transport,
} from "../src/billing/providers.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { lookupSandbox } from "../src/existence.js";
import { lifetimeOptions } from "../src/lifetime.js";
import { estimateCost } from "../src/pricing.js";
import { provisionedAllocation } from "../src/provisioned-allocations.js";
import { heldOpenProviders } from "../src/realistic/cli.js";
import { providerSetup } from "../src/realistic/setup.js";
import {
  inspectSnapshot,
  maritimeSnapshotName,
  settleJournaledSnapshot,
  settleMaritimeSave,
} from "../src/snapshots.js";
import { parseV2 } from "../src/v2-config.js";
import { bound, boundFake } from "./native-fakes.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const info = (extra: Partial<MaritimeInfo> = {}): MaritimeInfo => ({
  id: "sbx-a",
  state: "ended",
  createdAt: "2026-11-23T20:46:00.339028Z",
  endedAt: "2026-11-23T20:46:07.487448Z",
  runningSeconds: 6,
  costSoFarUsd: "0.000038",
  storedBytes: 0,
  ...extra,
});

const interval = (extra: Partial<MaritimeUsageRecord> = {}): MaritimeUsageRecord => ({
  sandboxId: "sbx-a",
  startedAt: "2026-11-23T20:46:01.026450Z",
  endedAt: "2026-11-23T20:46:07.325116Z",
  costUsd: "0.000038",
  ...extra,
});

describe("Maritime bench registration", () => {
  it("is a cloud provider with Maritime's sizes and its default small machine", () => {
    expect(cloudProviders).toContain("maritime");
    expect(requestedSize("maritime", "small")).toEqual({ cpu: 2, memoryGiB: 4 });
    expect(requestedSize("maritime", "medium")).toEqual({ cpu: 4, memoryGiB: 8 });
    expect(requestedSize("maritime", "large")).toEqual({ cpu: 8, memoryGiB: 16 });
    expect(provisionedAllocation("maritime", null)).toEqual({ cpu: 2, memoryGiB: 4, diskGiB: 12 });
    expect(provisionedAllocation("maritime", "base")).toMatchObject({ cpu: 2, memoryGiB: 4 });
  });

  it("prices compute at the published rates, disk included while running", () => {
    const hour = estimateCost("maritime", 3_600_000, { cpu: 2, memoryGiB: 4, diskGiB: 12 });

    expect(hour).toBeCloseTo(0.022, 9);
    expect(estimateCost("maritime", 3_600_000, { cpu: 4, memoryGiB: 8, diskGiB: 50 })).toBeCloseTo(
      0.044,
      9,
    );
  });

  it("takes a factory lifetime of up to 24 hours", () => {
    expect(lifetimeOptions("maritime", { "lifetime-ms": { maritime: 600_000 } })).toEqual({
      timeoutMs: 600_000,
    });
    expect(() =>
      lifetimeOptions("maritime", { "lifetime-ms": { maritime: 25 * 3_600_000 } }),
    ).toThrow(/24 hours/);
  });

  it("runs same-machine on the medium preset and stays out of the held-open idle test", () => {
    const setup = providerSetup("maritime");

    expect(setup).toMatchObject({ adapter: "maritime", lifetime: true, pricingKey: "maritime" });
    expect(setup.tracks["same-machine"]).toMatchObject({
      size: { cpu: 4, memoryMb: 8192 },
      provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 50 },
    });
    expect(setup.tracks.default.provisioned).toEqual({ cpu: 2, memoryGiB: 4, diskGiB: 12 });
    // Usage intervals leave out a paused sandbox's disk, so an idle that pauses would read cheaper.
    expect(heldOpenProviders).not.toContain("maritime");
  });

  it("has a metered per-sandbox rule: storage not charged while awake, paused disk keeps charging", () => {
    const rule = billingRule("maritime", null);

    expect(rule).toMatchObject({
      pricingKey: "maritime",
      reportedKind: "metered",
      attribution: "per-sandbox",
      storage: { kind: "known", value: "not-charged" },
      keepsCharging: { kind: "known", value: ["disk"] },
    });
    expect(JSON.stringify(rule)).toContain("$0.08");
  });

  it("reads an ended sandbox as terminal with a GET that never resumes it", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
    const calls: { url: string; method: string }[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });

      return Response.json({ id: "sbx-a", state: "ended" });
    });

    const lookup = await lookupSandbox(bound(maritime()), "sbx-a", 5000);

    expect(lookup).toMatchObject({ result: "terminal", nativeState: "ended" });
    expect(calls).toEqual([{ url: "https://api.maritime.sh/v1/sandboxes/sbx-a", method: "GET" }]);
  });
});

describe("Maritime billing completeness", () => {
  it("settles an ended sandbox whose closed intervals add up to the info's total", () => {
    const cost = decodeMaritime(info(), [interval()], "sbx-a");

    expect(cost).toMatchObject({
      kind: "metered",
      scope: "sandbox-lifetime",
      complete: true,
      confidence: "medium",
    });
    expect(cost.kind === "metered" && cost.usd).toBeCloseTo(0.000038, 9);
  });

  it("never settles missing usage as $0 unless the info says it never ran and cost nothing", () => {
    expect(decodeMaritime(info(), [], "sbx-a")).toMatchObject({ kind: "unavailable" });
    expect(decodeMaritime(info({ state: "running", endedAt: null }), [], "sbx-a")).toMatchObject({
      kind: "unavailable",
    });
    expect(
      decodeMaritime(info({ runningSeconds: 0, costSoFarUsd: null }), [], "sbx-a"),
    ).toMatchObject({ kind: "unavailable" });

    const never = decodeMaritime(
      info({ runningSeconds: 0, costSoFarUsd: "0.000000" }),
      [],
      "sbx-a",
    );

    expect(never).toMatchObject({ kind: "metered", usd: 0, complete: true });
  });

  it("is partial while the sandbox lives or an interval is open; a disagreeing info total is only noted", () => {
    expect(
      decodeMaritime(info({ state: "paused", endedAt: null }), [interval()], "sbx-a"),
    ).toMatchObject({ kind: "metered", complete: false, confidence: "low" });
    expect(decodeMaritime(info(), [interval({ endedAt: null })], "sbx-a")).toMatchObject({
      complete: false,
    });
    const disagreeing = decodeMaritime(info({ costSoFarUsd: "0.010000" }), [interval()], "sbx-a");

    expect(disagreeing).toMatchObject({ complete: true });
    expect(disagreeing.note).toContain("$0.010000 so far");
  });

  it("refuses intervals of another sandbox and amounts that are not non-negative decimals", () => {
    expect(() => decodeMaritime(info(), [interval({ sandboxId: "sbx-b" })], "sbx-a")).toThrow(
      /mismatch/,
    );
    expect(() => decodeMaritime(info({ id: "sbx-b" }), [interval()], "sbx-a")).toThrow(/mismatch/);

    for (const costUsd of ["-0.1", "NaN", "1e3", ""])
      expect(() => decodeMaritime(info(), [interval({ costUsd })], "sbx-a")).toThrow();
  });

  it("asks for usage from an hour before the native createdAt to five minutes after the end", () => {
    const query = maritimeUsageQuery(info(), Date.parse("2026-11-23T21:00:00Z"), "cur");

    expect(Object.fromEntries(query)).toEqual({
      from: "2026-11-23T19:46:00.339Z",
      to: "2026-11-23T20:51:07.487Z",
      sandbox: "sbx-a",
      limit: "100",
      cursor: "cur",
    });
    expect(
      maritimeUsageQuery(info({ endedAt: null }), Date.parse("2026-11-23T21:00:00Z")).get("to"),
    ).toBe("2026-11-23T21:05:00.000Z");
  });

  it("reads the info, then every usage page, and settles from both", async () => {
    const urls: string[] = [];

    const transport: Transport = async (url, headers) => {
      urls.push(url);
      expect(headers.Authorization).toBe("Bearer mk_test_key");

      if (url.endsWith("/info")) return info({ costSoFarUsd: "0.000076" });

      return new URL(url).searchParams.get("cursor") === null
        ? { data: [interval()], nextCursor: "page-2" }
        : { data: [interval()], nextCursor: null };
    };

    const result = await collectProvider(
      "maritime",
      [
        {
          provider: "maritime",
          id: "sbx-a",
          scenarios: new Set(["sandbox-lifetime"]),
          startedAt: "2026-11-23T20:46:00.000Z",
          finishedAt: "2026-11-23T20:47:00.000Z",
          confirmedStopAt: null,
          app: null,
        },
      ],
      { MARITIME_API_KEY: "mk_test_key" },
      transport,
    );

    expect(result.sandboxes[0]?.cost).toMatchObject({ kind: "metered", complete: true });
    expect(urls[0]).toBe("https://api.maritime.sh/v1/sandboxes/sbx-a/info");
    expect(urls[1]).toMatch(/^https:\/\/api\.maritime\.sh\/v1\/usage\?from=/);
    expect(new URL(urls[2] ?? "").searchParams.get("cursor")).toBe("page-2");
  });
});

/** A stand-in for Maritime's save and snapshot routes, with a save that lands late. */
function lateSave(options: { visibleAfterReads: number }) {
  const calls: string[] = [];
  let reads = 0;
  let saves = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";

    calls.push(`${method} ${url.pathname}`);

    if (url.pathname.endsWith("/save")) {
      saves++;

      // The first save's answer is lost; the replay with its key returns the first save's outcome.
      if (saves === 1) throw new TypeError("fetch failed");

      return Response.json({ name: "snap-1", sourceSandboxId: "sbx-src" });
    }

    if (url.pathname === "/v1/snapshots/snap-1" && method === "GET") {
      reads++;

      return reads > options.visibleAfterReads
        ? Response.json({ name: "snap-1", sourceSandboxId: "sbx-src" })
        : Response.json({ code: "snapshot_not_found" }, { status: 404 });
    }

    if (url.pathname === "/v1/snapshots/snap-1" && method === "DELETE")
      return Response.json({ deleted: true });

    return Response.json({ code: "resource_not_found" }, { status: 404 });
  });

  return { calls };
}

describe("Maritime snapshots journaled before the save", () => {
  it("names the snapshot from the run label, lower case and safe", () => {
    expect(maritimeSnapshotName("Run_2026.11/23")).toMatch(/^bench-run-2026-11-23-[0-9a-f]{8}$/);
  });

  it("a save that becomes visible after an initial 404 is settled as existing, not forgotten", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
    const { calls } = lateSave({ visibleAfterReads: 2 });

    // The first save was lost: a first read already 404s.
    await expect(
      inspectSnapshot("maritime", bound(maritime()), "sbx-src", "snap-1"),
    ).resolves.toEqual({ exists: false });

    const settled = await settleMaritimeSave({
      provider: bound(maritime()),
      sandboxId: "sbx-src",
      name: "snap-1",
      idempotencyKey: "key-1",
      timeoutMs: 20_000,
    });

    expect(settled).toBe("exists");
    // The replays carried the journaled key and the reads went on past the 404s.
    expect(calls.filter((c) => c === "GET /v1/snapshots/snap-1").length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("a journaled entry is forgotten without a delete only when the save was refused", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));

      // The source ended: the save is refused and the snapshot does not exist.
      if (url.pathname.endsWith("/save"))
        return Response.json({ code: "sandbox_ended" }, { status: 410 });

      return Response.json({ code: "snapshot_not_found" }, { status: 404 });
    });

    await expect(
      settleJournaledSnapshot(
        "maritime",
        bound(maritime()),
        { id: "snap-1", parent: "sbx-src", idempotencyKey: "key-1" },
        5000,
      ),
    ).resolves.toEqual({ kind: "absent" });
    // A confirmed save keeps no key: it goes straight to the proven delete.
    await expect(
      settleJournaledSnapshot(
        "maritime",
        bound(maritime()),
        { id: "snap-1", parent: "sbx-src" },
        5000,
      ),
    ).resolves.toEqual({ kind: "exists", id: "snap-1" });
  });

  it("an accepted save that never shows keeps its journal entry", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
    lateSave({ visibleAfterReads: Number.POSITIVE_INFINITY });

    await expect(
      settleMaritimeSave({
        provider: bound(maritime()),
        sandboxId: "sbx-src",
        name: "snap-1",
        idempotencyKey: "key-1",
        timeoutMs: 2500,
      }),
    ).rejects.toThrow(/did not settle/);
  });

  it("requires a matching, non-null source before a snapshot may be deleted", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ name: "snap-1", sourceSandboxId: null }),
    );

    await expect(
      inspectSnapshot("maritime", bound(maritime()), "sbx-src", "snap-1"),
    ).rejects.toThrow(/source metadata/);
  });
});

describe("preview credentials stay out of the run's records", () => {
  it("samples.ndjson and the merged output never hold a preview's query token or headers", async () => {
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const { runV2 } = await import("../src/v2-runner.js");
    const { mergeSources, readSource } = await import("../src/merge.js");
    const { writeV2 } = await import("../src/v2-report.js");
    const directory = await mkdtemp(resolve(tmpdir(), "sandbox-bench-preview-"));
    const token = "mut_preview_token_never_journaled";
    const header = "hdr_preview_secret_never_journaled";
    const base = memory();

    const provider = {
      ...base,
      // The app's install needs npm; the memory sandbox answers it as done.
      exec: async (id: string, input: Parameters<typeof base.exec>[1]) =>
        input.command.includes("npm ci") ? { exitCode: 0, timedOut: false } : base.exec(id, input),
      previewUrl: async () => ({
        url: `https://3000-sbx.preview.test/?token=${token}`,
        headers: { "x-preview-auth": header },
      }),
    };

    try {
      const report = await runV2(
        [
          {
            kind: "ready",
            name: "memory",
            cloud: false,
            region: null,
            provider: boundFake(provider),
          },
        ],
        parseV2([
          "--providers",
          "memory",
          "--runs",
          "1",
          "--max-sandboxes",
          "1",
          "--bursts",
          "",
          "--scenarios",
          "npm-install,dev-server",
          "--timeout-ms",
          "5000",
          "--out",
          directory,
        ]),
        async () => {},
      );

      const provisioning = report.samples.find((s) => s.scenario === "preview-provisioning");

      expect(provisioning?.outcome.kind).toBe("sample");

      await writeV2(report, report.config.out);

      const files = await readdir(directory, { recursive: true });

      const written = await Promise.all(
        files
          .filter((file) => /\.(ndjson|json)$/.test(file))
          .map((file) => readFile(join(directory, file), "utf8")),
      );

      expect(files.some((file) => file.endsWith("samples.ndjson"))).toBe(true);

      const merged = JSON.stringify(mergeSources([await readSource(report.config.out)]));

      for (const text of [...written, JSON.stringify(report), merged]) {
        expect(text).not.toContain(token);
        expect(text).not.toContain(header);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
