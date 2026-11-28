import { afterEach, describe, expect, it, vi } from "vitest";
import { agent37 } from "@opencoredev/sandbox-sdk/agent37";
import { requestedSize } from "../src/allocation.js";
import { cloudProviders } from "../src/attempts.js";
import {
  agent37UsageQuery,
  BillingHttpError,
  collectProvider,
  decodeAgent37,
  type Agent37Usage,
  type Transport,
} from "../src/billing/providers.js";
import { agent37Config, fingerprintOf } from "../src/connections.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { lookupSandbox } from "../src/existence.js";
import { lifetimeOptions } from "../src/lifetime.js";
import { estimateCost, priceAtSize } from "../src/pricing.js";
import { missingCredentials, providerNames, templateOptions } from "../src/providers.js";
import { provisionedAllocation } from "../src/provisioned-allocations.js";
import { heldOpenProviders } from "../src/realistic/cli.js";
import { providerSetup } from "../src/realistic/setup.js";
import { accountCap } from "../src/scenarios.js";
import { inspectSnapshot, snapshotCleaner, snapshotsFromSource } from "../src/snapshots.js";
import { sanitize } from "../src/v2-runner.js";
import { bound } from "./native-fakes.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const key = "sk_live_testkey0123456789";

/** The adapter as `loadProvider` builds and binds it, on a test key. */
function provider() {
  vi.stubEnv("AGENT37_API_KEY", key);
  vi.stubEnv("AGENT37_API_URL", undefined);

  return bound(agent37());
}

/** Agent 37's answers by method and path, recording every request; anything else is a route 404. */
function fakeApi(routes: Record<string, () => Response>) {
  const calls: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const call = `${init?.method ?? "GET"} ${url.origin}${url.pathname}`;

    calls.push(call);

    return routes[call]?.() ?? Response.json({ error: { code: "not_found" } }, { status: 404 });
  });

  return calls;
}

const instance = (id: string, status: string, metadata: Record<string, string> | null = null) =>
  Response.json({ id, status, metadata });

const api = "https://api.agent37.com/v1";

describe("Agent 37 bench registration", () => {
  it("is a cloud provider with one key, a template option and Agent 37's sizes", () => {
    expect(cloudProviders).toContain("agent37");
    expect(providerNames).toContain("agent37");
    expect(missingCredentials("agent37", {})).toEqual(["AGENT37_API_KEY"]);
    expect(missingCredentials("agent37", { AGENT37_API_KEY: key })).toEqual([]);
    expect(templateOptions("agent37", "agent37-base")).toEqual({ template: "agent37-base" });
    expect(requestedSize("agent37", "small")).toEqual({ cpu: 2, memoryGiB: 4 });
    expect(requestedSize("agent37", "medium")).toEqual({ cpu: 4, memoryGiB: 8 });
    expect(requestedSize("agent37", "large")).toEqual({ cpu: 4, memoryGiB: 16 });
    expect(provisionedAllocation("agent37", null)).toEqual({ cpu: 2, memoryGiB: 4, diskGiB: 4 });
    expect(provisionedAllocation("agent37", "agent37-base")).toEqual({
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 4,
    });
  });

  it("takes no factory lifetime, since the adapter refuses timeoutMs", () => {
    expect(lifetimeOptions("agent37", {})).toEqual({});
    expect(() => lifetimeOptions("agent37", { "lifetime-ms": { agent37: 600_000 } })).toThrow(
      /no factory lifetime/,
    );
  });

  it("admits bursts up to the tier 2 cap of 50 smallest instances", () => {
    expect(accountCap("agent37", {})).toBe(50);
    expect(accountCap("agent37", { agent37: 25 })).toBe(25);
  });

  it("runs same-machine at 4/8 with its default disk and stays out of the held-open idle test", () => {
    const setup = providerSetup("agent37");

    expect(setup).toMatchObject({ adapter: "agent37", lifetime: false, pricingKey: "agent37" });
    expect(setup.tracks["same-machine"]).toMatchObject({
      size: { cpu: 4, memoryMb: 8192 },
      provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 6 },
    });
    expect(setup.tracks.default).toMatchObject({ vcpu: 2, provisioned: { cpu: 2, memoryGiB: 4 } });
    expect(heldOpenProviders).not.toContain("agent37");
  });
});

describe("Agent 37 pricing", () => {
  it("prices the default-disk sizes at the published monthly rates over 730 hours", () => {
    expect(estimateCost("agent37", 3_600_000, { cpu: 2, memoryGiB: 4, diskGiB: 4 })).toBeCloseTo(
      4.76 / 730,
      12,
    );
    expect(estimateCost("agent37", 3_600_000, { cpu: 4, memoryGiB: 8, diskGiB: 6 })).toBeCloseTo(
      9.34 / 730,
      12,
    );
  });

  it("bills whole minutes, so a 10-second instance costs one minute", () => {
    expect(estimateCost("agent37", 10_000, { cpu: 2, memoryGiB: 4, diskGiB: 4 })).toBeCloseTo(
      4.76 / 730 / 60,
      12,
    );
  });

  it("offers only Agent 37's four sizes", () => {
    expect(priceAtSize("agent37", { cpu: 4, memoryGiB: 32 })).toBeCloseTo((3.2 + 22.4) / 730, 12);
    expect(priceAtSize("agent37", { cpu: 8, memoryGiB: 16 })).toBeNull();
  });

  it("has a metered per-sandbox rule in which disk and snapshots keep charging", () => {
    expect(billingRule("agent37", null)).toMatchObject({
      pricingKey: "agent37",
      reportedKind: "metered",
      attribution: "per-sandbox",
      storage: { kind: "known", value: "included" },
      keepsCharging: { kind: "known", value: ["disk", "snapshots"] },
      incrementSeconds: { kind: "known", value: 60 },
    });
  });
});

describe("Agent 37 connection", () => {
  it("resolves the key and host as the adapter does", () => {
    vi.stubEnv("AGENT37_API_KEY", ` ${key} `);
    vi.stubEnv("AGENT37_API_URL", "https://api.agent37.test//");

    expect(agent37Config()).toEqual({ apiKey: key, baseUrl: "https://api.agent37.test" });
    expect(agent37Config({ baseUrl: "https://other.test/" }).baseUrl).toBe("https://other.test");
  });

  it("fingerprints another key or host as another connection", async () => {
    const run = await fingerprintOf(provider());
    const otherKey = await fingerprintOf(bound(agent37(), { apiKey: "sk_live_otherkey0123456" }));
    const otherHost = await fingerprintOf(bound(agent37(), { baseUrl: "https://other.test" }));

    expect(run).toMatch(/^[0-9a-f]{16}$/);
    expect(otherKey).not.toBe(run);
    expect(otherHost).not.toBe(run);
  });
});

describe("Agent 37 existence checks", () => {
  it("reads an instance with one GET on the bound key", async () => {
    const p = provider();
    let auth: string | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      auth = new Headers(init?.headers).get("Authorization");
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.redirect).toBe("error");

      return instance("abc", "running");
    });

    expect(await lookupSandbox(p, "abc", 5000)).toMatchObject({
      result: "present",
      nativeState: "running",
    });
    expect(auth).toBe(`Bearer ${key}`);
  });

  it("counts only Agent 37's own 404 not_found as absence, and deleting as present", async () => {
    const p = provider();

    fakeApi({});
    expect(await lookupSandbox(p, "abc", 5000)).toMatchObject({ result: "not-found" });

    vi.restoreAllMocks();
    fakeApi({ [`GET ${api}/instances/abc`]: () => new Response("gone", { status: 404 }) });
    expect(await lookupSandbox(p, "abc", 5000)).toMatchObject({ result: "unavailable" });

    vi.restoreAllMocks();
    fakeApi({ [`GET ${api}/instances/abc`]: () => instance("abc", "deleting") });
    expect(await lookupSandbox(p, "abc", 5000)).toMatchObject({ result: "present" });

    vi.restoreAllMocks();
    fakeApi({ [`GET ${api}/instances/abc`]: () => instance("abc", "deleted") });
    expect(await lookupSandbox(p, "abc", 5000)).toMatchObject({ result: "terminal" });
  });

  it("refuses an answer for another instance", async () => {
    const p = provider();

    fakeApi({ [`GET ${api}/instances/abc`]: () => instance("xyz", "running") });
    expect(await lookupSandbox(p, "abc", 5000)).toMatchObject({ result: "unavailable" });
  });
});

describe("Agent 37 snapshots are stopped forks marked with their source", () => {
  const marker = (source: string) => ({ sandbox_sdk_snapshot: source, sandbox_sdk_alloc: "a" });

  it("inspects a snapshot's source from its marker, and a missing or deleting one as absent", async () => {
    const p = provider();

    fakeApi({
      [`GET ${api}/instances/snap`]: () => instance("snap", "stopped", marker("src")),
      [`GET ${api}/instances/going`]: () => instance("going", "deleting", marker("src")),
    });

    await expect(inspectSnapshot("agent37", p, "src", "snap")).resolves.toEqual({
      exists: true,
      sourceId: "src",
    });
    await expect(inspectSnapshot("agent37", p, "src", "going")).resolves.toEqual({
      exists: false,
    });
    await expect(inspectSnapshot("agent37", p, "src", "missing")).resolves.toEqual({
      exists: false,
    });
  });

  it("never treats an unmarked instance or an unknown 404 as a snapshot that is gone", async () => {
    const p = provider();

    fakeApi({
      [`GET ${api}/instances/plain`]: () => instance("plain", "running", { other: "x" }),
      [`GET ${api}/instances/odd`]: () => new Response("", { status: 404 }),
    });

    await expect(inspectSnapshot("agent37", p, "src", "plain")).rejects.toThrow(/source metadata/);
    await expect(inspectSnapshot("agent37", p, "src", "odd")).rejects.toThrow(/unknown 404/);
  });

  it("finds every live snapshot of a source by its marker", async () => {
    const p = provider();

    fakeApi({
      [`GET ${api}/instances`]: () =>
        Response.json({
          data: [
            { id: "s1", status: "stopped", metadata: marker("src") },
            { id: "s2", status: "deleting", metadata: marker("src") },
            { id: "s3", status: "stopped", metadata: marker("other") },
            { id: "src", status: "running", metadata: { "sandbox-bench-run": "r" } },
          ],
        }),
    });

    expect(await snapshotsFromSource("agent37", p, "src")).toEqual([{ id: "s1" }]);
  });

  it("deletes a snapshot only after a read shows its marker naming the source", async () => {
    const p = provider();

    const calls = fakeApi({
      [`GET ${api}/instances/snap`]: () => instance("snap", "stopped", marker("src")),
      [`DELETE ${api}/instances/snap`]: () => Response.json({ id: "snap", deleted: true }),
      [`GET ${api}/instances/foreign`]: () => instance("foreign", "stopped", marker("other")),
    });

    const clean = await snapshotCleaner("agent37", p, "src");

    await clean("snap");
    await expect(clean("foreign")).rejects.toThrow(/no deletion attempted/);
    // Already gone: nothing to delete.
    await clean("missing");

    expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      `DELETE ${api}/instances/snap`,
    ]);
  });
});

describe("Agent 37 billing", () => {
  const usage = (instances: Agent37Usage["instances"]): Agent37Usage => ({
    from: "2026-11-28",
    to: "2026-11-28",
    instances,
  });

  const entry = { id: "abc", compute_micros: 218, awake_minutes: 2 };

  it("asks for the UTC days the run window touches", () => {
    const query = agent37UsageQuery({
      start: "2026-11-28T23:00:00.000Z",
      end: "2026-11-29T01:00:00.000Z",
    });

    expect(Object.fromEntries(query)).toEqual({ from: "2026-11-28", to: "2026-11-29" });
  });

  it("is final only once the instance is deleted and the window has settled", () => {
    expect(decodeAgent37(usage([entry]), "abc", { deleted: true, settled: true })).toMatchObject({
      kind: "metered",
      usd: 0.000218,
      scope: "sandbox-lifetime",
      complete: true,
    });
    expect(decodeAgent37(usage([entry]), "abc", { deleted: false, settled: true })).toMatchObject({
      complete: false,
      confidence: "low",
    });
    expect(decodeAgent37(usage([entry]), "abc", { deleted: true, settled: false })).toMatchObject({
      complete: false,
    });
  });

  it("never counts a missing usage entry as $0", () => {
    expect(decodeAgent37(usage([]), "abc", { deleted: true, settled: true })).toMatchObject({
      kind: "unavailable",
    });
  });

  it("reads usage once and each instance's deletion with the run's key", async () => {
    const urls: string[] = [];

    const transport: Transport = async (url, headers) => {
      urls.push(url);
      expect(headers.Authorization).toBe(`Bearer ${key}`);

      if (url.includes("/v1/usage")) return usage([entry]);

      if (url.endsWith("/instances/abc")) throw new BillingHttpError(404);

      return { id: "def", status: "running" };
    };

    const row = (id: string) => ({
      provider: "agent37",
      id,
      scenarios: new Set(["sandbox-lifetime"]),
      startedAt: "2026-11-28T10:00:00.000Z",
      finishedAt: "2026-11-28T10:05:00.000Z",
      confirmedStopAt: null,
      app: null,
    });

    const result = await collectProvider(
      "agent37",
      [row("abc"), row("def")],
      { AGENT37_API_KEY: key },
      transport,
      false,
      0,
      { now: Date.parse("2026-11-28T13:00:00.000Z") },
    );

    expect(urls[0]).toBe(`${api}/usage?from=2026-11-28&to=2026-11-28`);
    expect(result.sandboxes.map((s) => [s.id, s.cost.kind])).toEqual([
      ["abc", "metered"],
      ["def", "unavailable"],
    ]);
    expect(result.sandboxes[0]?.cost).toMatchObject({ complete: true, usd: 0.000218 });
  });
});

describe("Agent 37 credentials stay out of the run's records", () => {
  it("redacts workspace keys and signed preview tokens", () => {
    const text = sanitize(
      "key sk_live_abcdefgh12345678 at https://p.agent37.app/?a37_token=secretvalue&x=1",
    );

    expect(text).not.toContain("sk_live_abcdefgh12345678");
    expect(text).not.toContain("secretvalue");
    expect(text).toContain("a37_token=[REDACTED]");
  });
});
