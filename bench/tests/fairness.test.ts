import { tmpdir } from "node:os";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { z } from "zod";
import { resolve } from "node:path";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { journalFiles } from "../src/files.js";
import { runV2 } from "../src/v2-runner.js";
import { parseV2 } from "../src/v2-config.js";
import { PhaseClock, firstByteAttempt, perfMetrics, filePayloads } from "../src/measurement.js";
import { headroom, collectMetadata } from "../src/publication.js";
import { markdownV2, htmlV2, writeV2 } from "../src/v2-report.js";
import * as snapshots from "../src/snapshots.js";

const fingerprint = {
  cpuModel: "fixture",
  flags: [],
  nproc: 64,
  cpuMax: "200000 100000",
  quotaCpus: 2,
  memoryMax: "1073741824",
  memTotalBytes: 8 * 1024 ** 3,
  memoryBytes: 1024 ** 3,
  diskBytes: 10 * 1024 ** 3,
  df: "",
  lsblk: "",
  virtualization: "",
  hypervisor: false,
  dmi: "",
  kernel: "test",
  distro: "test",
  user: "test",
  uid: 1000,
  sudo: false,
  stealPercent: 0,
  egress: null,
  tools: {},
  runtime: "test",
};

const dirs: string[] = [];

beforeEach(() => {
  vi.spyOn(snapshots.snapshotMetadata, "inspect").mockResolvedValue({ exists: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function config(args: string[] = []) {
  const dir = await fs.mkdtemp(resolve(tmpdir(), "sandbox-bench-test-"));
  dirs.push(dir);
  expect(dir.startsWith(resolve(tmpdir()) + "/")).toBe(true);

  return parseV2(["--runs", "1", "--bursts", "", "--scenarios", "command", "--out", dir, ...args]);
}

function fake(overrides: Partial<Provider> = {}): Provider {
  const backing = memory();

  return {
    ...backing,
    exec: async (id, input) => {
      if (input.command.includes("BENCH_FINGERPRINT")) {
        input.onChunk({ stream: "stdout", text: JSON.stringify(fingerprint) });

        return { exitCode: 0, timedOut: false };
      }

      return backing.exec(id, input);
    },
    ...overrides,
  };
}

const ready = (name: string, provider: Provider, region: string | null = null) => ({
  kind: "ready" as const,
  name,
  provider,
  region,
  cloud: false,
});

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

it("keeps lifetime corrections on their own sample during concurrent appends (finding 1)", async () => {
  let releaseFailed = () => {},
    startHealthy = () => {};

  const failedGate = new Promise<void>((r) => {
    releaseFailed = r;
  });

  const healthyGate = new Promise<void>((r) => {
    startHealthy = r;
  });

  const append = fs.appendFile;

  vi.spyOn(journalFiles, "appendFile").mockImplementation(async (path, data, options) => {
    const text = String(data);

    if (text.includes('"scenario":"sandbox-lifetime"') && text.includes('"provider":"boat"')) {
      startHealthy();
      await failedGate;
    }

    if (text.includes('"scenario":"sandbox-lifetime"') && text.includes('"provider":"healthy"'))
      releaseFailed();
    await append(path, data, options);
  });
  const backing = memory();

  const failed = fake({
    create: async () => {
      throw new Error("create rejected");
    },
  });

  const healthy = fake({
    create: async (input) => {
      await healthyGate;

      return backing.create(input);
    },
    exec: backing.exec,
    destroy: backing.destroy,
    files: backing.files,
    list: backing.list,
  });

  const report = await runV2(
    [ready("boat", failed), ready("healthy", healthy)],
    await config(["--concurrency", "2"]),
    async () => {},
  );

  expect(
    report.samples.find((s) => s.provider === "boat" && s.scenario === "sandbox-lifetime")?.outcome
      .kind,
  ).toBe("skipped");
  expect(
    report.samples.find((s) => s.provider === "healthy" && s.scenario === "sandbox-lifetime")
      ?.outcome.kind,
  ).toBe("sample");
  expect(
    report.samples.find((s) => s.provider === "boat" && s.scenario === "sandbox-lifetime")
      ?.estimatedCost,
  ).toBeGreaterThan(0);
  expect(
    report.samples.find((s) => s.provider === "healthy" && s.scenario === "sandbox-lifetime")
      ?.estimatedCost,
  ).toBeNull();
});

it.each(["command-error", "timeout", "invalid-json", "missing-metrics"])(
  "records every expected metric failure for %s (finding 2)",
  async (mode) => {
    const provider = fake();
    const original = provider.exec;
    provider.exec = async (id, input) => {
      if (!input.command.includes("BENCH_PERF")) return original(id, input);

      if (mode === "command-error") throw new Error("probe failed");

      if (mode === "timeout")
        return new Promise<import("@opencoredev/sandbox-sdk/provider").ExecResult>(
          (_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("probe aborted")), {
              once: true,
            });
          },
        );
      input.onChunk({
        stream: "stdout",
        text:
          mode === "invalid-json"
            ? "invalid"
            : JSON.stringify({ metrics: {}, notes: [], workers: 2, method: "fixture" }),
      });

      return { exitCode: 0, timedOut: false };
    };

    const report = await runV2(
      [ready("fixture", provider)],
      await config(["--scenarios", "perf", "--timeout-ms", "1000"]),
      async () => {},
    );

    for (const metric of Object.keys(perfMetrics)) {
      const rows = report.samples.filter((s) => s.scenario === metric);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome.kind).toBe("failure");
      expect(report.summaries.find((s) => s.scenario === metric)?.success?.rate).toBe(0);
    }
  },
);

it("attributes downstream work to a failed resume and excludes it from independent reliability (finding 3)", async () => {
  const provider = fake({
    capabilities: new Set(["pause"]),
    pause: async () => {},
    resume: async () => {
      throw new Error("resume failed");
    },
  });

  // Seed 3 places resume before command.
  const report = await runV2(
    [ready("fixture", provider)],
    await config(["--scenarios", "pause-resume,command", "--seed", "3"]),
    async () => {},
  );

  const pause = report.samples.findIndex((s) => s.scenario === "pause-resume");
  const command = report.samples.findIndex((s) => s.scenario === "command");
  expect(pause).toBeLessThan(command);
  expect(report.samples[command]?.outcome).toMatchObject({
    kind: "blocked",
    blocked_by: "pause-resume",
  });
  expect(report.summaries.find((s) => s.scenario === "command")).toMatchObject({
    failures: 0,
    blocked: 1,
    success: null,
  });
});

it("does not close the working handle when reconnect fails (finding 3)", async () => {
  let closes = 0;

  const provider = fake({
    connect: async () => {
      throw new Error("connect failed");
    },
    close: async () => {
      closes++;
    },
  });

  const report = await runV2(
    [ready("fixture", provider)],
    await config(["--scenarios", "reconnect"]),
    async () => {},
  );

  expect(report.samples.find((s) => s.scenario === "reconnect")?.outcome.kind).toBe("failure");
  expect(closes).toBe(0);
});

it("transfers precomputed file buffers with no payload generation inside the timer (finding 4)", async () => {
  const provider = fake();
  const write = provider.files.write;
  const transferred: Uint8Array[] = [];

  const wrapped = {
    ...provider,
    files: {
      ...provider.files,
      write: async (id: string, path: string, bytes: Uint8Array) => {
        if (path.endsWith("bench-10485760.bin")) transferred.push(bytes);
        await write(id, path, bytes);
      },
    },
  } satisfies Provider;

  const from = vi.spyOn(Uint8Array, "from");

  const report = await runV2(
    [ready("fixture", wrapped)],
    await config(["--scenarios", "files-10mb"]),
    async () => {},
  );

  expect(report.samples.find((s) => s.scenario === "files-10mb")?.outcome.kind).toBe("sample");
  expect(transferred[0]).toBe(filePayloads.get(10485760));
  expect(from.mock.calls.some(([value]) => "length" in value && value.length === 10485760)).toBe(
    false,
  );
});

it("ends first-byte timing before asynchronous reader cancellation (finding 5)", async () => {
  let finishCancel = () => {};

  const cancel = new Promise<void>((r) => {
    finishCancel = r;
  });

  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1]));
          },
          cancel() {
            return cancel;
          },
        }),
      ),
  );
  const clock = new PhaseClock();
  const cleanups: Promise<void>[] = [];
  await firstByteAttempt(
    { url: "https://preview.invalid" },
    new AbortController().signal,
    clock,
    (p) => {
      cleanups.push(p);
    },
  );
  const elapsed = clock.elapsed();
  await wait(40);
  expect(clock.elapsed()).toBe(elapsed);
  expect(cleanups).toHaveLength(1);
  finishCancel();
  await Promise.all(cleanups);
});

it("times only native snapshot API, excluding cleanup-client setup and journals (finding 6)", async () => {
  vi.spyOn(snapshots, "snapshotCleaner").mockImplementation(async () => {
    await wait(70);

    return async () => {};
  });

  vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
    if (String(to).endsWith("ownership.json")) await wait(40);

    return fs.rename(from, to);
  });

  const provider = fake({
    capabilities: new Set(["snapshot"]),
    snapshot: async () => {
      await wait(10);

      return { id: "fixture-snapshot" };
    },
  });

  const report = await runV2(
    [ready("fixture", provider)],
    await config(["--scenarios", "snapshot"]),
    async () => {},
  );

  const api = report.samples.find((s) => s.scenario === "snapshot");
  const total = report.samples.find((s) => s.scenario === "snapshot-total");

  if (api?.outcome.kind !== "sample" || total?.outcome.kind !== "sample")
    throw new Error("Expected snapshot timings");
  expect(total.outcome.value - api.outcome.value).toBeGreaterThanOrEqual(60);
  expect(api.durationMs).toBe(api.outcome.value);
  expect(api.outcome.value).toBeLessThan(40);
});

it("retains configured region, collection metadata and repeated burst cohorts in reports (finding 7/publication)", async () => {
  const report = await runV2(
    [ready("boat", fake(), "us-fixture")],
    await config(["--scenarios", "burst", "--bursts", "2", "--burst-cohorts", "3"]),
    async () => {},
  );

  expect(report.providers[0]?.configuredRegion).toBe("us-fixture");
  const rows = report.samples.filter((s) => s.scenario === "burst-2/all-ready");
  expect(rows.map((s) => s.iteration)).toEqual([0, 1, 2]);
  expect(report.summaries.find((s) => s.scenario === "burst-2/all-ready")?.stats.count).toBe(3);
  expect(report.metadata.repositoryCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(report.metadata.sdkVersion).toBeTruthy();
  expect(markdownV2(report)).toContain("us-fixture");
  expect(htmlV2(report)).toContain("us-fixture");
  expect(markdownV2(report)).toContain("Client headroom");
  expect(htmlV2(report)).toContain("collection metadata");
});

it("flags high host load and derives CPU/network deltas without treating them as provider-only traffic", () => {
  const before = {
    timestamp: "2026-01-01T00:00:00Z",
    load: [3],
    cpu: { user: 0, system: 0 },
    cpuTicks: [[0, 0, 0, 100, 0]],
    network: "eth0: 100 0 0 0 0 0 0 0 200",
  };

  const after = {
    ...before,
    timestamp: "2026-01-01T00:00:02Z",
    cpuTicks: [[90, 0, 0, 110, 0]],
    network: "eth0: 300 0 0 0 0 0 0 0 600",
  };

  expect(headroom(before, after)).toMatchObject({
    highLoad: true,
    normalizedLoad: 3,
    hostCpuBusy: 0.9,
    rxBytesPerSecond: 100,
    txBytesPerSecond: 200,
  });
});

it("separates provisioning, dev start and individual retry attempts (finding 5)", async () => {
  const provider = fake();
  const exec = provider.exec;
  provider.exec = async (id, input) =>
    input.command.includes("npm ci") ? { exitCode: 0, timedOut: false } : exec(id, input);
  let provisions = 0;
  provider.previewUrl = async () => {
    provisions++;
    await wait(50);

    return { url: "https://preview.invalid" };
  };

  provider.startProcess = async (_id, input) => {
    input.onChunk({ stream: "stdout", text: "Local: http://fixture:3000\n" });

    return { pid: 1, wait: () => new Promise(() => {}), stop: async () => {} };
  };

  let requests = 0;
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1]));
          },
          cancel: () => wait(80),
        }),
        { status: ++requests === 1 ? 502 : 200 },
      ),
  );

  const report = await runV2(
    [ready("fixture", provider)],
    await config(["--scenarios", "preview-first-byte"]),
    async () => {},
  );

  expect(provisions).toBe(1);
  const provision = report.samples.find((s) => s.scenario === "preview-provisioning");
  const dev = report.samples.find((s) => s.scenario === "dev-server");
  expect(provision?.outcome.kind).toBe("sample");
  expect(dev?.outcome.kind).toBe("sample");
  expect(Date.parse(dev?.startedAt ?? "")).toBeGreaterThanOrEqual(
    Date.parse(provision?.finishedAt ?? ""),
  );
  const attempts = report.samples.filter((s) => s.scenario === "preview-first-byte");
  expect(attempts.map((s) => s.outcome.kind)).toEqual(["failure", "sample"]);
  expect(attempts.map((s) => s.details)).toEqual([{ attempt: 1 }, { attempt: 2 }]);
  expect(attempts.every((s) => s.durationMs < 80)).toBe(true);
  expect(
    Date.parse(attempts[1]?.startedAt ?? "") - Date.parse(attempts[0]?.finishedAt ?? ""),
  ).toBeGreaterThanOrEqual(450);
  expect(report.summaries.find((s) => s.scenario === "preview-first-byte")?.success?.rate).toBe(
    0.5,
  );
});

it("records client egress geography and runtime/commit metadata without provider calls", async () => {
  const lookup = vi.fn(async () =>
    Response.json({ ip: "203.0.113.1", region: "fixture-region", country: "ZZ" }),
  );

  vi.stubGlobal("fetch", lookup);
  const metadata = await collectMetadata(true);
  expect(lookup).toHaveBeenCalledOnce();
  expect(metadata.clientLocation).toEqual({
    ip: "203.0.113.1",
    region: "fixture-region",
    country: "ZZ",
  });
  expect(metadata.harnessCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(metadata.sdkCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(metadata.runtimes.node).toBe(process.version);
});

it("publishes each perf metric once even when metric persistence exceeds the guest deadline", async () => {
  const append = fs.appendFile;

  vi.spyOn(journalFiles, "appendFile").mockImplementation(async (path, data, options) => {
    if (String(data).includes('"scenario":"cpu-single"')) await wait(1200);

    return append(path, data, options);
  });
  const provider = fake();
  const exec = provider.exec;
  provider.exec = async (id, input) => {
    if (!input.command.includes("BENCH_PERF")) return exec(id, input);
    input.onChunk({
      stream: "stdout",
      text: JSON.stringify({
        metrics: Object.fromEntries(Object.keys(perfMetrics).map((key) => [key, 1])),
        notes: [],
        workers: 2,
        method: "fixture",
      }),
    });

    return { exitCode: 0, timedOut: false };
  };

  const report = await runV2(
    [ready("fixture", provider)],
    await config(["--scenarios", "perf", "--timeout-ms", "1000"]),
    async () => {},
  );

  for (const metric of Object.keys(perfMetrics)) {
    const rows = report.samples.filter((s) => s.scenario === metric);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome.kind).toBe("sample");
    const probe = report.samples.find((s) => s.scenario === "perf");
    expect(probe?.outcome.kind).toBe("sample");
    expect(rows[0]?.hostAfter).toEqual(probe?.hostAfter);
    expect(rows[0]?.headroom).toEqual(probe?.headroom);
  }
});

it("blocks restored fingerprint after failed restored readiness while still destroying the restore", async () => {
  vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {});
  const backing = fake();
  let restoredId: string | undefined;
  let creates = 0;

  const provider = {
    ...backing,
    capabilities: new Set(["snapshot"]),
    snapshot: async () => ({ id: "fixture-snapshot" }),
    create: async (input: Parameters<Provider["create"]>[0]) => {
      const result = await backing.create(input);

      if (++creates === 2) restoredId = result.id;

      return result;
    },
    exec: async (id: string, input: Parameters<Provider["exec"]>[1]) => {
      if (id === restoredId) throw new Error("restored VM unavailable");

      return backing.exec(id, input);
    },
  } satisfies Provider;

  const report = await runV2(
    [ready("fixture", provider)],
    await config(["--scenarios", "snapshot"]),
    async () => {},
  );

  expect(report.samples.find((s) => s.scenario === "create-from-snapshot")?.outcome.kind).toBe(
    "failure",
  );
  expect(report.samples.find((s) => s.scenario === "restore-fingerprint")?.outcome).toMatchObject({
    kind: "blocked",
    blocked_by: "create-from-snapshot",
  });
  expect(report.samples.find((s) => s.scenario === "restore-destroy")?.outcome.kind).toBe("sample");
  expect(report.summaries.find((s) => s.scenario === "restore-fingerprint")).toMatchObject({
    failures: 0,
    blocked: 1,
    success: null,
  });
});

it.each(["native-failure", "unsupported", "setup-failure"])(
  "preserves the %s outcome in snapshot-total",
  async (mode) => {
    vi.spyOn(snapshots, "snapshotCleaner").mockImplementation(async () => {
      if (mode === "setup-failure") throw new Error("setup unavailable");

      return async () => {};
    });

    const provider = fake({
      capabilities: new Set(mode === "unsupported" ? [] : ["snapshot"]),
      snapshot: async () => {
        throw new Error("native snapshot failed");
      },
    });

    const report = await runV2(
      [ready("fixture", provider)],
      await config(["--scenarios", "snapshot"]),
      async () => {},
    );

    expect(report.samples.find((s) => s.scenario === "snapshot-total")?.outcome.kind).toBe(
      mode === "unsupported" ? "skipped" : "failure",
    );
  },
);

it("excludes slow previous-handle cleanup from reconnect readiness", async () => {
  const provider = fake({
    close: async () => {
      await wait(150);
    },
  });

  const report = await runV2(
    [ready("fixture", provider)],
    await config(["--scenarios", "reconnect"]),
    async () => {},
  );

  const row = report.samples.find((s) => s.scenario === "reconnect");
  expect(row?.outcome.kind).toBe("sample");
  expect(row?.durationMs).toBeLessThan(80);
  expect(row?.details).toMatchObject({ firstCommandOKMs: expect.any(Number) });

  const details = z.object({ firstCommandOKMs: z.number() }).parse(row?.details);
  expect(details.firstCommandOKMs).toBeLessThan(80);
  expect(
    report.samples.find((s) => s.scenario === "reconnect-cleanup")?.durationMs,
  ).toBeGreaterThanOrEqual(140);
});

it("keeps shared provider attachment alive for scenarios following reconnect", async () => {
  const backing = fake();
  let attached = true;

  const provider = {
    ...backing,
    connect: async (id: string) => {
      attached = true;

      return backing.connect(id);
    },
    close: async () => {
      attached = false;
    },
    exec: async (id: string, input: Parameters<Provider["exec"]>[1]) => {
      if (!attached) throw new Error("Provider cache detached");

      return backing.exec(id, input);
    },
  } satisfies Provider;

  const report = await runV2(
    [ready("fixture", provider)],
    await config(["--scenarios", "reconnect,command", "--seed", "2"]),
    async () => {},
  );

  const reconnect = report.samples.findIndex((s) => s.scenario === "reconnect");
  const command = report.samples.findIndex((s) => s.scenario === "command");
  expect(reconnect).toBeLessThan(command);
  expect(report.samples[command]?.outcome.kind).toBe("sample");
  expect(report.samples.findIndex((s) => s.scenario === "reconnect-cleanup")).toBeGreaterThan(
    report.samples.findIndex((s) => s.scenario === "destroy"),
  );
  expect(attached).toBe(false);
});

it("stores separate pause and resume phases on successful observations", async () => {
  const provider = fake({
    capabilities: new Set(["pause"]),
    pause: async () => {
      await wait(5);
    },
    resume: async () => {
      await wait(5);
    },
  });

  const report = await runV2(
    [ready("fixture", provider)],
    await config(["--scenarios", "pause-resume"]),
    async () => {},
  );

  const row = report.samples.find((s) => s.scenario === "pause-resume");
  expect(row?.outcome.kind).toBe("sample");
  expect(row?.phases.pauseMs).toBeGreaterThan(0);
  expect(row?.phases.resumeReturnedMs).toBeGreaterThan(0);
  expect(row?.phases.resumeReadyMs).toBeGreaterThanOrEqual(
    row?.phases.resumeReturnedMs ?? Infinity,
  );
});

it("ends cold and restore at bare true before SDK setup", async () => {
  vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {});
  const backing = fake();
  const order: string[] = [];

  const provider = {
    ...backing,
    capabilities: new Set(["snapshot", "size"]),
    snapshot: async () => ({ id: "snap" }),
    files: {
      ...backing.files,
      write: async (id: string, path: string, data: Uint8Array) => {
        order.push(`sdk:${id}`);
        await wait(30);

        return backing.files.write(id, path, data);
      },
    },
    create: async (input: Parameters<Provider["create"]>[0]) => {
      expect(input.size).toEqual(input.from ? undefined : { cpu: 4, memoryMb: 8192 });

      return backing.create({ ...input, size: undefined });
    },
    exec: async (id: string, input: Parameters<Provider["exec"]>[1]) => {
      if (input.command === "true") {
        order.push(`bare:${id}`);
        expect(input).toMatchObject({ cwd: "/workspace", env: {}, streaming: false });
      } else {
        order.push(`sdk:${id}`);
        await wait(30);
      }

      return backing.exec(id, input);
    },
  } satisfies Provider;

  const report = await runV2(
    [ready("local", provider)],
    await config([
      "--scenarios",
      "snapshot",
      "--track",
      "same-spec",
      "--size",
      "local=4:8192",
      "--template",
      "local=test",
    ]),
    async () => {},
  );

  for (const scenario of ["cold", "create-from-snapshot"]) {
    const row = report.samples.find((s) => s.scenario === scenario);
    expect(row?.outcome.kind).toBe("sample");
    expect(row?.phases).toMatchObject({
      adapterCreateMs: expect.any(Number),
      firstCommandMs: expect.any(Number),
      coldMs: expect.any(Number),
      sdkReadyMs: expect.any(Number),
    });

    if (!row || row.outcome.kind !== "sample") throw new Error("Missing readiness sample");
    const { coldMs = 0, sdkReadyMs = 0, firstCommandOKMs = 0 } = row.phases;
    expect(row.outcome.value).toBe(coldMs);
    expect(row.durationMs).toBe(coldMs);
    // SDK setup is deferred and cached per provider, so it can add nothing after bare readiness.
    expect(sdkReadyMs).toBeGreaterThanOrEqual(coldMs);
    expect(firstCommandOKMs).toBeGreaterThanOrEqual(coldMs);
    expect(order.filter((o) => o.endsWith(`:${row.sandboxId}`))[0]).toBe(`bare:${row.sandboxId}`);
  }

  expect(report.samples.every((s) => s.track === "same-spec" && s.template === "test")).toBe(true);
  expect(report.providers[0]).toMatchObject({
    track: "same-spec",
    requestedSize: { cpu: 4, memoryMb: 8192 },
    template: "test",
  });
  expect(report.summaries.every((s) => s.track === "same-spec")).toBe(true);
  expect(report.cleanup).toEqual([{ provider: "local", remaining: [], error: null }]);
});

it("keeps fixture upload delays and failures outside workload timings", async () => {
  const backing = fake();
  const write = backing.files.write;

  const provider = {
    ...backing,
    files: {
      ...backing.files,
      write: async (id: string, path: string, data: Uint8Array) => {
        if (path.startsWith("/workspace/bench-app/")) await wait(25);

        return write(id, path, data);
      },
    },
  } satisfies Provider;

  const report = await runV2(
    [ready("memory", provider)],
    await config(["--scenarios", "npm-install,tool-replay"]),
    async () => {},
  );

  const prep = report.samples.filter((s) => s.scenario.endsWith("-prepare"));
  expect(prep.length).toBeGreaterThan(0);
  expect(prep.every((s) => s.durationMs >= 25 && s.outcome.kind === "sample")).toBe(true);

  for (const workload of ["npm-install", "tool-replay"]) {
    const row = report.samples.find((s) => s.scenario === workload);

    if (!row) throw new Error("Missing workload");
    expect(prep.some((p) => Date.parse(p.finishedAt) <= Date.parse(row.startedAt))).toBe(true);
  }

  const brokenBacking = fake();
  const original = brokenBacking.files.write;

  const broken = {
    ...brokenBacking,
    files: {
      ...brokenBacking.files,
      write: async (id, path, data) => {
        if (path.startsWith("/workspace/bench-app/")) throw new Error("upload unavailable");

        return original(id, path, data);
      },
    },
  } satisfies Provider;

  const failed = await runV2(
    [ready("memory", broken)],
    await config(["--scenarios", "npm-install,tool-replay"]),
    async () => {},
  );

  for (const workload of ["npm-install", "tool-replay"]) {
    expect(failed.samples.find((s) => s.scenario === `${workload}-prepare`)?.outcome.kind).toBe(
      "failure",
    );
    expect(failed.samples.find((s) => s.scenario === workload)?.outcome).toMatchObject({
      kind: "blocked",
      blocked_by: `${workload}-prepare`,
    });
  }
});

it("reports burst all-ready from bare readiness endpoints", async () => {
  const backing = fake();

  const provider = {
    ...backing,
    files: {
      ...backing.files,
      write: async (id: string, path: string, data: Uint8Array) => {
        await wait(20);

        return backing.files.write(id, path, data);
      },
    },
    exec: async (id: string, input: Parameters<Provider["exec"]>[1]) => {
      if (input.command !== "true") await wait(20);

      return backing.exec(id, input);
    },
  } satisfies Provider;

  const report = await runV2(
    [ready("boat", provider)],
    await config(["--scenarios", "burst", "--bursts", "2", "--burst-cohorts", "1"]),
    async () => {},
  );

  const cohort = report.samples.find((s) => s.scenario === "burst-2/all-ready");

  if (!cohort) throw new Error("Missing cohort");
  const members = report.samples.filter((s) => s.scenario === "burst-2/cold");
  expect(members).toHaveLength(2);
  expect(cohort.outcome).toEqual({
    kind: "sample",
    value: Math.max(
      ...members.map(
        (s) =>
          Date.parse(s.finishedAt) -
          Date.parse(cohort.startedAt) -
          (s.phases.ownershipPersistMs ?? 0) -
          (s.phases.ownershipVerifyMs ?? 0),
      ),
    ),
  });
  // SDK setup is deferred to first use, so SDK readiness may equal bare readiness but never precede it.
  expect(members.every((s) => (s.phases.sdkReadyMs ?? 0) >= (s.phases.coldMs ?? 0))).toBe(true);
});

it.each([0, 500])(
  "excludes %d ms of ownership listing from the destroy request metric",
  async (listingMs) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const backing = fake();

    const provider: Provider = {
      ...backing,
      list: async (labels) => {
        now += listingMs;

        return backing.list(labels);
      },
      destroy: async (id) => {
        now += 7;
        await backing.destroy(id);
      },
    };

    const report = await runV2([ready("memory", provider)], await config(), async () => {});
    const sample = report.samples.find((s) => s.scenario === "destroy");
    expect(sample?.outcome).toEqual({ kind: "sample", value: 7 });
    expect(sample?.durationMs).toBe(7);
    expect(sample?.phases.ownershipVerifyMs).toBe(listingMs);
    expect(await backing.list({})).toEqual([]);
  },
);

it("marks awaited execution buffered and iteration streaming", async () => {
  const backing = memory();
  const markers: (boolean | undefined)[] = [];
  const { createSandbox } = await import("@opencoredev/sandbox-sdk");

  const provider = {
    ...backing,
    exec: async (id: string, input: Parameters<Provider["exec"]>[1]) => {
      markers.push(input.streaming);

      return backing.exec(id, input);
    },
  } satisfies Provider;

  const box = await createSandbox(provider);
  markers.length = 0;

  try {
    await box.run("echo awaited");

    for await (const _chunk of box.run("echo streamed")) {
      /* consume chunks */
    }

    expect(markers).toEqual([false, true]);
  } finally {
    await box.destroy();
  }
});

it("flushes complete ownership before bare execution and excludes that flush from cold", async () => {
  const backing = fake();
  const cfg = await config();

  const provider = {
    ...backing,
    exec: async (id: string, input: Parameters<Provider["exec"]>[1]) => {
      if (input.command === "true") {
        const journal = JSON.parse(await fs.readFile(resolve(cfg.out, "ownership.json"), "utf8"));
        expect(journal.resources).toContainEqual({
          provider: "memory",
          id,
          kind: "sandbox",
          parent: null,
        });
      }

      return backing.exec(id, input);
    },
  } satisfies Provider;

  const report = await runV2([ready("memory", provider)], cfg, async () => {});
  const cold = report.samples.find((s) => s.scenario === "cold");
  expect(cold?.outcome.kind).toBe("sample");
  expect(cold?.phases.ownershipPersistMs).toBeGreaterThan(0);
  expect((cold?.phases.sdkReadyMs ?? 0) - (cold?.phases.coldMs ?? 0)).toBeGreaterThanOrEqual(
    cold?.phases.ownershipPersistMs ?? 0,
  );
});

it.each([false, true])(
  "restores inherit allocation without a size override and record fingerprint comparison (mismatch=%s)",
  async (mismatch) => {
    vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {});
    const backing = fake();
    let restoredId: string | undefined;

    const provider = {
      ...backing,
      capabilities: new Set(["snapshot", "size"]),
      snapshot: async () => ({ id: "snapshot" }),
      create: async (input: Parameters<Provider["create"]>[0]) => {
        expect(input.size).toEqual(input.from ? undefined : { cpu: 4, memoryMb: 8192 });
        const info = await backing.create({ ...input, size: undefined });

        if (input.from) restoredId = info.id;

        return info;
      },
      exec: async (id: string, input: Parameters<Provider["exec"]>[1]) => {
        if (id === restoredId && mismatch && input.command.includes("BENCH_FINGERPRINT")) {
          input.onChunk({
            stream: "stdout",
            text: JSON.stringify({ ...fingerprint, quotaCpus: 1 }),
          });

          return { exitCode: 0, timedOut: false };
        }

        return backing.exec(id, input);
      },
    } satisfies Provider;

    const report = await runV2(
      [ready("boat", provider)],
      await config(["--track", "same-spec", "--size", "boat=4:8192", "--scenarios", "snapshot"]),
      async () => {},
    );

    expect(report.samples.find((s) => s.scenario === "create-from-snapshot")?.outcome.kind).toBe(
      mismatch ? "failure" : "sample",
    );
    expect(report.summaries.find((s) => s.scenario === "create-from-snapshot")?.stats.p50).toEqual(
      mismatch ? null : expect.any(Number),
    );
    const row = report.samples.find((s) => s.scenario === "restore-fingerprint");
    expect(row?.outcome.kind).toBe(mismatch ? "failure" : "sample");
    expect(row?.details).toMatchObject({
      verification: { matches: !mismatch, source: { cpu: 2 }, restored: { cpu: mismatch ? 1 : 2 } },
    });
    expect(row?.fingerprint?.quotaCpus).toBe(mismatch ? 1 : 2);
    expect(report.cleanup[0]?.remaining).toEqual([]);
  },
);

it("keeps an unverified restore unranked without charging it to the provider", async () => {
  vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {});
  const backing = fake();
  let restoredId: string | undefined;

  const provider = {
    ...backing,
    capabilities: new Set(["snapshot"]),
    snapshot: async () => ({ id: "snapshot" }),
    create: async (input: Parameters<Provider["create"]>[0]) => {
      const info = await backing.create(input);

      if (input.from) restoredId = info.id;

      return info;
    },
    exec: async (id: string, input: Parameters<Provider["exec"]>[1]) => {
      if (id === restoredId && input.command.includes("BENCH_FINGERPRINT")) {
        input.onChunk({ stream: "stdout", text: "not json" });

        return { exitCode: 0, timedOut: false };
      }

      return backing.exec(id, input);
    },
  } satisfies Provider;

  const report = await runV2(
    [ready("boat", provider)],
    await config(["--scenarios", "snapshot"]),
    async () => {},
  );

  expect(report.samples.find((s) => s.scenario === "restore-fingerprint")?.outcome.kind).toBe(
    "failure",
  );
  expect(report.samples.find((s) => s.scenario === "create-from-snapshot")?.outcome).toMatchObject({
    kind: "blocked",
    blocked_by: "restore-fingerprint",
  });
  expect(report.summaries.find((s) => s.scenario === "create-from-snapshot")?.stats.p50).toBeNull();
  expect(report.cleanup[0]?.remaining).toEqual([]);
});

it("persists sanitized SDK attribution and lets site failure reasons explain it", async () => {
  const { SandboxError } = await import("@opencoredev/sandbox-sdk");
  const { sampleSchema } = await import("../src/merge.js");
  const { failureReasons } = await import("../src/site-data.js");
  vi.stubEnv("BENCH_TEST_SECRET_TOKEN", "private-secret-value");

  const provider = fake({
    capabilities: new Set(["size"]),
    create: async () => {
      throw new SandboxError("create private-secret-value failed", {
        code: "quota",
        cause:
          "create HTTP 429: code=CAPACITY requestId=req-123 token=private-secret-value body=do-not-copy-this",
      });
    },
  });

  const report = await runV2(
    [ready("local", provider)],
    await config(["--bursts", "2", "--burst-cohorts", "1", "--concurrency", "2"]),
    async () => {},
  );

  for (const failed of report.samples.filter((s) => s.outcome.kind === "failure")) {
    expect(failed.outcome).toMatchObject({
      stage: expect.any(String),
      elapsedMs: expect.any(Number),
    });
  }

  expect(report.samples.find((s) => s.scenario === "burst-2/all-ready")?.outcome.kind).toBe(
    "failure",
  );
  const sample = report.samples.find((s) => s.scenario === "cold");

  if (!sample) throw new Error("missing failure");
  expect(sample.outcome).toMatchObject({
    kind: "failure",
    code: "quota",
    stage: "cold",
    elapsedMs: expect.any(Number),
    cause: { httpStatus: 429, providerCode: "CAPACITY", requestId: "req-123", operation: "create" },
  });
  expect(sampleSchema.parse(sample).outcome).toEqual(sample.outcome);
  expect(JSON.stringify(sample)).not.toContain("private-secret-value");
  expect(JSON.stringify(sample)).not.toContain("do-not-copy-this");
  expect(
    failureReasons([{ ...sample, suite: "main", failureClass: "provider-operation" }], "local")[0]
      ?.reason,
  ).toContain("HTTP 429, CAPACITY, operation=create, requestId=req-123");

  // The runner's append journal is the immediate failure record, before the final report writer.
  const lines = (await fs.readFile(resolve(report.config.out, "samples.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(lines.find((row) => row.scenario === "cold").outcome).toEqual(sample.outcome);
});

it("retains late restored native IDs and cleans them after the outer restore deadline", async () => {
  vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {});
  const backing = fake();
  let restoreId: string | undefined;

  const provider = {
    ...backing,
    capabilities: new Set(["snapshot"]),
    snapshot: async () => ({ id: "fixture-snapshot" }),
    create: async (input: Parameters<Provider["create"]>[0]) => {
      if (input.from) {
        await new Promise<void>((resolve) =>
          input.signal?.addEventListener("abort", () => setTimeout(resolve, 5), { once: true }),
        );
        const info = await backing.create({ ...input, signal: undefined });
        restoreId = info.id;

        return info;
      }

      return backing.create(input);
    },
  } satisfies Provider;

  const report = await runV2(
    [ready("fixture", provider)],
    await config(["--scenarios", "snapshot", "--timeout-ms", "1000"]),
    async () => {},
  );

  const restored = report.samples.find((s) => s.scenario === "create-from-snapshot");
  expect(restoreId).toBeTruthy();
  expect(restored).toMatchObject({
    sandboxId: restoreId,
    outcome: {
      kind: "failure",
      clockPhase: "adapter-create",
      lateSettlement: { settled: true, sandboxId: restoreId },
    },
  });
  expect(await backing.list({})).toEqual([]);
  expect(report.cleanup[0]?.remaining).toEqual([]);
});

it.each(["default", "same-spec"])(
  "bounds derived perf failure elapsed time and publishes the other metrics (%s)",
  async (track) => {
    const { mergeSources, readSource } = await import("../src/merge.js");
    const { siteData } = await import("../src/site-data.js");
    const provider = fake();
    const exec = provider.exec;
    provider.exec = async (id, input) => {
      if (!input.command.includes("BENCH_PERF")) return exec(id, input);
      input.onChunk({
        stream: "stdout",
        text: JSON.stringify({
          metrics: Object.fromEntries(
            Object.keys(perfMetrics)
              .filter((key) => key !== "tcp-ms")
              .map((key) => [key, 7]),
          ),
          notes: ["tcp-ms: timed out"],
          workers: 2,
          method: "offline partial probe",
        }),
      });

      return { exitCode: 0, timedOut: false };
    };

    const report = await runV2(
      [ready("boat", provider)],
      await config(["--track", track, "--scenarios", "perf", "--omit-network-download", "true"]),
      async () => {},
    );

    const parent = report.samples.find((s) => s.scenario === "perf");
    expect(parent?.outcome.kind).toBe("sample");
    const failed = report.samples.find((s) => s.scenario === "tcp-ms");
    expect(failed?.outcome).toMatchObject({ kind: "failure", elapsedMs: parent?.durationMs });
    expect(failed).toMatchObject({
      startedAt: parent?.startedAt,
      finishedAt: parent?.finishedAt,
      durationMs: parent?.durationMs,
    });
    await writeV2(report, report.config.out);

    const exported = siteData(
      mergeSources([await readSource(report.config.out)]),
      report.config.track,
    );

    for (const metric of Object.keys(perfMetrics).filter(
      (key) => !["tcp-ms", "network-mbps"].includes(key),
    )) {
      expect(report.samples.find((s) => s.scenario === metric)?.outcome).toEqual({
        kind: "sample",
        value: 7,
      });
      expect(exported.metrics.find((m) => m.scenario === metric)?.values[0]).toMatchObject({
        n: 1,
        p50: 7,
        failures: 0,
      });
    }

    expect(exported.metrics.find((m) => m.scenario === "tcp-ms")?.values[0]).toMatchObject({
      n: 0,
      p50: null,
      failures: 1,
    });
  },
);

it.each(["default", "same-spec"])(
  "keeps offline sample values and failure clocks within their recorded intervals (%s)",
  async (track) => {
    const checked = new Set<string>();

    const check = (report: Awaited<ReturnType<typeof runV2>>) => {
      for (const row of report.samples) {
        expect(row.durationMs, row.scenario).toBeLessThanOrEqual(
          Date.parse(row.finishedAt) - Date.parse(row.startedAt) + 1,
        );

        if (row.outcome.kind === "sample" && !Object.hasOwn(perfMetrics, row.scenario))
          expect(row.outcome.value, row.scenario).toBe(row.durationMs);

        if (row.outcome.kind !== "failure") continue;
        checked.add(row.scenario);
        const elapsed = row.outcome.elapsedMs;
        expect(elapsed, row.scenario).toEqual(expect.any(Number));

        if (elapsed === undefined) throw new Error("Missing failure elapsedMs");
        expect(Number.isFinite(elapsed), row.scenario).toBe(true);
        expect(elapsed, row.scenario).toBeGreaterThanOrEqual(0);
        expect(elapsed, row.scenario).toBeLessThanOrEqual(
          Date.parse(row.finishedAt) - Date.parse(report.timestamp),
        );
        expect(elapsed, row.scenario).toBeLessThanOrEqual(row.durationMs + 2);
        expect(Date.parse(row.startedAt), row.scenario).toBeGreaterThanOrEqual(
          Date.parse(report.timestamp),
        );
        expect(Date.parse(row.finishedAt), row.scenario).toBeGreaterThanOrEqual(
          Date.parse(row.startedAt),
        );
        expect(Date.parse(row.finishedAt), row.scenario).toBeLessThanOrEqual(
          Date.parse(report.finishedAt),
        );
      }
    };

    const run = async (provider: Provider, args: string[]) => {
      const report = await runV2(
        [ready("boat", provider)],
        await config(["--track", track, "--timeout-ms", "1000", ...args]),
        async () => {},
      );

      check(report);

      return report;
    };

    vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {});
    const backing = fake();
    const restoredIds = new Set<string>();

    const mixed = {
      ...backing,
      capabilities: new Set(["snapshot"]),
      snapshot: async () => ({ id: "offline-snapshot" }),
      create: async (input: Parameters<Provider["create"]>[0]) => {
        const info = await backing.create(input);

        if (input.from) restoredIds.add(info.id);

        return info;
      },
      files: {
        ...backing.files,
        write: async (id: string, path: string, bytes: Uint8Array) => {
          if (path.includes("bench-app/") || path.endsWith("bench-1024.bin"))
            throw new Error("offline preparation/workload fault");

          return backing.files.write(id, path, bytes);
        },
      },
      exec: async (id: string, input: Parameters<Provider["exec"]>[1]) => {
        if (input.command.includes("BENCH_FINGERPRINT") && restoredIds.has(id)) {
          input.onChunk({
            stream: "stdout",
            text: JSON.stringify({ ...fingerprint, quotaCpus: 1 }),
          });

          return { exitCode: 0, timedOut: false };
        }

        if (input.command.includes("BENCH_PERF")) {
          input.onChunk({
            stream: "stdout",
            text: JSON.stringify({
              metrics: {},
              notes: ["tcp-ms: timed out"],
              workers: 2,
              method: "offline",
            }),
          });

          return { exitCode: 0, timedOut: false };
        }

        return backing.exec(id, input);
      },
    } satisfies Provider;

    await run(mixed, ["--scenarios", "snapshot,perf,files-1kb,tool-replay,npm-install"]);
    expect(await backing.list({})).toEqual([]);
    await run(
      fake({
        create: async () => {
          throw new Error("offline create fault");
        },
      }),
      [
        "--scenarios",
        "command,burst",
        "--bursts",
        "2",
        "--concurrency",
        "2",
        "--burst-cohorts",
        "1",
      ],
    );

    for (const phase of ["cold", "create-from-snapshot", "first-command"]) {
      const lateBacking = fake();

      const afterAbort = (signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => setTimeout(resolve, 5), { once: true });
        });

      const late = {
        ...lateBacking,
        capabilities: new Set(["snapshot"]),
        snapshot: async () => ({ id: "late-snapshot" }),
        create: async (input: Parameters<Provider["create"]>[0]) => {
          if (phase === "cold" || (phase === "create-from-snapshot" && input.from)) {
            await afterAbort(input.signal);
            throw new Error("offline late native create fault", {
              cause: { stage: "readiness", elapsedMs: 1000 },
            });
          }

          return lateBacking.create(input);
        },
        exec: async (id: string, input: Parameters<Provider["exec"]>[1]) => {
          if (phase === "first-command" && input.command === "true") {
            await afterAbort(input.signal);
            throw new Error("offline late bare command fault");
          }

          return lateBacking.exec(id, input);
        },
      } satisfies Provider;

      const report = await run(late, [
        "--scenarios",
        phase === "create-from-snapshot" ? "snapshot" : "command",
      ]);

      const failure = report.samples.find(
        (s) => s.scenario === (phase === "first-command" ? "cold" : phase),
      );

      expect(failure?.outcome).toMatchObject({
        kind: "failure",
        clockPhase: phase === "first-command" ? "first-command" : "adapter-create",
        lateSettlement: { settled: true },
      });

      if (phase === "create-from-snapshot") {
        // A rejected native create without an ID cannot prove that no restore was admitted.
        // Keep its snapshot and source for review; this fixture created no actual restore.
        const retained = await lateBacking.list({});
        expect(retained).toHaveLength(1);
        expect(report.cleanupReview).toContainEqual(
          expect.objectContaining({
            id: "late-snapshot",
            kind: "snapshot",
            reason: expect.stringContaining("Restore cleanup unresolved"),
          }),
        );
        expect(report.cleanup[0]?.remaining).toEqual(
          expect.arrayContaining([retained[0]?.id, "late-snapshot"]),
        );

        for (const info of retained) await lateBacking.destroy(info.id);
      } else expect(await lateBacking.list({})).toEqual([]);
    }

    const admitted = await run(fake(), [
      "--scenarios",
      "command",
      "--runs",
      "2",
      "--max-sandboxes",
      "1",
    ]);

    expect(admitted.admissionStopped?.length).toBeGreaterThan(0);
    // Admission stops carry policy/iteration evidence, not fabricated failure clocks.
    expect(admitted.samples.some((s) => s.iteration === 1)).toBe(false);

    for (const scenario of [
      "cold",
      "create-from-snapshot",
      "restore-fingerprint",
      "burst-2/cold",
      "burst-2/all-ready",
      "tool-replay-prepare",
      "npm-install-prepare",
      "files-1kb",
      "tcp-ms",
    ])
      expect(checked.has(scenario), scenario).toBe(true);
  },
  15000,
);
