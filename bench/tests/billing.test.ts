import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectBilling, billingCommand } from "../src/billing.js";
import { readRun } from "../src/billing/input.js";
import {
  BillingHttpError,
  collectProvider,
  decodeBoat,
  decodeBoxd,
  decodeEvents,
  decodeUpstash,
  readBoxdAccount,
  http,
  type Transport,
} from "../src/billing/providers.js";
import recorded from "../src/billing/fixtures/recorded.json";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const sample = (
  provider = "upstash",
  id: string | null = "fixture-upstash",
  scenario = "sandbox-lifetime",
) => ({
  provider,
  sandboxId: id,
  scenario,
  startedAt: "2026-10-19T20:34:00.000Z",
  finishedAt: "2026-10-19T20:35:00.000Z",
});
async function report(samples: ReturnType<typeof sample>[], ndjson = true) {
  const directory = await mkdtemp(join(tmpdir(), "bench-billing-"));
  directories.push(directory);
  await writeFile(
    join(directory, ndjson ? "samples.ndjson" : "results.json"),
    ndjson
      ? samples.map((s) => JSON.stringify(s)).join("\n")
      : JSON.stringify({ ignored: { samples: ["wrong"] }, samples, tail: "ignored" }),
  );
  return directory;
}
const row = {
  provider: "upstash",
  id: "fixture-upstash",
  scenarios: new Set(["sandbox-lifetime"]),
  startedAt: "2026-10-19T20:34:00.000Z",
  finishedAt: "2026-10-19T20:35:00.000Z",
};
const noNetwork: Transport = async () => {
  throw new Error("unexpected network");
};

describe("billing collector", () => {
  it("retries transient read-only billing throttles with a bounded delay", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(Response.json(recorded.upstash));
    const pending = http("https://us-east-1.box.upstash.com/v2/box/fixture-upstash", {});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject(recorded.upstash);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
  });
  it("uses a deleted box's recorded charge, never duration × price", async () => {
    const directory = await report([sample(), sample("upstash", "fixture-upstash", "command")]);
    const transport = vi.fn<Transport>(async () => recorded.upstash);
    const result = await collectBilling({
      report: directory,
      env: { UPSTASH_BOX_API_KEY: "test-only" },
      transport,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const provider = result.providers[0];
    expect(provider?.billedUSD).toBe(0.00030777130555555555);
    expect(provider?.sandboxes).toEqual([
      expect.objectContaining({
        id: "fixture-upstash",
        source: expect.stringContaining("upstash"),
        cost: expect.objectContaining({ kind: "billed", usd: 0.00030777130555555555 }),
      }),
    ]);
    expect(provider?.sandboxCount).toBe(1);
    expect(
      provider?.scenarios.find((s) => s.scenario === "sandbox-lifetime")?.billedCostPerTaskUSD,
    ).toBe(0.00030777130555555555);
    expect(provider?.scenarios.find((s) => s.scenario === "command")?.billedUSD).toBeNull();
    expect(provider?.scenarios.find((s) => s.scenario === "command")?.attributedSandboxes).toBe(0);
  });
  it("does not double-count shared sandboxes without a lifetime scenario", async () => {
    const directory = await report([
      sample("upstash", "fixture-upstash", "files"),
      sample("upstash", "fixture-upstash", "command"),
    ]);
    const result = await collectBilling({
      report: directory,
      env: { UPSTASH_BOX_API_KEY: "test-only" },
      transport: async () => recorded.upstash,
    });
    expect(result.providers[0]?.unallocatedSandboxIds).toEqual(["fixture-upstash"]);
    expect(result.providers[0]?.scenarios.every((s) => s.billedUSD === null)).toBe(true);
  });
  it("streams results.json samples across chunks, ignoring nested arrays and escaped braces", async () => {
    const directory = await report([], false);
    await writeFile(
      join(directory, "results.json"),
      JSON.stringify({
        ignored: { samples: ["wrong"] },
        samples: [
          { ...sample(), details: "x".repeat(80_000) + '}\\"[escaped]' },
          sample("boat", "b"),
        ],
        tail: [],
      }),
    );
    expect((await readRun(directory)).map((s) => s.id)).toEqual(["fixture-upstash", "b"]);
  });
  it("prefers streamed NDJSON and unions deduplicated journal ownership", async () => {
    const directory = await report([sample(), sample(), sample("upstash", null)]);
    await writeFile(join(directory, "results.json"), "large JSON is intentionally not read");
    await writeFile(
      join(directory, "ownership.json"),
      JSON.stringify({
        resources: [
          { provider: "upstash", id: "fixture-upstash", kind: "sandbox" },
          { provider: "boat", id: "journal-only", kind: "sandbox" },
          { provider: "boat", id: "snapshot", kind: "snapshot" },
        ],
      }),
    );
    expect((await readRun(directory)).map((s) => s.id)).toEqual([
      "fixture-upstash",
      "journal-only",
    ]);
  });
  it("rejects truncated JSON rather than fabricating an empty run", async () => {
    const directory = await report([], false);
    await writeFile(join(directory, "results.json"), '{"samples":[');
    await expect(readRun(directory)).rejects.toThrow("truncated");
  });
  it("rejects scalar sample entries rather than silently dropping them", async () => {
    const directory = await report([], false);
    await writeFile(join(directory, "results.json"), '{"samples":["bad"]}');
    await expect(readRun(directory)).rejects.toThrow("must contain objects");
  });
  it("keeps offline costs unknown even with credentials and makes no calls", async () => {
    const directory = await report([sample(), sample("tenki", "t"), sample("freestyle", "f")]);
    const transport = vi.fn(noNetwork);
    const result = await collectBilling({
      report: directory,
      env: { UPSTASH_BOX_API_KEY: "test-only" },
      transport,
      offline: true,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(result.providers.every((p) => p.billedUSD === null && p.meteredUSD === null)).toBe(true);
  });
  it("does not turn unavailable coverage into a partial total or biased per-task cost", async () => {
    const directory = await report([sample(), sample("upstash", "missing")]);
    const result = await collectBilling({
      report: directory,
      env: { UPSTASH_BOX_API_KEY: "test-only" },
      transport: async (url) => {
        if (url.endsWith("missing")) throw new BillingHttpError(404);
        return recorded.upstash;
      },
    });
    expect(result.providers[0]?.billedUSD).toBeNull();
    expect(result.providers[0]?.recoveredBilledUSD).toBe(recorded.upstash.total_compute_cost_usd);
    expect(result.providers[0]?.scenarios[0]?.billedCostPerTaskUSD).toBeNull();
  });
  it("stops repeated unauthorized or offline requests without retaining secret errors", async () => {
    const directory = await report([sample(), sample("upstash", "second")]);
    const transport = vi.fn<Transport>(async () => {
      throw new Error("SECRET_KEY accidental diagnostic");
    });
    const result = await collectBilling({
      report: directory,
      env: { UPSTASH_BOX_API_KEY: "SECRET_KEY" },
      transport,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("SECRET_KEY");
    expect(result.providers[0]?.unavailableSandboxes).toBe(2);
  });
  it("recognizes missing credentials and unsupported providers without a network call", async () => {
    const directory = await report([sample(), sample("tenki", "t"), sample("freestyle", "f")]);
    const transport = vi.fn(noNetwork);
    const result = await collectBilling({ report: directory, env: {}, transport });
    expect(transport).not.toHaveBeenCalled();
    expect(result.providers.every((p) => p.billedUSD === null)).toBe(true);
  });
  it("leaves list-price Boat dollars metered, separate from billed cost", async () => {
    const cost = decodeBoat({ sandboxId: "b", dollars: 0.005, seconds: 500, running: false }, "b");
    expect(cost).toMatchObject({ kind: "metered", usd: 0.005, complete: true });
    const directory = await report([sample("boat", "b")]);
    const result = await collectBilling({
      report: directory,
      env: { BOAT_API_KEY: "test-only" },
      transport: async () => {
        throw new BillingHttpError(recorded.boatMissing.status);
      },
    });
    expect(result.providers[0]?.billedUSD).toBeNull();
    expect(result.providers[0]?.meteredUSD).toBeNull();
  });
  it("retains the recorded Boat list-price meter without calling it a bill", () => {
    expect(decodeBoat(recorded.boat, "fixture-boat")).toMatchObject({
      kind: "metered",
      usd: recorded.boat.dollars,
      complete: !recorded.boat.running,
    });
  });
  it("rejects mismatched IDs, negative amounts and numeric strings", () => {
    expect(() => decodeUpstash(recorded.upstash, "wrong")).toThrow();
    expect(() =>
      decodeUpstash({ ...recorded.upstash, total_compute_cost_usd: -1 }, "fixture-upstash"),
    ).toThrow();
    expect(() =>
      decodeUpstash({ ...recorded.upstash, total_compute_cost_usd: "0.1" }, "fixture-upstash"),
    ).toThrow();
  });
  it("does not report a complete scenario cost when some attempts have no sandbox ID", async () => {
    const directory = await report([sample(), sample("upstash", null)]);
    const result = await collectBilling({
      report: directory,
      env: { UPSTASH_BOX_API_KEY: "test-only" },
      transport: async () => recorded.upstash,
    });
    expect(result.providers[0]?.scenarios[0]?.billedCostPerTaskUSD).toBeNull();
    expect(result.providers[0]?.scenarios[0]?.recoveredBilledUSD).toBe(
      recorded.upstash.total_compute_cost_usd,
    );
  });
  it("does not finalize an active box", () => {
    expect(
      decodeUpstash({ ...recorded.upstash, status: "running" }, "fixture-upstash"),
    ).toMatchObject({ kind: "billed", complete: false });
  });
  it("uses all E2B execution segments in milliseconds, deduplicating events", () => {
    const cost = decodeEvents([...recorded.e2b, ...recorded.e2b]);
    expect(cost.kind).toBe("metered");
    if (cost.kind !== "unavailable") expect(cost.usd).toBeCloseTo(0.0015146175, 12);
    expect(decodeEvents([]).kind).toBe("unavailable");
    expect(
      decodeEvents(recorded.e2b.filter((e) => e.type !== "sandbox.lifecycle.created")).kind,
    ).toBe("unavailable");
  });
  it("keeps boxd current-rate meters distinct from org billing and waits for complete", () => {
    expect(decodeBoxd(recorded.boxd, "fixture-boxd")).toMatchObject({
      kind: "metered",
      usd: 0.003386,
      complete: true,
    });
    expect(decodeBoxd({ ...recorded.boxd, complete: false }, "fixture-boxd")).toMatchObject({
      kind: "metered",
      complete: false,
      confidence: "low",
    });
    expect(decodeBoxd({ ...recorded.boxd, currency: "eur" }, "fixture-boxd").kind).toBe(
      "unavailable",
    );
  });
  it("reconciles recorded boxd account charges, pages activity and accepts native dates", async () => {
    const query = vi.fn(async (method: string, params: { pageToken?: string }) => {
      if (method === "usage")
        return {
          ...recorded.boxdOrg,
          period: {
            start: new Date(recorded.boxdOrg.period.start),
            end: new Date(recorded.boxdOrg.period.end),
          },
        };
      return params.pageToken
        ? { currency: "usd", entries: [], nextPageToken: null }
        : { ...recorded.boxdActivity, nextPageToken: "next-page" };
    });
    const result = await readBoxdAccount(
      [{ ...row, provider: "boxd", id: "fixture-boxd" }],
      {},
      query,
    );
    expect(query).toHaveBeenCalledTimes(3);
    expect(result.usage.machines[0]?.costMicro).toBe(3386);
    expect(result.account.charged).toBe(0.15878);
    expect(result.account.currency).toBe("usd");
    expect(result.usage.period.start).toBe("2026-10-19T00:00:00.000Z");
  });
  it("reports scenarios with no sandbox IDs as unknown", async () => {
    const directory = await report([sample("upstash", null, "cold")]);
    const result = await collectBilling({ report: directory, env: {}, transport: noNetwork });
    expect(result.providers[0]?.scenarios[0]).toMatchObject({
      scenario: "cold",
      samplesWithoutSandboxId: 1,
      billedUSD: null,
      billedCostPerTaskUSD: null,
    });
  });
  it("pages E2B history before claiming a complete meter", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      id: `update-${i}`,
      type: "sandbox.lifecycle.updated",
    }));
    const transport = vi.fn<Transport>(async (url) =>
      url.includes("offset=0") ? filler : recorded.e2b,
    );
    const result = await collectProvider(
      "e2b",
      [{ ...row, provider: "e2b" }],
      { E2B_API_KEY: "test-only" },
      transport,
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.sandboxes[0]?.cost.kind).toBe("metered");
  });
  it("keeps Superserve's account buckets and credit-adjusted invoice separate from task costs", async () => {
    const result = await collectProvider(
      "superserve",
      [{ ...row, provider: "superserve" }],
      { SUPERSERVE_API_KEY: "test-only" },
      async (url) =>
        url.includes("/summary")
          ? recorded.superserve.summary
          : url.includes("/pricing")
            ? recorded.superserve.pricing
            : recorded.superserve.series,
    );
    expect(result.sandboxes[0]?.cost.kind).toBe("unavailable");
    expect(result.account).toMatchObject({
      summary: { expected_invoice_amount_usd: 0, current_charges_usd: 0.1213959469865 },
    });
  });
  it("uses Daytona's API-key org without persisting its secret value and marks delayed charges pending", async () => {
    const transport = vi.fn<Transport>(async (url) =>
      url.includes("api-keys/current")
        ? { organizationId: "org", value: "NEVER_SAVE" }
        : recorded.daytonaAggregate,
    );
    const result = await collectProvider(
      "daytona",
      [
        {
          ...row,
          provider: "daytona",
          id: "fixture-daytona",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      ],
      { DAYTONA_API_KEY: "test-only" },
      transport,
    );
    expect(result.sandboxes[0]?.cost).toMatchObject({ kind: "billed", complete: false });
    expect(JSON.stringify(result)).not.toContain("NEVER_SAVE");
    expect(transport.mock.calls[1]?.[0]).toContain(
      "analytics.app.daytona.io/organization/org/usage/sandbox",
    );
  });
  it("never promotes settled Daytona window prices into lifetime cost per task", async () => {
    const directory = await report([sample("daytona", "fixture-daytona")]);
    const result = await collectBilling({
      report: directory,
      env: { DAYTONA_API_KEY: "test-only", DAYTONA_ORGANIZATION_ID: "org" },
      transport: async () => recorded.daytonaAggregate,
    });
    expect(result.providers[0]?.sandboxes[0]?.cost).toMatchObject({
      kind: "billed",
      complete: true,
      scope: "window",
    });
    expect(result.providers[0]?.billedUSD).toBeNull();
    expect(result.providers[0]?.recoveredWindowBilledUSD).toBe(0.0016438636);
    expect(result.providers[0]?.scenarios[0]?.billedCostPerTaskUSD).toBeNull();
    expect(decodeBoxd(recorded.boxd, "fixture-boxd", "window")).toMatchObject({
      kind: "metered",
      complete: true,
      scope: "window",
    });
  });
  it("runs the real CLI handler offline and refuses to overwrite report inputs", async () => {
    const directory = await report([sample()]);
    const out = join(directory, "billing.json");
    await billingCommand(["--report", directory, "--offline"]);
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({
      schemaVersion: 1,
      providers: [{ billedUSD: null }],
    });
    await expect(
      billingCommand(["--report", directory, "--out", join(directory, "samples.ndjson")]),
    ).rejects.toThrow("overwrite");
    await expect(billingCommand(["--out", out])).rejects.toThrow("requires --report");
    await expect(billingCommand(["--report", directory, "--wait-ms", "1500001"])).rejects.toThrow(
      "--wait-ms",
    );
  });
});
