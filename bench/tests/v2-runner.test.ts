import { tmpdir } from "node:os";
import { it, expect, vi } from "vitest";
import { parseV2 } from "../src/v2-config.js";
import { boundFake } from "./native-fakes.js";

it("runs the actual v2 memory consumer, stops at its creation budget, and preserves unrelated resources", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2, summarize } = await import("../src/v2-runner.js");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve(tmpdir(), "sandbox-bench-test-"));
  expect(directory.startsWith(resolve(tmpdir()) + "/")).toBe(true);
  const provider = memory();
  const { createSandbox } = await import("@opencoredev/sandbox-sdk");

  const unrelated = await createSandbox(provider, {
    labels: { "sandbox-bench-run": "unrelated-run" },
  });

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

    // Distinct native products never share a distribution.
    const products = summarize(
      [
        { ...score, product: null },
        { ...score, product: "ephemeral", outcome: { kind: "sample", value: 10 } },
      ],
      45,
    );

    expect(products.map((row) => [row.product, row.stats.p50])).toEqual([
      [null, 1000],
      ["ephemeral", 10],
    ]);
    const { projectCosts } = await import("../src/projection.js");

    const projection = projectCosts({
      ...report,
      providers: [{ name: "boat", kind: "ready", note: "test", configuredRegion: null }],
      samples: [
        "cold",
        "fingerprint",
        "perf",
        "command",
        "files-1kb",
        "files-10mb",
        "reconnect",
        "pause-resume",
        "snapshot",
        "create-from-snapshot",
        "snapshot-cleanup",
        "restore-fingerprint",
        "restore-destroy",
        "destroy",
      ].map((scenario) => ({
        ...score,
        scenario,
        durationMs: scenario === "restore-fingerprint" ? 10000 : 1000,
      })),
    });

    expect(projection[0]?.normal100).toBeCloseTo(0.035);
    expect(report.samples.find((s) => s.scenario === "command")?.outcome.kind).toBe("sample");
    expect(report.budgets.memory?.stop).toBe("Sandbox budget reached");
    expect(
      (await readFile(resolve(directory, "samples.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(report.samples);
    expect(report.cleanup).toEqual([{ provider: "memory", remaining: [], error: null }]);
    expect((await provider.list({})).map((s) => s.id)).toEqual([unrelated.id]);
  } finally {
    await unrelated.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not delete returned IDs when live ownership cannot be verified", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve(tmpdir(), "sandbox-bench-test-"));
  expect(directory.startsWith(resolve(tmpdir()) + "/")).toBe(true);
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
        "--bursts",
        "",
        "--scenarios",
        "command",
        "--timeout-ms",
        "100",
        "--out",
        directory,
      ]),
      async () => {},
    );

    expect(attempts).toBe(0);
    expect(await backing.list({})).toHaveLength(1);
    expect(report.cleanupReview).toHaveLength(1);
    expect(report.cleanup).toEqual([
      { provider: "memory", remaining: [], error: expect.stringContaining("ownership unverified") },
    ]);
  } finally {
    for (const info of await backing.list({})) await backing.destroy(info.id);
    await rm(directory, { recursive: true, force: true });
  }
});

it("retains the source until snapshot cleanup can complete", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve(tmpdir(), "sandbox-bench-test-"));
  expect(directory.startsWith(resolve(tmpdir()) + "/")).toBe(true);
  const backing = memory();
  const snapshots = await import("../src/snapshots.js");
  vi.spyOn(snapshots.snapshotMetadata, "inspect").mockResolvedValue({ exists: true });
  const failures = new Map<string, number>();

  const provider = {
    ...backing,
    capabilities: new Set<import("@opencoredev/sandbox-sdk/provider").Capability>([
      "snapshot",
      "size",
    ]),
    create: ({
      size: _size,
      ...input
    }: import("@opencoredev/sandbox-sdk/provider").CreateInput) => {
      void _size;

      return backing.create(input);
    },
    snapshot: async () => ({ id: "owned-snapshot" }),
    native: () => ({
      client: {
        call: async () => {
          throw new Error("snapshot deletion unavailable");
        },
      },
    }),
    destroy: async (id: string) => {
      const n = (failures.get(id) ?? 0) + 1;
      failures.set(id, n);

      if (n <= 3) throw new Error("transient destruction failure");
      await backing.destroy(id);
    },
  } satisfies import("@opencoredev/sandbox-sdk/provider").Provider;

  try {
    const report = await runV2(
      [{ kind: "ready", name: "local", cloud: false, region: null, provider: boundFake(provider) }],
      parseV2([
        "--providers",
        "local",
        "--runs",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "snapshot",
        "--timeout-ms",
        "100",
        "--out",
        directory,
      ]),
      async () => {},
    );

    expect(await backing.list({})).toHaveLength(1);
    const cold = report.samples.find((s) => s.scenario === "cold");

    if (cold?.outcome.kind === "failure") throw new Error(cold.outcome.note);
    const restored = report.samples.find((s) => s.scenario === "create-from-snapshot");
    expect(restored?.sandboxId).not.toBe(cold?.sandboxId);
    expect(report.samples.find((s) => s.scenario === "restore-fingerprint")?.sandboxId).toBe(
      restored?.sandboxId,
    );
    expect(report.cleanup[0]?.remaining).toEqual(
      expect.arrayContaining(["owned-snapshot", cold?.sandboxId]),
    );
    expect(report.cleanup[0]?.error).toContain("snapshot deletion unavailable");
  } finally {
    vi.restoreAllMocks();

    for (const info of await backing.list({})) await backing.destroy(info.id);
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["daytona", "superserve"])(
  "reaps late %s snapshots after a timed-out creation",
  async (name) => {
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const { runV2 } = await import("../src/v2-runner.js");
    const snapshots = await import("../src/snapshots.js");
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const directory = await mkdtemp(resolve(tmpdir(), "sandbox-bench-test-"));
    expect(directory.startsWith(resolve(tmpdir()) + "/")).toBe(true);
    const backing = memory();
    vi.spyOn(snapshots.snapshotMetadata, "inspect").mockImplementation(
      async (_name, _provider, _source, id) => ({ exists: id === "late-snapshot" }),
    );
    const deleted: string[] = [];
    let queries = 0;
    vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async (id) => {
      deleted.push(id);
    });

    const snapshotFailure = async () => {
      const journal = JSON.parse(await readFile(resolve(directory, "ownership.json"), "utf8"));
      const source = journal.resources.find((r: { kind: string }) => r.kind === "snapshot-source");
      expect(source.snapshotProof).toEqual({
        sourceId: source.id,
        runLabel: journal.runId,
        sdkLabel: "1",
        verifiedAt: expect.any(String),
      });
      throw new Error("native timeout");
    };

    vi.spyOn(snapshots, "createNamedDaytonaSnapshot").mockImplementation(snapshotFailure);
    vi.spyOn(snapshots, "snapshotsFromSource").mockImplementation(async () => {
      expect(await backing.list({})).toHaveLength(1);

      return ++queries <= 2 ? [{ id: "late-snapshot", name: "late-snapshot" }] : [];
    });

    const provider = {
      ...backing,
      capabilities: new Set<import("@opencoredev/sandbox-sdk/provider").Capability>(["snapshot"]),
      snapshot: snapshotFailure,
    } satisfies import("@opencoredev/sandbox-sdk/provider").Provider;

    try {
      const report = await runV2(
        [{ kind: "ready", name, cloud: false, region: null, provider: boundFake(provider) }],
        parseV2([
          "--providers",
          name,
          "--runs",
          "1",
          "--bursts",
          "",
          "--scenarios",
          "snapshot",
          "--out",
          directory,
        ]),
        async () => {},
      );

      expect(deleted).toContain("late-snapshot");
      expect(queries).toBe(3);
      expect(report.cleanup).toEqual([{ provider: name, remaining: [], error: null }]);
      expect(
        JSON.parse(await readFile(resolve(directory, "ownership.json"), "utf8")).resources,
      ).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("recovers a named snapshot using recorded source proof despite stale sandbox listings", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const snapshots = await import("../src/snapshots.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve(tmpdir(), "sandbox-bench-test-"));
  expect(directory.startsWith(resolve(tmpdir()) + "/")).toBe(true);
  const backing = memory();
  vi.spyOn(snapshots.snapshotMetadata, "inspect").mockResolvedValue({ exists: false });
  let stale: Awaited<ReturnType<typeof backing.list>> = [];
  let afterDeleteLists = 0;
  vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {});
  vi.spyOn(snapshots, "createNamedDaytonaSnapshot").mockRejectedValue(new Error("native timeout"));
  const query = vi.spyOn(snapshots, "snapshotsFromSource").mockResolvedValue([]);

  const provider = {
    ...backing,
    capabilities: new Set<import("@opencoredev/sandbox-sdk/provider").Capability>(["snapshot"]),
    snapshot: async () => ({ id: "unused" }),
    destroy: async (id: string) => {
      const live = await backing.list({});

      if (live.length) stale = live;
      await backing.destroy(id);
    },
    list: async (labels: import("@opencoredev/sandbox-sdk/provider").Labels) => {
      const live = await backing.list(labels);

      return stale.length && ++afterDeleteLists <= 2 ? stale : live;
    },
  } satisfies import("@opencoredev/sandbox-sdk/provider").Provider;

  try {
    const report = await runV2(
      [
        {
          kind: "ready",
          name: "daytona",
          cloud: false,
          region: null,
          provider: boundFake(provider),
        },
      ],
      parseV2([
        "--providers",
        "daytona",
        "--runs",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "snapshot",
        "--out",
        directory,
      ]),
      async () => {},
    );

    expect(report.cleanup).toEqual([{ provider: "daytona", remaining: [], error: null }]);
    expect(query).toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["returned-id", "native-failure", "first-command", "burst", "cleanup-drain"] as const)(
  "retains late create evidence: %s",
  async (mode) => {
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const { runV2 } = await import("../src/v2-runner.js");
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "bench-late-"));
    const backing = memory();

    const afterAbort = (signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => setTimeout(resolve, 5), { once: true });
      });

    const nativeFailure = () =>
      new Error("native request failed", {
        cause: { httpStatus: 503, requestId: "native-request", body: "SECRET" },
      });

    const provider = {
      ...backing,
      create: async (input: import("@opencoredev/sandbox-sdk/provider").CreateInput) => {
        if (mode !== "first-command") await afterAbort(input.signal);

        if (mode === "cleanup-drain") await new Promise((resolve) => setTimeout(resolve, 1500));

        if (mode === "native-failure") throw nativeFailure();

        return backing.create({ ...input, signal: undefined });
      },
      exec: async (id: string, input: import("@opencoredev/sandbox-sdk/provider").ExecInput) => {
        if (mode === "first-command" && input.command === "true") {
          await afterAbort(input.signal);
          throw nativeFailure();
        }

        return backing.exec(id, input);
      },
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
          "--scenarios",
          mode === "burst" ? "burst" : "command",
          "--bursts",
          mode === "burst" ? "1" : "",
          "--burst-cohorts",
          "1",
          "--timeout-ms",
          "1000",
          "--out",
          directory,
        ]),
        async () => {},
      );

      const cold = report.samples.find((s) => s.scenario.endsWith("cold"));
      expect(cold?.outcome).toMatchObject({
        kind: "failure",
        clockPhase: mode === "first-command" ? "first-command" : "adapter-create",
        lateSettlement: { settled: true },
      });

      if (mode === "returned-id" || mode === "burst" || mode === "cleanup-drain")
        expect(cold?.sandboxId).toBeTruthy();
      else
        expect(cold?.outcome).toMatchObject({
          cause: { httpStatus: 503, requestId: "native-request" },
        });
      expect(JSON.stringify(cold)).not.toContain("SECRET");
      expect(await backing.list({})).toEqual([]);
      expect(
        JSON.parse(await readFile(join(directory, "ownership.json"), "utf8")).resources,
      ).toEqual([]);

      const persisted = (await readFile(join(directory, "samples.ndjson"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      expect(persisted.find((s) => s.scenario.endsWith("cold"))).toEqual(cold);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["default", "same-spec"])(
  "runs ten isolated sequential cost tasks on %s without fingerprints or bursts",
  async (track) => {
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const { runV2 } = await import("../src/v2-runner.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "bench-cost-"));
    const backing = memory();
    backing.register("grep", async ({ args, files, stdout }) => {
      const contents = new TextDecoder().decode(await files.read(args[1] ?? ""));

      if (!contents.includes(args[0] ?? "")) return 1;
      stdout(contents);

      return 0;
    });
    backing.register("node", async ({ cwd, files }) => {
      await files.read(`${cwd}/test.mjs`);

      return 0;
    });

    let live = 0,
      peak = 0;

    const commands: string[] = [];

    const provider = {
      ...backing,
      create: async (input: import("@opencoredev/sandbox-sdk/provider").CreateInput) => {
        peak = Math.max(peak, ++live);

        return backing.create(input);
      },
      destroy: async (id: string) => {
        await backing.destroy(id);
        live--;
      },
      exec: async (id: string, input: import("@opencoredev/sandbox-sdk/provider").ExecInput) => {
        commands.push(input.command);

        return backing.exec(id, input);
      },
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
          "--track",
          track,
          "--scenarios",
          "cost",
          "--provider-concurrency",
          "4",
          "--out",
          directory,
        ]),
        async () => {},
      );

      expect(peak).toBe(1);
      expect(live).toBe(0);
      expect(new Set(report.samples.map((s) => s.scenario))).toEqual(
        new Set(["cold", "tool-replay-prepare", "tool-replay", "destroy", "sandbox-lifetime"]),
      );
      const replays = report.samples.filter((s) => s.scenario === "tool-replay");
      expect(replays).toHaveLength(10);

      for (const row of replays) {
        expect(row.outcome.kind, JSON.stringify(row.outcome)).toBe("sample");
        expect(row.details).toHaveLength(100);
      }

      expect(
        commands.some((c) => c.includes("BENCH_FINGERPRINT") || c.includes("BENCH_PERF")),
      ).toBe(false);
      expect(report.admissionStopped).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "journals and cleans a late rejected admitted ID after live ownership verification (cleanup retry=%s)",
  async (retry) => {
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const { SandboxError } = await import("@opencoredev/sandbox-sdk");
    const { runV2 } = await import("../src/v2-runner.js");
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "bench-late-reject-"));
    const backing = memory();

    let nativeId = "",
      destroyCalls = 0;

    const provider = {
      ...backing,
      list: backing.list,
      create: async (input: import("@opencoredev/sandbox-sdk/provider").CreateInput) => {
        const info = await backing.create({ ...input, signal: undefined });
        nativeId = info.id;
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve();
          else
            input.signal?.addEventListener("abort", () => setTimeout(resolve, 5), { once: true });
        });
        throw new SandboxError("safe late rejection", {
          provider: "tenki",
          code: "provider",
          sandboxId: info.id,
          cause: new Error(
            JSON.stringify({
              sandboxId: info.id,
              admittedByThisCall: true,
              state: "CREATING",
              stage: "waitReady",
              operation: "create",
              requestId: "native-request",
              providerCode: 14,
              cleanupCode: "unavailable",
              body: "SECRET",
            }),
          ),
        });
      },
      destroy: async (id: string) => {
        destroyCalls++;
        const journal = JSON.parse(await readFile(join(directory, "ownership.json"), "utf8"));
        expect(journal.resources).toContainEqual(
          expect.objectContaining({ id, provider: "tenki" }),
        );

        if (retry && destroyCalls <= 3) throw new Error("cleanup transient fault");
        await backing.destroy(id);
      },
    };

    try {
      const report = await runV2(
        [
          {
            kind: "ready",
            name: "tenki",
            cloud: false,
            region: null,
            provider: boundFake(provider),
          },
        ],
        parseV2([
          "--providers",
          "tenki",
          "--runs",
          "1",
          "--scenarios",
          "command",
          "--bursts",
          "",
          "--timeout-ms",
          "1000",
          "--out",
          directory,
        ]),
        async () => {},
      );

      const cold = report.samples.find((s) => s.scenario === "cold");
      expect(cold).toMatchObject({
        sandboxId: nativeId,
        outcome: {
          kind: "failure",
          clockPhase: "adapter-create",
          cause: {
            sandboxId: nativeId,
            nativeState: "CREATING",
            stage: "waitReady",
            providerCode: "14",
            cleanupCode: "unavailable",
            requestId: "native-request",
          },
          lateSettlement: {
            sandboxId: nativeId,
            stage: "waitReady",
            settled: true,
            cleanupOutcome: "succeeded",
          },
        },
      });
      expect(JSON.stringify(cold)).not.toContain("SECRET");
      expect(await backing.list({})).toEqual([]);
      expect(
        JSON.parse(await readFile(join(directory, "ownership.json"), "utf8")).resources,
      ).toEqual([]);
      expect(report.cleanup).toEqual([{ provider: "tenki", remaining: [], error: null }]);
      expect(destroyCalls).toBe(retry ? 4 : 1);

      const ndjson = (await readFile(join(directory, "samples.ndjson"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      expect(ndjson.find((s) => s.scenario === "cold")).toEqual(cold);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("skips Beam's snapshot scenario, whose snapshots cannot be deleted, before taking one", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve(tmpdir(), "sandbox-bench-test-"));
  expect(directory.startsWith(resolve(tmpdir()) + "/")).toBe(true);
  const backing = memory();
  const taken: string[] = [];

  const provider = {
    ...backing,
    capabilities: new Set<import("@opencoredev/sandbox-sdk/provider").Capability>(["snapshot"]),
    snapshot: async (id: string) => {
      taken.push(id);

      return { id: "never-deletable" };
    },
  } satisfies import("@opencoredev/sandbox-sdk/provider").Provider;

  try {
    const report = await runV2(
      [{ kind: "ready", name: "beam", cloud: false, region: null, provider: boundFake(provider) }],
      parseV2([
        "--providers",
        "beam",
        "--runs",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "snapshot",
        "--out",
        directory,
      ]),
      async () => {},
    );

    const setup = report.samples.find((s) => s.scenario === "snapshot-setup");

    expect(setup?.outcome).toMatchObject({
      kind: "skipped",
      note: expect.stringContaining("no API to delete"),
    });
    // The memory fake fails the shell fingerprint; only the snapshot rows matter here.
    expect(
      report.samples.filter(
        (s) => s.scenario.startsWith("snapshot") && s.outcome.kind === "failure",
      ),
    ).toEqual([]);
    expect(taken).toEqual([]);
    expect(report.cleanup).toEqual([{ provider: "beam", remaining: [], error: null }]);
  } finally {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

it("skips Archil's snapshot scenario as unsupported: the adapter has no snapshot", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve(tmpdir(), "sandbox-bench-test-"));
  expect(directory.startsWith(resolve(tmpdir()) + "/")).toBe(true);
  const backing = memory();

  // Archil's capabilities, none of them snapshot (terminal left out: the fake has none).
  const provider = {
    ...backing,
    capabilities: new Set<import("@opencoredev/sandbox-sdk/provider").Capability>([
      "pause",
      "network-policy",
      "size",
    ]),
    pause: async () => {},
    resume: async () => {},
  } satisfies import("@opencoredev/sandbox-sdk/provider").Provider;

  try {
    const report = await runV2(
      [
        {
          kind: "ready",
          name: "archil",
          cloud: false,
          region: null,
          provider: boundFake(provider),
        },
      ],
      parseV2([
        "--providers",
        "archil",
        "--runs",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "snapshot",
        "--out",
        directory,
      ]),
      async () => {},
    );

    const setup = report.samples.find((s) => s.scenario === "snapshot-setup");

    expect(setup?.outcome).toMatchObject({ kind: "skipped", note: "Provider has no snapshot" });
    expect(
      report.samples.filter(
        (s) => s.scenario.startsWith("snapshot") && s.outcome.kind === "failure",
      ),
    ).toEqual([]);
    expect(report.cleanup).toEqual([{ provider: "archil", remaining: [], error: null }]);
  } finally {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

it("records Instabox's blocked tcp-ms as documented not-run, not a failure, and keeps a returned value", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");

  const fingerprint = {
    cpuModel: "test",
    flags: [],
    nproc: 2,
    cpuMax: "max",
    quotaCpus: null,
    memoryMax: "max",
    memTotalBytes: 4 * 1024 ** 3,
    memoryBytes: 4 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
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

  const baseMetrics = {
    "cpu-single": 1,
    "cpu-all": 2,
    "memory-mbps": 3,
    "disk-write-mbps": 4,
    "disk-read-mbps": 5,
    "disk-4k-write-iops": 6,
    "disk-4k-read-iops": 7,
  };

  for (const [name, tcp] of [
    ["instabox", undefined],
    ["instabox", 12],
    ["e2b", undefined],
  ] as const) {
    const directory = await mkdtemp(resolve(tmpdir(), "sandbox-bench-test-"));
    const backing = memory();
    const metrics = tcp === undefined ? baseMetrics : { ...baseMetrics, "tcp-ms": tcp };

    const provider = {
      ...backing,
      exec: async (
        id: string,
        input: import("@opencoredev/sandbox-sdk/provider").ExecInput,
      ): Promise<import("@opencoredev/sandbox-sdk/provider").ExecResult> => {
        const stdout = input.command.includes("BENCH_FINGERPRINT")
          ? fingerprint
          : input.command.includes("BENCH_PERF")
            ? {
                metrics,
                notes: tcp === undefined ? ["tcp-ms: timed out"] : [],
                workers: 2,
                method: "test",
              }
            : undefined;

        if (stdout === undefined) return backing.exec(id, input);
        input.onChunk({ stream: "stdout", text: JSON.stringify(stdout) });

        return { exitCode: 0, timedOut: false };
      },
    };

    try {
      const report = await runV2(
        [{ kind: "ready", name, cloud: false, region: null, provider: boundFake(provider) }],
        parseV2([
          "--providers",
          name,
          "--runs",
          "1",
          "--scenarios",
          "perf",
          "--omit-network-download",
          "true",
          "--bursts",
          "",
          "--out",
          directory,
        ]),
        async () => {},
      );

      const rows = report.samples.filter((s) => s.scenario === "tcp-ms");
      const note = report.providers.find((p) => p.name === name)?.note ?? "";

      if (name === "instabox" && tcp === undefined) {
        expect(rows).toEqual([]);
        expect(note).toContain("tcp-ms documented not-run");
      } else if (name === "instabox") {
        expect(rows.map((s) => s.outcome)).toEqual([{ kind: "sample", value: 12 }]);
        expect(note).not.toContain("tcp-ms documented not-run");
        expect(note).toContain("remove its collection-policy entry");
      } else {
        expect(rows.map((s) => s.outcome.kind)).toEqual(["failure"]);
      }

      expect(report.samples.find((s) => s.scenario === "cpu-single")?.outcome).toEqual({
        kind: "sample",
        value: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

it("keeps an acknowledged delete journaled, and reports it, until a lookup sees the sandbox gone", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const directory = await mkdtemp(resolve(tmpdir(), "sandbox-bench-test-"));
  const backing = memory();
  const acknowledged = new Set<string>();

  // The delete is acknowledged and the listing drops the sandbox, but it still answers by ID.
  const provider = {
    ...backing,
    list: async (labels: Record<string, string>) =>
      (await backing.list(labels)).filter((info) => !acknowledged.has(info.id)),
    destroy: async (id: string) => {
      acknowledged.add(id);
    },
  } satisfies import("@opencoredev/sandbox-sdk/provider").Provider;

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
        "--bursts",
        "",
        "--scenarios",
        "command",
        "--timeout-ms",
        "200",
        "--out",
        directory,
      ]),
      async () => {},
    );

    const [id] = acknowledged;

    expect(id).toBeDefined();
    expect(report.cleanup).toEqual([
      {
        provider: "memory",
        remaining: [id],
        error: expect.stringContaining("no exact lookup saw the sandbox gone"),
      },
    ]);
    expect(
      JSON.parse(await readFile(resolve(directory, "ownership.json"), "utf8")).resources,
    ).toEqual([expect.objectContaining({ provider: "memory", id, kind: "sandbox" })]);
  } finally {
    for (const info of await backing.list({})) await backing.destroy(info.id);
    await rm(directory, { recursive: true, force: true });
  }
});
