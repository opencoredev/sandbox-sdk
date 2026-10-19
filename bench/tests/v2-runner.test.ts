import { it, expect, vi } from "vitest";
import { parseV2 } from "../src/v2-config.js";

it("runs the actual v2 memory consumer, stops at its creation budget, and preserves unrelated resources", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2, summarize } = await import("../src/v2-runner.js");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve("results-test-"));
  const provider = memory();
  const { createSandbox } = await import("@opencoredev/sandbox-sdk");
  const unrelated = await createSandbox(provider, {
    labels: { "sandbox-bench-run": "unrelated-run" },
  });
  try {
    const report = await runV2(
      [{ kind: "ready", name: "memory", cloud: false, region: null, provider }],
      parseV2([
        "--providers",
        "memory",
        "--runs",
        "2",
        "--max-sandboxes",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "command",
        "--out",
        directory,
      ]),
      async () => {},
    );
    expect(report.samples.filter((s) => s.scenario === "cold")).toHaveLength(1);
    const cold = report.samples.find((s) => s.scenario === "cold");
    if (!cold) throw new Error("Expected a real cold sample");
    const score = {
      ...cold,
      provider: "boat",
      scenario: "cpu-single",
      unit: "iterations/s",
      outcome: { kind: "sample", value: 1000 } satisfies import("../src/v2-model.js").Outcome,
      estimatedCost: 0.1,
    };
    expect(summarize([score], 45)[0]?.performancePerDollar).toBeCloseTo(100000000);
    expect(summarize([{ ...score, estimatedCost: 10 }], 45)[0]?.performancePerDollar).toBeCloseTo(
      100000000,
    );
    const { projectCosts } = await import("../src/projection.js");
    const projection = projectCosts({ ...report,
      providers: [{ name: "boat", kind: "ready", note: "test" }],
      samples: ["cold", "fingerprint", "perf", "command", "files-1kb", "files-10mb", "reconnect", "pause-resume", "snapshot", "create-from-snapshot", "snapshot-cleanup", "restore-fingerprint", "restore-destroy", "destroy"].map((scenario) => ({ ...score, scenario, durationMs: scenario === "restore-fingerprint" ? 10000 : 1000 })),
    });
    expect(projection[0]?.normal100).toBeCloseTo(0.035);
    expect(report.samples.find((s) => s.scenario === "command")?.outcome.kind).toBe("sample");
    expect(report.budgets.memory?.stop).toBe("Sandbox budget reached");
    expect((await readFile(resolve(directory, "samples.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))).toEqual(report.samples);
    expect(report.cleanup).toEqual([{ provider: "memory", remaining: [], error: null }]);
    expect((await provider.list({})).map((s) => s.id)).toEqual([unrelated.id]);
  } finally {
    await unrelated.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});


it("retries journal-owned VMs even when listings omit them", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve("results-test-"));
  const backing = memory();
  let attempts = 0;
  const provider = {
    ...backing,
    list: async () => [],
    destroy: async (id: string) => {
      if (++attempts <= 3) throw new Error("transient destruction failure");
      await backing.destroy(id);
    },
  } satisfies import("@opencoredev/sandbox-sdk/provider").Provider;
  try {
    const report = await runV2(
      [{ kind: "ready", name: "memory", cloud: false, region: null, provider }],
      parseV2(["--providers", "memory", "--runs", "1", "--bursts", "", "--scenarios", "command", "--out", directory]),
      async () => {},
    );
    expect(attempts).toBe(4);
    expect(await backing.list({})).toHaveLength(0);
    expect(report.cleanup).toEqual([{ provider: "memory", remaining: [], error: null }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("continues VM deletion when snapshot cleanup fails", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve("results-test-"));
  const backing = memory();
  const failures = new Map<string, number>();
  const provider = {
    ...backing,
    capabilities: new Set<import("@opencoredev/sandbox-sdk/provider").Capability>(["snapshot", "size"]),
    create: ({ size: _size, ...input }: import("@opencoredev/sandbox-sdk/provider").CreateInput) => { void _size; return backing.create(input); },
    snapshot: async () => ({ id: "owned-snapshot" }),
    native: () => ({ client: { call: async () => { throw new Error("snapshot deletion unavailable"); } } }),
    destroy: async (id: string) => {
      const n = (failures.get(id) ?? 0) + 1;
      failures.set(id, n);
      if (n <= 3) throw new Error("transient destruction failure");
      await backing.destroy(id);
    },
  } satisfies import("@opencoredev/sandbox-sdk/provider").Provider;
  try {
    const report = await runV2(
      [{ kind: "ready", name: "local", cloud: false, region: null, provider }],
      parseV2(["--providers", "local", "--runs", "1", "--bursts", "", "--scenarios", "snapshot", "--out", directory]),
      async () => {},
    );
    expect(await backing.list({})).toHaveLength(0);
    const cold = report.samples.find((s) => s.scenario === "cold");
    if (cold?.outcome.kind === "failure") throw new Error(cold.outcome.note);
    const restored = report.samples.find((s) => s.scenario === "create-from-snapshot");
    expect(restored?.sandboxId).not.toBe(cold?.sandboxId);
    expect(report.samples.find((s) => s.scenario === "restore-fingerprint")?.sandboxId).toBe(restored?.sandboxId);
    expect(report.cleanup[0]?.remaining).toEqual(["owned-snapshot"]);
    expect(report.cleanup[0]?.error).toContain("snapshot deletion unavailable");
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it("reaps snapshots that materialize after an earlier delete returns", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const snapshots = await import("../src/snapshots.js");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve("results-test-"));
  const backing = memory();
  const deleted: string[] = [];
  let queries = 0;
  vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async (id) => { deleted.push(id); });
  vi.spyOn(snapshots, "createNamedDaytonaSnapshot").mockRejectedValue(new Error("native timeout"));
  vi.spyOn(snapshots, "snapshotsFromDaytonaSandbox").mockImplementation(async () => {
    expect(await backing.list({})).toHaveLength(0);
    return ++queries === 1 ? [{ id: "late-snapshot", name: "late-snapshot" }] : [];
  });
  const provider = { ...backing,
    capabilities: new Set<import("@opencoredev/sandbox-sdk/provider").Capability>(["snapshot"]),
    snapshot: async () => ({ id: "unused" }),
  } satisfies import("@opencoredev/sandbox-sdk/provider").Provider;
  try {
    const report = await runV2(
      [{ kind: "ready", name: "daytona", cloud: false, region: null, provider }],
      parseV2(["--providers", "daytona", "--runs", "1", "--bursts", "", "--scenarios", "snapshot", "--out", directory]),
      async () => {},
    );
    expect(deleted).toContain("late-snapshot");
    expect(queries).toBe(2);
    expect(report.cleanup).toEqual([{ provider: "daytona", remaining: [], error: null }]);
    expect(JSON.parse(await readFile(resolve(directory, "ownership.json"), "utf8")).resources).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

it("waits for a run-owned Daytona deletion to disappear before snapshot recovery", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const snapshots = await import("../src/snapshots.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve("results-test-"));
  const backing = memory();
  let stale: Awaited<ReturnType<typeof backing.list>> = [];
  let afterDeleteLists = 0;
  vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {});
  vi.spyOn(snapshots, "createNamedDaytonaSnapshot").mockRejectedValue(new Error("native timeout"));
  const query = vi.spyOn(snapshots, "snapshotsFromDaytonaSandbox").mockResolvedValue([]);
  const provider = { ...backing,
    capabilities: new Set<import("@opencoredev/sandbox-sdk/provider").Capability>(["snapshot"]),
    snapshot: async () => ({ id: "unused" }),
    destroy: async (id: string) => { const live = await backing.list({}); if (live.length) stale = live; await backing.destroy(id); },
    list: async (labels: import("@opencoredev/sandbox-sdk/provider").Labels) => {
      const live = await backing.list(labels);
      return stale.length && ++afterDeleteLists <= 2 ? stale : live;
    },
  } satisfies import("@opencoredev/sandbox-sdk/provider").Provider;
  try {
    const report = await runV2(
      [{ kind: "ready", name: "daytona", cloud: false, region: null, provider }],
      parseV2(["--providers", "daytona", "--runs", "1", "--bursts", "", "--scenarios", "snapshot", "--out", directory]),
      async () => {},
    );
    expect(report.cleanup).toEqual([{ provider: "daytona", remaining: [], error: null }]);
    expect(query).toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); }
});
