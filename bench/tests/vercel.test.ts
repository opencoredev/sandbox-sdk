import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { collectProvider, decodeVercel, vercelMeter } from "../src/billing/providers.js";
import {
  billingModelLabel,
  billingRule,
  chargesBelowAllocation,
} from "../src/cost/billing-rules.js";
import { lookupSandbox } from "../src/existence.js";
import { estimateCost, priceAtSize } from "../src/pricing.js";
import { providerDefaults } from "../src/providers.js";
import { providerSetup } from "../src/realistic/setup.js";
import { snapshotMetadata } from "../src/snapshots.js";
import { fakeNativeModules } from "./native-fakes.js";

/** Vercel's SDK throws an APIError that carries the HTTP Response. */
const notFound = () =>
  Object.assign(new Error("Status code 404 is not ok"), {
    response: new Response(null, { status: 404 }),
  });

const stopped = {
  name: "sbx-1",
  status: "stopped",
  totalActiveCpuDurationMs: 6476,
  totalDurationMs: 8964,
  memory: 4096,
};

const row = (id: string) => ({
  provider: "vercel",
  id,
  scenarios: new Set(["sandbox-lifetime"]),
  startedAt: null,
  finishedAt: null,
  confirmedStopAt: null,
  app: null,
});

const env = { VERCEL_OIDC_TOKEN: "token" };

afterEach(() => {
  vi.restoreAllMocks();
});

it("prices Vercel's meter: active CPU, memory rounded up to whole minutes, one creation", () => {
  const cost = decodeVercel(stopped, "sbx-1");

  // 6.476 CPU-s at $0.128/h, 4 GB for 60 s (one-minute minimum) at $0.0212/GB-h, $0.60 per million.
  const expected = (6.476 * 0.128) / 3600 + (4 * 60 * 0.0212) / 3600 + 0.6 / 1e6;
  expect(cost).toMatchObject({ kind: "metered", scope: "sandbox-lifetime", complete: true });
  expect(cost.kind === "metered" && cost.usd).toBeCloseTo(expected, 12);

  // 61 s of wall time bills two minutes of memory.
  const longer = decodeVercel({ ...stopped, totalDurationMs: 61_000 }, "sbx-1");
  expect(longer.kind === "metered" && longer.usd).toBeCloseTo(
    (6.476 * 0.128) / 3600 + (4 * 120 * 0.0212) / 3600 + 0.6 / 1e6,
    12,
  );
});

it("refuses a meter that is not final, incomplete or for another sandbox", () => {
  expect(decodeVercel({ ...stopped, status: "running" }, "sbx-1")).toMatchObject({
    kind: "unavailable",
  });
  expect(decodeVercel({ ...stopped, totalDurationMs: undefined }, "sbx-1").kind).toBe(
    "unavailable",
  );
  expect(() => decodeVercel(stopped, "sbx-2")).toThrow("Billing ID mismatch");
});

it("collects a saved meter first, reads live otherwise, and reports a deleted sandbox as unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vercel-usage-"));
  await writeFile(
    join(dir, "vercel-sbx-1.json"),
    JSON.stringify({ capturedAt: "2026-11-09T00:00:00Z", meter: stopped }),
  );

  const read = vi.spyOn(vercelMeter, "read").mockImplementation(async (name) => {
    if (name === "sbx-2") return { ...stopped, name };
    throw notFound();
  });

  const result = await collectProvider(
    "vercel",
    [row("sbx-1"), row("sbx-2"), row("sbx-3")],
    env,
    undefined,
    false,
    0,
    { usageDir: dir },
  );

  expect(read).not.toHaveBeenCalledWith("sbx-1");
  expect(result.sandboxes.map((s) => s.cost.kind)).toEqual(["metered", "metered", "unavailable"]);
  expect(result.sandboxes[2]?.cost).toMatchObject({
    note: expect.stringContaining("between stop and delete"),
  });
});

it("needs a Vercel token before reading the meter", async () => {
  const read = vi.spyOn(vercelMeter, "read");
  const result = await collectProvider("vercel", [row("sbx-1")], {});

  expect(read).not.toHaveBeenCalled();
  expect(result.sandboxes[0]?.cost).toMatchObject({ kind: "unavailable" });
});

it("treats Vercel's 404 as absence and a readable sandbox as present", async () => {
  const get = vi.fn(async ({ name }: { name: string }) => {
    if (name === "gone") throw notFound();

    return { name, status: "stopped" };
  });

  fakeNativeModules({
    "@vercel/sandbox": {
      // SAFETY: lookupSandbox reads only `name` and `status` from Sandbox.get's result.
      Sandbox: { get: get as never },
      // SAFETY: the sandbox lookup never reads snapshots.
      Snapshot: { get: vi.fn() as never },
    },
  });

  const provider = { ...memory(), name: "vercel" };
  expect(await lookupSandbox(provider, "gone", 1000)).toMatchObject({ result: "not-found" });
  expect(await lookupSandbox(provider, "here", 1000)).toMatchObject({
    result: "present",
    nativeState: "stopped",
  });
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ name: "here", resume: false }));
});

it("reads a deleted Vercel snapshot as gone", async () => {
  const status = { value: "created" };

  fakeNativeModules({
    "@vercel/sandbox": {
      // SAFETY: snapshot inspection never reads sandboxes.
      Sandbox: { get: vi.fn() as never },
      Snapshot: {
        // SAFETY: inspection reads only `snapshotId` and `status` from Snapshot.get's result.
        get: (async ({ snapshotId }: { snapshotId: string }) => ({
          snapshotId,
          status: status.value,
        })) as never,
      },
    },
  });

  const provider = { ...memory(), name: "vercel" };
  expect(await snapshotMetadata.inspect("vercel", provider, "sbx-1", "snap_1")).toEqual({
    exists: true,
  });
  status.value = "deleted";
  expect(await snapshotMetadata.inspect("vercel", provider, "sbx-1", "snap_1")).toEqual({
    exists: false,
  });
});

it("registers Vercel's sizes, prices, billing rule and setup", () => {
  expect(priceAtSize("vercel", { cpu: 4, memoryGiB: 8 })).toBeCloseTo(4 * 0.128 + 8 * 0.0212, 10);
  expect(priceAtSize("vercel", { cpu: 4, memoryGiB: 16 })).toBeNull();
  // Ten seconds of a 2 vCPU / 4 GB sandbox is billed as one minute.
  expect(estimateCost("vercel", 10_000, { cpu: 2, memoryGiB: 4, diskGiB: 64 })).toBeCloseTo(
    ((2 * 0.128 + 4 * 0.0212) * 60) / 3600 + 0.6 / 1e6,
    12,
  );

  const rule = billingRule("vercel", null);

  if (!rule) throw new Error("Vercel billing rule missing");
  expect(rule).toMatchObject({ reportedKind: "metered", attribution: "per-sandbox" });
  expect(billingModelLabel(rule)).toBe("bills active CPU and the whole memory allocation");
  expect(chargesBelowAllocation(rule)).toBe(true);
  expect(providerDefaults("vercel")).toEqual({ deleteOrphanSnapshots: true });
  expect(providerSetup("vercel").tracks["same-machine"]).toMatchObject({ size: "large", vcpu: 4 });
});

it("deletes a cost-suite sandbox when Vercel's meter capture never returns", async () => {
  const { runV2 } = await import("../src/v2-runner.js");
  const { parseV2 } = await import("../src/v2-config.js");
  const out = await mkdtemp(join(tmpdir(), "bench-vercel-stall-"));
  const stop = vi.spyOn(vercelMeter, "stop").mockImplementation(() => new Promise(() => {}));
  const provider = memory();

  const report = await runV2(
    [{ kind: "ready", name: "vercel", cloud: false, region: null, provider }],
    parseV2([
      "--providers",
      "vercel",
      "--scenarios",
      "cost",
      "--cost-runs",
      "1",
      "--bursts",
      "",
      "--timeout-ms",
      "2000",
      "--out",
      out,
    ]),
    async () => {},
  );

  expect(stop).toHaveBeenCalled();
  expect(await provider.list({})).toEqual([]);
  expect(report.cleanup.every((entry) => entry.remaining.length === 0)).toBe(true);
}, 30_000);
