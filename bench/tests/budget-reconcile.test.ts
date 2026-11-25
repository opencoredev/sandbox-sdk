// PR 75 re-review (P2): the budget's final reconciliation priced a sandbox's life past its
// iteration's charge as a fresh lifetime, so it charged Vercel's one-minute minimum and creation
// fee twice. An offline Vercel fixture gone within a minute reported $0.0056812, not $0.0028406.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { ExecInput, ExecResult, Provider } from "@opencoredev/sandbox-sdk/provider";
import { budgetUSD, estimateCost } from "../src/pricing.js";
import * as snapshots from "../src/snapshots.js";
import { parseV2 } from "../src/v2-config.js";
import { writeV2 } from "../src/v2-report.js";
import { chargeBeyond, runV2, type Charge } from "../src/v2-runner.js";
import { boundFake } from "./native-fakes.js";

/** Vercel at 1 vCPU / 2 GiB: one billed minute plus the $0.60-per-million creation fee. */
const oneMinute = 0.1704 / 60 + 0.6 / 1_000_000;

/** What the iteration's charge prices a Vercel lifetime at, as the runner builds it. */
const vercelPrice = (ms: number) => {
  const usd = estimateCost("vercel", ms, { cpu: 1, memoryGiB: 2, diskGiB: 0 }, null);

  return usd === null ? null : budgetUSD("vercel", usd);
};

const charged = (since: number, chargedUntil: number): Charge => ({
  since,
  chargedUntil,
  price: vercelPrice,
});

describe("chargeBeyond prices the whole observed life, less what was charged", () => {
  it("adds nothing for a sandbox gone within the minute its iteration already paid for", () => {
    expect(oneMinute).toBeCloseTo(0.0028406, 10);
    expect(vercelPrice(2_000)).toBeCloseTo(oneMinute, 12);
    // Before the fix the 43 s tail was priced as a second lifetime: another minute and fee.
    expect(chargeBeyond(charged(0, 2_000), 45_000)).toBe(0);
  });

  it("adds only the marginal minute for a life past the minimum, with no second creation fee", () => {
    const delta = chargeBeyond(charged(1_000, 3_000), 91_000);

    expect(delta).toBeCloseTo(0.1704 / 60, 12);
    expect((vercelPrice(2_000) ?? 0) + (delta ?? 0)).toBeCloseTo(vercelPrice(90_000) ?? 0, 12);
  });

  it("prices a sandbox no iteration claimed from its start, minimum and fee included", () => {
    expect(chargeBeyond(charged(5_000, 5_000), 15_000)).toBeCloseTo(oneMinute, 12);
  });

  it("never goes negative and adds nothing before the charged span ends", () => {
    const shrinking: Charge = {
      since: 0,
      chargedUntil: 2_000,
      price: (ms) => (ms > 2_000 ? 1 : 5),
    };

    expect(chargeBeyond(shrinking, 10_000)).toBe(0);
    expect(chargeBeyond(charged(0, 2_000), 1_500)).toBe(0);
    expect(chargeBeyond(charged(0, Infinity), 1_000_000)).toBe(0);
  });

  it("is null when the observed life cannot be priced", () => {
    expect(chargeBeyond({ since: 0, chargedUntil: 1_000, price: () => null }, 5_000)).toBeNull();
  });

  it("subtracts explicit chargedUSD when provided and clamps at zero", () => {
    // Restore booked for 45 s ($0.0028406), observed gone at 65 s ($0.0056806): adds one minute.
    expect(
      chargeBeyond(
        { since: 65_000, chargedUntil: 110_000, chargedUSD: oneMinute, price: vercelPrice },
        130_000,
      ),
    ).toBeCloseTo(0.1704 / 60, 12);

    // Unbooked sandbox (chargedUSD: 0) that outlives its iteration pays its full observed life.
    expect(
      chargeBeyond({ since: 0, chargedUntil: 10_000, chargedUSD: 0, price: vercelPrice }, 65_000),
    ).toBeCloseTo(vercelPrice(65_000) ?? 0, 12);

    // Already over-booked sandbox clamps at zero.
    expect(
      chargeBeyond({ since: 0, chargedUntil: 10_000, chargedUSD: 1, price: vercelPrice }, 65_000),
    ).toBe(0);
  });
});

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bootId = "4f9c1d1e-8b2a-4c1e-9d3f-0a1b2c3d4e5f";

/** The guest a Vercel 1 vCPU / 2 GiB sandbox reports. */
const fingerprint = {
  cpuModel: "test",
  flags: [],
  nproc: 1,
  cpuMax: "max",
  quotaCpus: null,
  memoryMax: "max",
  memTotalBytes: 2 * 1024 ** 3,
  memoryBytes: 2 * 1024 ** 3,
  diskBytes: 0,
  df: "",
  lsblk: "",
  virtualization: "kvm",
  hypervisor: true,
  dmi: "",
  kernel: "test",
  distro: "test",
  user: "root",
  uid: 0,
  sudo: true,
  stealPercent: null,
  egress: null,
  tools: {},
  runtime: "test",
};

describe("runV2 charges a Vercel sandbox gone within a minute once", () => {
  it("reports $0.0028406, not $0.0056812, when the delete takes effect after the iteration", async () => {
    const backing = memory();

    backing.register("cat", async ({ stdout }) => {
      stdout(`${bootId}\n`);

      return 0;
    });

    const destroy = backing.destroy.bind(backing);
    let settle: Promise<void> | undefined;

    const vercel = {
      ...backing,
      exec: async (id: string, input: ExecInput): Promise<ExecResult> => {
        if (!input.command.includes("BENCH_FINGERPRINT")) return backing.exec(id, input);
        input.onChunk({ stream: "stdout", text: JSON.stringify(fingerprint) });

        return { exitCode: 0, timedOut: false };
      },
      // Acknowledged at once; the sandbox is gone 1.5 s later, well inside its first minute.
      destroy: async (id: string) => {
        settle ??= sleep(1_500).then(() => destroy(id));
      },
    };

    const out = await mkdtemp(join(tmpdir(), "bench-budget-reconcile-"));
    dirs.push(out);

    try {
      const report = await runV2(
        [
          {
            kind: "ready",
            name: "vercel",
            region: null,
            cloud: false,
            provider: boundFake(vercel),
          },
        ],
        parseV2([
          "--providers",
          "vercel",
          "--run",
          "budget-reconcile",
          "--out",
          out,
          "--scenarios",
          "survival",
          "--bursts",
          "1",
          "--burst-cohorts",
          "1",
          "--timeout-ms",
          "3500",
          "--survival-window-ms",
          "1000",
          "--survival-heartbeat-ms",
          "1000",
        ]),
        (r) => writeV2(r, out),
      );

      await settle;
      const budget = report.budgets.vercel;

      expect(budget?.openLiabilities).toBeUndefined();
      expect(budget?.estimatedUSD).toBeCloseTo(0.0028406, 10);
    } finally {
      await settle;

      for (const s of await backing.list({})) await destroy(s.id);
    }
  }, 30_000);

  it("tracks a restored sandbox on its own clock and basis when it outlives its booked minute", async () => {
    const backing = memory();
    const destroy = backing.destroy.bind(backing);
    const realNow = performance.now.bind(performance);
    let offset = 0;

    let sourceId = "";
    let restoredId = "";
    let snapshotDeleted = false;
    let sourceDestroyed = false;
    let restoreCleared = false;

    vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
    vi.spyOn(snapshots.snapshotMetadata, "inspect").mockImplementation(async () => ({
      exists: !snapshotDeleted,
      sourceId,
    }));
    vi.spyOn(snapshots, "snapshotsFromSource").mockImplementation(async () =>
      snapshotDeleted ? [] : [{ id: "snap-1" }],
    );
    vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {
      snapshotDeleted = true;
    });

    const vercel: Provider = {
      ...backing,
      capabilities: new Set(["snapshot"]),
      create: async (input) => {
        const info = await backing.create(input);

        if (input.from) restoredId = info.id;
        else sourceId = info.id;

        return info;
      },
      exec: async (id: string, input: ExecInput): Promise<ExecResult> => {
        if (!input.command.includes("BENCH_FINGERPRINT")) return backing.exec(id, input);

        // Restore runs 45 s (1st billed minute: $0.0028406) from t=10 s to t=55 s.
        if (id === restoredId) offset += 45_000;
        input.onChunk({ stream: "stdout", text: JSON.stringify(fingerprint) });

        return { exitCode: 0, timedOut: false };
      },
      snapshot: async () => {
        offset += 10_000;

        return { id: "snap-1" };
      },
      // Source ends at t=65 s (2nd billed minute: $0.0056806); restore lingers past its 45 s
      // booking and disappears at t=75 s (65 s after restoreStart, crossing into its 2nd minute).
      destroy: async (id) => {
        if (id === sourceId) {
          offset += 10_000;
          await destroy(id);
          sourceDestroyed = true;
        }
      },
      list: async (labels) => {
        if (sourceDestroyed && restoredId && !restoreCleared) {
          restoreCleared = true;
          offset += 10_000;
          await destroy(restoredId);
        }

        return backing.list(labels);
      },
    };

    const out = await mkdtemp(join(tmpdir(), "bench-budget-restore-"));
    dirs.push(out);

    try {
      const report = await runV2(
        [
          {
            kind: "ready",
            name: "vercel",
            region: null,
            cloud: false,
            provider: boundFake(vercel),
          },
        ],
        parseV2([
          "--providers",
          "vercel",
          "--run",
          "budget-restore-reconcile",
          "--out",
          out,
          "--runs",
          "1",
          "--bursts",
          "",
          "--scenarios",
          "snapshot",
          "--timeout-ms",
          "5000",
        ]),
        (r) => writeV2(r, out),
      );

      const budget = report.budgets.vercel;

      expect(budget?.openLiabilities).toBeUndefined();
      // Source: 2 min + fee ($0.0056806). Restore: booked 45 s ($0.0028406), gone at 65 s (+$0.00284).
      // Total: $0.0113612 (before the fix, restore shared source's charge and stayed at $0.0085212).
      expect(budget?.estimatedUSD).toBeCloseTo(0.0113612, 10);
    } finally {
      for (const s of await backing.list({})) await destroy(s.id);
    }
  }, 30_000);

  it("bills a late-settling restore that misses its deadline using its captured charge", async () => {
    const backing = memory();
    const destroy = backing.destroy.bind(backing);
    const realNow = performance.now.bind(performance);
    let offset = 0;

    let sourceId = "";
    let restoredId = "";
    let snapshotDeleted = false;
    let restoreSettled = false;

    vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
    vi.spyOn(snapshots.snapshotMetadata, "inspect").mockImplementation(async () => ({
      exists: !snapshotDeleted,
      sourceId,
    }));
    vi.spyOn(snapshots, "snapshotsFromSource").mockImplementation(async () =>
      snapshotDeleted ? [] : [{ id: "snap-late" }],
    );
    vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {
      snapshotDeleted = true;
    });

    const vercel: Provider = {
      ...backing,
      capabilities: new Set(["snapshot"]),
      create: async (input) => {
        if (input.from) {
          // Stall past the 250 ms step deadline + 250 ms drain so create-from-snapshot's finally
          // exits (leaving restoreCharges empty and clearing currentRestoreCharge) before this
          // create settles and verifies ownership.
          await sleep(700);
          offset += 65_000;
          const info = await backing.create(input);
          restoredId = info.id;
          restoreSettled = true;

          return info;
        }

        const info = await backing.create(input);
        sourceId = info.id;

        return info;
      },
      exec: async (id: string, input: ExecInput): Promise<ExecResult> => {
        if (!input.command.includes("BENCH_FINGERPRINT")) return backing.exec(id, input);
        input.onChunk({ stream: "stdout", text: JSON.stringify(fingerprint) });

        return { exitCode: 0, timedOut: false };
      },
      snapshot: async () => {
        offset += 10_000;

        return { id: "snap-late" };
      },
      destroy: async (id) => {
        await destroy(id);
      },
    };

    const out = await mkdtemp(join(tmpdir(), "bench-budget-late-restore-"));
    dirs.push(out);

    try {
      const report = await runV2(
        [
          {
            kind: "ready",
            name: "vercel",
            region: null,
            cloud: false,
            provider: boundFake(vercel),
          },
        ],
        parseV2([
          "--providers",
          "vercel",
          "--run",
          "budget-late-restore",
          "--out",
          out,
          "--runs",
          "1",
          "--bursts",
          "",
          "--scenarios",
          "snapshot",
          "--timeout-ms",
          "250",
        ]),
        (r) => writeV2(r, out),
      );

      expect(restoreSettled).toBe(true);
      expect(restoredId).not.toBe("");

      const budget = report.budgets.vercel;

      expect(budget?.openLiabilities).toBeUndefined();
      // Source lived 75 s (2 min + fee = $0.0056806) and late restore lived 65 s (2 min + fee =
      // $0.0056806) with $0 booked in the iteration -> total $0.0113612. Before the fix, the late
      // restore hit chargedUntil: Infinity (or inherited sourceCharge) and stayed at $0.0056806.
      expect(budget?.estimatedUSD).toBeCloseTo(0.0113612, 10);
    } finally {
      for (const s of await backing.list({})) await destroy(s.id);
    }
  }, 30_000);
});
