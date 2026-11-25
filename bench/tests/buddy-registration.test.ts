import { afterEach, describe, expect, it, vi } from "vitest";
import { buddy } from "@opencoredev/sandbox-sdk/buddy";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { allocationEvidence, requestBilledCompute, requestedSize } from "../src/allocation.js";
import { cloudProviders } from "../src/attempts.js";
import { pricedResources, reservationResources } from "../src/billed-resources.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { lookupSandbox } from "../src/existence.js";
import { estimateCost, pricing } from "../src/pricing.js";
import { missingCredentials } from "../src/providers.js";
import { provisionedAllocation } from "../src/provisioned-allocations.js";
import { heldOpenProviders } from "../src/realistic/cli.js";
import { providerSetup } from "../src/realistic/setup.js";
import {
  inspectSnapshot,
  journaledSnapshotName,
  settleBuddySave,
  settleJournaledSnapshot,
  snapshotCleaner,
} from "../src/snapshots.js";
import { costPerTask } from "../src/task-cost.js";
import type { PublicationReport } from "../src/merge.js";
import type { Sample } from "../src/v2-model.js";
import { sanitize } from "../src/v2-runner.js";
import { bound } from "./native-fakes.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const env = () => {
  vi.stubEnv("BUDDY_TOKEN", "buddy-test-token");
  vi.stubEnv("BUDDY_WORKSPACE", "ws");
};

/** A Buddy adapter instance bound to the stubbed connection, as `loadProvider` binds the bench's own. */
const buddyProvider = () => bound({ ...memory(), name: "buddy" });

/** A fetch stub routed by method and path under `/workspaces/ws`. */
function routes(handler: (method: string, path: string) => Response) {
  const calls: { method: string; path: string }[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/workspaces\/ws/, "");

    calls.push({ method, path });

    return handler(method, path);
  });

  return calls;
}

const missing = () =>
  Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });

const snapshot = (id: string, name: string, source?: string, status = "CREATED") => ({
  id,
  name,
  status,
  url: source
    ? `https://api.buddy.works/workspaces/ws/sandboxes/${source}/snapshots/${id}`
    : `https://api.buddy.works/workspaces/ws/sandboxes/snapshots/${id}`,
});

describe("Buddy bench registration", () => {
  it("is a cloud provider with Buddy's tiers, its 2x4 default and both credentials", () => {
    expect(cloudProviders).toContain("buddy");
    expect(requestedSize("buddy", "small")).toEqual({ cpu: 2, memoryGiB: 4 });
    expect(requestedSize("buddy", "medium")).toEqual({ cpu: 4, memoryGiB: 8 });
    expect(requestedSize("buddy", "large")).toEqual({ cpu: 8, memoryGiB: 16 });
    expect(provisionedAllocation("buddy", null)).toEqual({ cpu: 2, memoryGiB: 4, diskGiB: 50 });
    expect(missingCredentials("buddy", {})).toEqual(["BUDDY_TOKEN", "BUDDY_WORKSPACE"]);
    expect(missingCredentials("buddy", { BUDDY_TOKEN: "t", BUDDY_WORKSPACE: "w" })).toEqual([]);
  });

  it("prices the native tier per started minute, with a one-minute minimum and no disk", () => {
    const price = pricing.buddy;

    expect(price).toMatchObject({
      incrementSeconds: 60,
      minimumSeconds: 60,
      diskGiBSecond: 0,
      requestBilled: { minimum: { cpu: 2, memoryGiB: 4 }, defaultBound: "exact" },
    });

    const tier = { cpu: 2, memoryGiB: 4, diskGiB: 50 };

    // 2 vCPU and 4 GB at $0.0144 each per hour.
    expect(estimateCost("buddy", 3_600_000, tier)).toBeCloseTo(0.0864, 9);
    // A 25-second sandbox bills one whole minute; 61 seconds bill two.
    expect(estimateCost("buddy", 25_000, tier)).toBeCloseTo(0.0864 / 60, 9);
    expect(estimateCost("buddy", 61_000, tier)).toBeCloseTo((0.0864 / 60) * 2, 9);
    expect(price?.notes).toMatch(/decimal/);
    expect(price?.notes).toMatch(/Storage .* excluded/);
  });

  it("prices the requested tier exactly, the unsized default too, never the guest's decimal-GB view", () => {
    expect(requestBilledCompute("buddy", null)).toEqual({
      compute: { cpu: 2, memoryGiB: 4 },
      bound: "exact",
    });
    // Modal's unsized default stays a lower bound: its burst above the request is billed too.
    expect(requestBilledCompute("modal", null)?.bound).toBe("lower");
    expect(pricedResources("buddy", null, null)).toEqual({
      resources: { cpu: 2, memoryGiB: 4, diskGiB: 0 },
      bound: "exact",
    });
    expect(reservationResources("buddy", null, { cpu: 4, memoryMb: 8192 })).toEqual({
      cpu: 4,
      memoryGiB: 8,
      diskGiB: 0,
    });

    // A 4x8 guest shows 7629 MiB: the gap stays a caveat and the tier is priced; never equal-spec.
    const memory = 7629 * 1024 * 1024;

    const row: Pick<
      Sample,
      "provider" | "scenario" | "fingerprint" | "requestedSize" | "template"
    > = {
      provider: "buddy",
      scenario: "fingerprint",
      requestedSize: { cpu: 4, memoryMb: 8192 },
      template: null,
      fingerprint: {
        cpuModel: "AMD EPYC 9645",
        flags: [],
        nproc: 4,
        cpuMax: "",
        quotaCpus: 4,
        memoryMax: "",
        memTotalBytes: memory,
        memoryBytes: memory,
        diskBytes: 46 * 1024 ** 3,
        df: "",
        lsblk: "",
        virtualization: "kvm",
        hypervisor: true,
        dmi: "",
        kernel: "6.8.0-147-generic",
        distro: "Ubuntu 24.04.5 LTS",
        user: "buddy",
        uid: 1001,
        sudo: true,
        stealPercent: 0,
        egress: null,
        tools: {},
        runtime: "test",
      },
    };

    const evidence = allocationEvidence([row], "buddy");

    expect(evidence.pricingAllocation).toEqual({ cpu: 4, memoryGiB: 8 });
    expect(evidence.mismatches.join(" ")).toMatch(/memory/i);
    expect(evidence.equalSpec).toBe(false);
  });

  it("reports cost as an estimate, with no settled source, and stays out of the held-open idle test", () => {
    // SAFETY: costPerTask reads only `samples` when no cost rows exist.
    const report = { samples: [] } as never satisfies Partial<PublicationReport>;

    expect(costPerTask(report, "buddy")).toMatchObject({ kind: "estimate", usd: null });
    expect(billingRule("buddy", null)).toMatchObject({
      pricingKey: "buddy",
      reportedKind: "estimate",
      attribution: "none",
      incrementSeconds: { kind: "known", value: 60 },
      minimumSeconds: { kind: "known", value: 60 },
      storage: { kind: "known", value: "excluded" },
    });
    expect(heldOpenProviders).not.toContain("buddy");

    const setup = providerSetup("buddy");

    expect(setup).toMatchObject({ adapter: "buddy", lifetime: false, pricingKey: "buddy" });
    expect(setup.tracks["same-machine"]).toMatchObject({
      size: { cpu: 4, memoryMb: 8192 },
      provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 50 },
    });
  });

  it("redacts Buddy's encrypted values and Basic credentials from run records", () => {
    const text = sanitize(
      'value "!encrypted tQs+j5Hw/MU2sWPyFa4G1g==.owEjT7LZ" header Basic c2J4OnNlY3JldHBhc3N3b3Jk',
    );

    expect(text).not.toContain("tQs+j5Hw");
    expect(text).not.toContain("c2J4OnNlY3JldHBhc3N3b3Jk");
  });

  it("reads a sandbox with a GET: a 404 is absence only when Buddy says the resource is missing", async () => {
    env();
    const provider = buddyProvider();

    const calls = routes((_, path) =>
      path === "/sandboxes/gone"
        ? missing()
        : path === "/sandboxes/odd"
          ? Response.json({ errors: [{ message: "Something else" }] }, { status: 404 })
          : Response.json({ id: "live", status: "RUNNING" }),
    );

    expect((await lookupSandbox(provider, "live", 5000)).result).toBe("present");
    expect((await lookupSandbox(provider, "gone", 5000)).result).toBe("not-found");
    expect((await lookupSandbox(provider, "odd", 5000)).result).toBe("unavailable");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("Buddy reads through the adapter instance's own connection", () => {
  it("sends lookups and snapshot calls to the bound workspace, host and token, never the environment's", async () => {
    vi.stubEnv("BUDDY_TOKEN", "env-token");
    vi.stubEnv("BUDDY_WORKSPACE", "env-ws");
    vi.stubEnv("BUDDY_API_URL", "https://env.invalid");

    const provider = bound(
      { ...memory(), name: "buddy" },
      { token: "bound-token", workspace: "bound-ws", baseUrl: "https://bound.invalid/" },
    );

    const seen: { url: string; auth: string | null; redirect: RequestRedirect | undefined }[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get("Authorization"),
        redirect: init?.redirect,
      });

      return Response.json({ id: "live", status: "RUNNING", snapshots: [] });
    });

    expect((await lookupSandbox(provider, "live", 5000)).result).toBe("present");
    await expect(
      inspectSnapshot("buddy", provider, "src", "sn-1", undefined, "bench-x-1"),
    ).rejects.toThrow();

    expect(seen.length).toBeGreaterThan(1);

    for (const call of seen) {
      expect(call.url.startsWith("https://bound.invalid/workspaces/bound-ws/")).toBe(true);
      expect(call.auth).toBe("Bearer bound-token");
      expect(call.redirect).toBe("error");
    }
  });

  it("refuses to read when the instance was never bound or its connection did not resolve", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    // SAFETY: lookupSandbox reads only `provider.name` before it asks for the bound connection.
    const unbound: Parameters<typeof lookupSandbox>[0] = { name: "buddy" } as never;

    expect((await lookupSandbox(unbound, "live", 5000)).result).toBe("unavailable");

    vi.stubEnv("BUDDY_TOKEN", "t");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_REGION", "MARS");
    expect((await lookupSandbox(buddyProvider(), "live", 5000)).result).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps bound credentials after env changes and refuses same-origin 307 on sandbox DELETE", async () => {
    vi.stubEnv("BUDDY_TOKEN", "orig-token");
    vi.stubEnv("BUDDY_WORKSPACE", "orig-ws");
    vi.stubEnv("BUDDY_API_URL", "https://buddy.invalid");

    const provider = bound(buddy(), {});

    vi.stubEnv("BUDDY_TOKEN", "other-token");
    vi.stubEnv("BUDDY_WORKSPACE", "other-ws");

    const seen: { method: string; url: string; auth: string | null }[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seen.push({ method, url, auth: new Headers(init?.headers).get("Authorization") });

      if (method === "GET" && url.endsWith("/sandboxes")) {
        return Response.json({ sandboxes: [] });
      }

      if (method === "DELETE" && url.endsWith("/workspaces/orig-ws/sandboxes/sbx-1")) {
        return new Response(null, {
          status: 307,
          headers: { location: "/workspaces/other-ws/sandboxes/victim" },
        });
      }

      return new Response(null, { status: 204 });
    });

    expect(await provider.list({})).toEqual([]);
    await expect(provider.destroy("sbx-1")).rejects.toMatchObject({
      code: "outcome_unknown",
      retryable: false,
    });

    expect(seen).toEqual([
      {
        method: "GET",
        url: "https://buddy.invalid/workspaces/orig-ws/sandboxes",
        auth: "Bearer orig-token",
      },
      {
        method: "DELETE",
        url: "https://buddy.invalid/workspaces/orig-ws/sandboxes/sbx-1",
        auth: "Bearer orig-token",
      },
    ]);
  });
});

describe("Buddy snapshots journaled by name before the save", () => {
  it("names the snapshot from the run label", () => {
    expect(journaledSnapshotName("Run 1/Buddy")).toMatch(/^bench-run-1-buddy-[0-9a-f]{8}$/);
  });

  it("settles a pending save by its exact name, finding the snapshot's ID", async () => {
    env();
    routes((_, path) =>
      path === "/sandboxes/src/snapshots"
        ? Response.json({ snapshots: [snapshot("sn-other", "bench-x-other", "src")] })
        : Response.json({ snapshots: [snapshot("sn-1", "bench-x-1", "src")] }),
    );

    await expect(
      settleJournaledSnapshot(
        "buddy",
        buddyProvider(),
        {
          id: "bench-x-1",
          parent: "src",
          pendingSave: { name: "bench-x-1", journaledAt: new Date().toISOString() },
        },
        5000,
      ),
    ).resolves.toEqual({ kind: "exists", id: "sn-1" });
  });

  it("never drops a fresh pending save on a miss while its source exists", async () => {
    env();
    routes((_, path) =>
      path === "/sandboxes/src/snapshots"
        ? Response.json({ snapshots: [] })
        : Response.json({ snapshots: [] }),
    );

    await expect(
      settleBuddySave({
        provider: buddyProvider(),
        sandboxId: "src",
        name: "bench-x-1",
        journaledAt: new Date().toISOString(),
        timeoutMs: 1500,
      }),
    ).rejects.toThrow(/did not settle/);
  });

  it("calls a save absent only after two misses five seconds apart, once it can no longer land", async () => {
    env();
    vi.useFakeTimers();
    let reads = 0;

    routes((_, path) => {
      if (path === "/sandboxes/src/snapshots") {
        reads++;

        return missing();
      }

      return Response.json({ snapshots: [snapshot("sn-9", "bench-other", undefined)] });
    });

    const settled = settleBuddySave({
      provider: buddyProvider(),
      sandboxId: "src",
      name: "bench-x-1",
      journaledAt: new Date().toISOString(),
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(4000);
    expect(reads).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(settled).resolves.toEqual({ kind: "absent" });
  });

  it("deletes only the exact journaled ID and name, and only from the journaled source", async () => {
    env();
    const provider = buddyProvider();
    const deleted: string[] = [];
    let status = "CREATING";

    routes((method, path) => {
      if (method === "DELETE") {
        deleted.push(path);

        return path.endsWith("/sn-404") ? missing() : new Response(null, { status: 204 });
      }

      if (path.endsWith("/snapshots/sn-missing")) return missing();

      const list = {
        snapshots: [
          snapshot("sn-1", "bench-x-1", "src", status),
          snapshot("sn-2", "bench-x-2", "other-src"),
          snapshot("sn-404", "bench-x-3"),
        ],
      };

      status = "CREATED";

      return Response.json(list);
    });

    await expect(
      inspectSnapshot("buddy", provider, "src", "sn-1", undefined, "bench-x-1"),
    ).resolves.toEqual({
      exists: true,
      sourceId: "src",
    });
    await expect(
      inspectSnapshot("buddy", provider, "src", "sn-1", undefined, "bench-x-9"),
    ).rejects.toThrow(/name differs/);
    // An ID alone never proves the snapshot is the journal's.
    await expect(inspectSnapshot("buddy", provider, "src", "sn-1")).rejects.toThrow(
      /no journaled name/,
    );
    // Another source's snapshot is reported with that source, which deleteProvenSnapshot refuses.
    await expect(
      inspectSnapshot("buddy", provider, "src", "sn-2", undefined, "bench-x-2"),
    ).resolves.toEqual({
      exists: true,
      sourceId: "other-src",
    });
    // Absent only when neither the workspace's list nor the source's shows it.
    await expect(
      inspectSnapshot("buddy", provider, "src", "sn-missing", undefined, "bench-x-4"),
    ).resolves.toEqual({
      exists: false,
    });

    const clean = await snapshotCleaner("buddy", provider, "src");

    await clean("sn-1");
    await clean("sn-404");
    // A miss in the workspace list, which can lag, still sends the delete: only its 404 is absence.
    await clean("sn-missing");
    expect(deleted).toEqual([
      "/sandboxes/snapshots/sn-1",
      "/sandboxes/snapshots/sn-404",
      "/sandboxes/snapshots/sn-missing",
    ]);
  });
});
