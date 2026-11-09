import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { CreateInput, Provider } from "@opencoredev/sandbox-sdk/provider";
import { resources, type Fingerprint } from "../src/fingerprint.js";
import { estimateCost, pricing } from "../src/pricing.js";
import { pricedResources, reservationResources } from "../src/billed-resources.js";
import { lifetimeOptions } from "../src/lifetime.js";
import { loadProvider, type DestroyTiming, type FactoryOptions } from "../src/providers.js";
import * as snapshots from "../src/snapshots.js";
import { runV2 } from "../src/v2-runner.js";
import { parseV2 } from "../src/v2-config.js";
import { fakeNativeModules } from "./native-fakes.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((out) => rm(out, { recursive: true, force: true })));
});

async function directory() {
  const out = await mkdtemp(join(tmpdir(), "bench-modal-"));
  dirs.push(out);

  return out;
}

const gib = 1024 ** 3;

/** What a Modal sandbox created without a size reports: one CPU and the host's whole memory. */
function defaultTrackFingerprint(hostGiB: number): Fingerprint {
  return {
    cpuModel: "unknown",
    flags: [],
    nproc: 1,
    cpuMax: "",
    quotaCpus: null,
    memoryMax: "",
    memTotalBytes: hostGiB * gib,
    memoryBytes: hostGiB * gib,
    diskBytes: 500 * gib,
    df: "",
    lsblk: "",
    virtualization: "",
    hypervisor: false,
    dmi: "",
    kernel: "4.19.0-gvisor",
    distro: "",
    user: "root",
    uid: 0,
    sudo: false,
    stealPercent: null,
    egress: null,
    tools: {},
    runtime: "",
  };
}

const mainSuiteMs = 180_000 * 19;

it("prices Modal sandboxes per second at the published Sandbox rates and region multipliers", () => {
  expect(pricing.modal).toMatchObject({
    currency: "USD",
    cpuSecond: 0.00003942,
    memoryGiBSecond: 0.00000667,
    diskGiBSecond: 0,
    incrementSeconds: 1,
    requestBilled: { minimum: { cpu: 0.125, memoryGiB: 0.125 } },
  });
  expect(pricing.modal?.notes).toMatch(/lower bound/i);
  const sameSpec = { cpu: 4, memoryGiB: 8, diskGiB: 0 };
  const hour = 3_600_000;
  const base = 4 * 0.00003942 * 3600 + 8 * 0.00000667 * 3600;
  expect(estimateCost("modal", hour, sameSpec)).toBeCloseTo(base, 6);
  expect(estimateCost("modal", hour, sameSpec, null)).toBeCloseTo(base, 6);
  expect(estimateCost("modal", hour, sameSpec, "us")).toBeCloseTo(base * 1.15, 6);
  expect(estimateCost("modal", hour, sameSpec, "us-east")).toBeCloseTo(base * 1.75, 6);
  // Modal charges a list mixing broad and narrow regions at the smaller multiplier.
  expect(estimateCost("modal", hour, sameSpec, "us,us-east")).toBeCloseTo(base * 1.15, 6);
  expect(estimateCost("modal", hour, sameSpec, "us-east,us-west")).toBeCloseTo(base * 1.75, 6);
  // Other providers have no region multiplier.
  expect(estimateCost("e2b", hour, sameSpec, "us-east")).toBe(estimateCost("e2b", hour, sameSpec));
});

it("never prices Modal from the guest's MemTotal: the default track is the minimum request, a lower bound", () => {
  const host = defaultTrackFingerprint(1024);

  // Pricing the guest view reproduces the reservation that stopped collection on the first iteration.
  expect(estimateCost("modal", mainSuiteMs, resources(host), "us-east")).toBeGreaterThan(36);

  for (const fp of [host, defaultTrackFingerprint(203), null]) {
    expect(pricedResources("modal", fp, null)).toEqual({
      resources: { cpu: 0.125, memoryGiB: 0.125, diskGiB: 0 },
      bound: "lower",
    });

    // The admission reserve is conservative, because a default sandbox bursts above its request.
    const reserve = estimateCost(
      "modal",
      mainSuiteMs,
      reservationResources("modal", fp, null),
      "us-east",
    );

    expect(reserve).toBeLessThan(3);
    expect(reserve).toBeGreaterThan(0.5);
  }

  // A sized sandbox is billed on its pinned request, which the guest also reports.
  const sized = { cpu: 4, memoryMb: 8192 };
  expect(pricedResources("modal", host, sized)).toEqual({
    resources: { cpu: 4, memoryGiB: 8, diskGiB: 0 },
    bound: "exact",
  });
  expect(pricedResources("modal", null, "large")?.resources).toMatchObject({
    cpu: 4,
    memoryGiB: 8,
  });
  expect(reservationResources("modal", null, sized)).toEqual({ cpu: 4, memoryGiB: 8, diskGiB: 0 });

  // Other providers keep pricing what the guest reports.
  expect(pricedResources("e2b", host, null)).toEqual({
    resources: resources(host),
    bound: "observed",
  });
});

it("admits every Modal iteration under the default dollar budget", async () => {
  const out = await directory();

  const report = await runV2(
    [{ kind: "ready", name: "modal", cloud: true, region: "us-east", provider: memory() }],
    parseV2([
      "--providers",
      "modal",
      "--runs",
      "3",
      "--scenarios",
      "command",
      "--bursts",
      "",
      "--timeout-ms",
      "180000",
      "--out",
      out,
    ]),
    async () => {},
  );

  expect(report.admissionStopped ?? []).toEqual([]);
  expect(report.budgets.modal?.stop ?? null).toBeNull();
  const lifetimes = report.samples.filter((s) => s.scenario === "sandbox-lifetime");
  expect(lifetimes).toHaveLength(3);

  for (const lifetime of lifetimes) expect(lifetime.estimatedCost).toEqual(expect.any(Number));
});

function recordingProvider(name: string, creates: CreateInput[]) {
  const backing = memory();
  let snapshotSource = "";

  const provider: Provider = {
    ...backing,
    name,
    capabilities: new Set(["snapshot", "size"]),
    create: async (input) => {
      creates.push(input);
      // The memory backing cannot enforce a size; this fake only records the request.
      const { size: _size, ...rest } = input;
      const info = await backing.create(rest);

      if (!input.from) snapshotSource = info.id;

      return info;
    },
    snapshot: async () => ({ id: "im-snapshot" }),
  };

  vi.spyOn(snapshots.snapshotMetadata, "inspect").mockImplementation(async () => ({
    exists: true,
    sourceId: snapshotSource,
  }));
  vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {});

  return provider;
}

it("restores a Modal snapshot at the source's requested size, and leaves other providers alone", async () => {
  for (const [name, expected] of [
    ["modal", { cpu: 4, memoryMb: 8192 }],
    ["e2b", undefined],
  ] as const) {
    const out = await directory();
    const creates: CreateInput[] = [];

    await runV2(
      [
        {
          kind: "ready",
          name,
          cloud: false,
          region: null,
          provider: recordingProvider(name, creates),
        },
      ],
      parseV2([
        "--providers",
        name,
        "--runs",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "snapshot",
        "--size",
        `${name}=4:8192`,
        "--timeout-ms",
        "5000",
        "--out",
        out,
      ]),
      async () => {},
    );

    const restore = creates.find((input) => input.from !== undefined);
    expect(restore, name).toBeDefined();
    expect(restore?.size, name).toEqual(expected);
    vi.restoreAllMocks();
  }
});

it("registers Modal snapshot cleanup and metadata through Modal's own client", async () => {
  class NotFoundError extends Error {}

  const images = new Set(["im-1"]);
  const closed: number[] = [];

  fakeNativeModules({
    modal: {
      NotFoundError,
      ModalClient: class {
        readonly images = {
          fromId: async (id: string) => {
            if (!images.has(id)) throw new NotFoundError(`Could not find image with ID ${id}`);

            return { imageId: id };
          },
          delete: async (id: string) => {
            images.delete(id);
          },
        };

        close() {
          closed.push(1);
        }
      },
    },
  });

  const provider = memory();
  expect(await snapshots.inspectSnapshot("modal", provider, "sb-1", "im-1")).toEqual({
    exists: true,
  });
  const clean = await snapshots.snapshotCleaner("modal", provider, "sb-1");
  await clean("im-1");
  expect(images.has("im-1")).toBe(false);
  expect(await snapshots.inspectSnapshot("modal", provider, "sb-1", "im-1")).toEqual({
    exists: false,
  });
  expect(closed.length).toBeGreaterThanOrEqual(3);
});

it("gives Modal sandboxes a hard lifetime covering a whole iteration, or the configured one", async () => {
  const defaults = parseV2(["--providers", "modal"]);
  // 180 s per scenario for 15 scenarios plus create, fingerprint, restore and destroy.
  expect(lifetimeOptions("modal", defaults)).toEqual({ timeoutMs: 180_000 * 19 });
  expect(lifetimeOptions("modal", parseV2(["--lifetime-ms", "modal=7200000"]))).toEqual({
    timeoutMs: 7_200_000,
  });
  expect(() => lifetimeOptions("modal", parseV2(["--lifetime-ms", "modal=90000000"]))).toThrow(
    /24 hours/,
  );
  expect(lifetimeOptions("e2b", defaults)).toEqual({});

  const factory = vi.fn((options: FactoryOptions) => ({ ...memory(), name: "modal", options }));

  const loaded = await loadProvider(
    "modal",
    { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
    async () => ({ modal: factory }),
    parseV2(["--providers", "modal", "--lifetime-ms", "modal=5400000"]),
  );

  expect(loaded.kind).toBe("ready");
  expect(factory).toHaveBeenCalledWith({ timeoutMs: 5_400_000, onDestroy: expect.any(Function) });
});

it("splits a Modal destroy row into the terminate request and the confirmed stop", async () => {
  const out = await directory();
  const backing = memory();
  let observe: (event: DestroyTiming) => void = () => {};

  const loaded = await loadProvider(
    "modal",
    { MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" },
    async () => ({
      modal: (options: { onDestroy: (event: DestroyTiming) => void }) => {
        observe = options.onDestroy;

        return {
          ...backing,
          name: "modal",
          destroy: async (id: string) => {
            await backing.destroy(id);
            observe({ sandboxId: id, requestMs: 120, stoppedMs: 2400 });
          },
        };
      },
    }),
    parseV2(["--providers", "modal"]),
  );

  if (loaded.kind !== "ready") throw new Error(loaded.note);

  const report = await runV2(
    [{ ...loaded, cloud: false }],
    parseV2([
      "--providers",
      "modal",
      "--runs",
      "1",
      "--scenarios",
      "command",
      "--bursts",
      "",
      "--out",
      out,
    ]),
    async () => {},
  );

  expect(report.samples.find((s) => s.scenario === "destroy")?.phases).toMatchObject({
    terminateRequestMs: 120,
    confirmedStopMs: 2400,
  });
});
