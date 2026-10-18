import { describe, expect, it } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { statistics } from "../src/stats.js";
import { loadProvider, checkBudget, type ReadyProvider } from "../src/providers.js";
import { parseConfig } from "../src/config.js";
import { measureProvider } from "../src/runner.js";
import { deadline, pool } from "../src/timing.js";

const ready = (): ReadyProvider => ({
  kind: "ready",
  name: "memory",
  cloud: false,
  region: null,
  provider: memory(),
});
describe("nearest-rank statistics", () => {
  it("matches a hand-worked distribution, without sorting the input", () => {
    const samples = [5, 1, 4, 2, 3];
    expect(statistics(samples)).toEqual({
      count: 5,
      p50: 3,
      p95: 5,
      p99: 5,
      mean: 3,
      min: 1,
      max: 5,
    });
    expect(samples).toEqual([5, 1, 4, 2, 3]);
  });
  it("selects nearest ranks at p95/p99 boundaries", () => {
    expect(statistics(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({
      count: 100,
      p50: 50,
      p95: 95,
      p99: 99,
      mean: 50.5,
      min: 1,
      max: 100,
    });
  });
  it("represents zero samples and singleton samples", () => {
    expect(statistics([])).toEqual({
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      mean: null,
      min: null,
      max: null,
    });
    expect(statistics([0])).toEqual({ count: 1, p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 });
    expect(() => statistics([NaN])).toThrow("finite");
  });
});
describe("provider skip policy", () => {
  it("never imports cloud SDKs when required credentials are absent", async () => {
    let imports = 0;
    const importer = async () => {
      imports++;
      throw new Error("Should not import");
    };
    for (const name of ["e2b", "vercel", "daytona"])
      expect(await loadProvider(name, {}, importer)).toMatchObject({
        kind: "skipped",
        note: expect.stringContaining("Missing credentials"),
      });
    expect(imports).toBe(0);
  });
  it("requires all Vercel credential fields, including nonblank team/project", async () => {
    expect(await loadProvider("vercel", { VERCEL_TOKEN: "test", VERCEL_TEAM_ID: " " })).toEqual({
      kind: "skipped",
      name: "vercel",
      note: "Missing credentials: VERCEL_TEAM_ID, VERCEL_PROJECT_ID",
    });
  });
  it("skips absent packages/exports, but surfaces broken factories", async () => {
    expect(
      await loadProvider("local", {}, async () => {
        throw new Error("Not exported");
      }),
    ).toMatchObject({ kind: "skipped", note: expect.stringContaining("unavailable") });
    expect(await loadProvider("local", {}, async () => ({}))).toMatchObject({
      kind: "skipped",
      note: expect.stringContaining("local()"),
    });
    await expect(
      loadProvider("local", {}, async () => ({
        local() {
          throw new Error("Invalid image");
        },
      })),
    ).rejects.toThrow("Invalid image");
  });
  it("loads memory dynamically and rejects unknown provider names without importing", async () => {
    expect(await loadProvider("memory", {})).toMatchObject({
      kind: "ready",
      name: "memory",
      cloud: false,
    });
    expect(
      await loadProvider("mystery", {}, async () => {
        throw new Error("No");
      }),
    ).toMatchObject({ kind: "skipped", note: expect.stringContaining("credential policy") });
  });
});
describe("safety", () => {
  it("counts all cloud creations including warmups before running", () => {
    const providers = [{ ...ready(), name: "e2b", cloud: true }, ready()];
    const config = { runs: 20, warmup: 2, "max-sandboxes": 21, yes: false };
    expect(() => checkBudget(providers, config)).toThrow("22 cloud sandboxes");
    expect(checkBudget(providers, { ...config, yes: true })).toBe(22);
    expect(checkBudget(providers, { ...config, "max-sandboxes": 22 })).toBe(22);
  });
  it("rejects invalid CLI values", () => {
    for (const args of [
      ["--runs", "0"],
      ["--concurrency", "33"],
      ["--timeout-ms", "NaN"],
      ["--providers", "../../bad"],
      ["--warmup", "-1"],
    ])
      expect(() => parseConfig(args)).toThrow();
  });
  it("bounds active workers and aborts timed-out actions", async () => {
    let active = 0,
      peak = 0;
    await pool(7, 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    });
    expect(peak).toBe(2);
    expect(active).toBe(0);
    let signal: AbortSignal | undefined;
    await expect(
      deadline(5, async (value) => {
        signal = value;
        await new Promise(() => {});
      }),
    ).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
  });
  it("destroys sandboxes after failed first commands", async () => {
    const loaded = ready();
    const original = loaded.provider.exec;
    loaded.provider.exec = (id, input) =>
      input.command === "true"
        ? Promise.resolve({ exitCode: 1, timedOut: false })
        : original(id, input);
    const report = await measureProvider(loaded, parseConfig(["--runs", "1", "--warmup", "0"]));
    expect(report.metrics.find((metric) => metric.scenario === "cold")?.failures).toHaveLength(1);
    expect(report.metrics.find((metric) => metric.scenario === "destroy")?.stats.count).toBe(1);
    expect(await loaded.provider.list({})).toEqual([]);
  });
  it("excludes warmups and skips fake HTTP without counting failures", async () => {
    const loaded = ready();
    const report = await measureProvider(
      loaded,
      parseConfig(["--runs", "2", "--warmup", "1", "--concurrency", "2"]),
    );
    expect(report.metrics.find((metric) => metric.scenario === "cold")?.stats.count).toBe(2);
    expect(
      report.metrics.find((metric) => metric.scenario === "preview-first-byte")?.skipped,
    ).toHaveLength(2);
    expect(report.metrics.every((metric) => metric.failures.length === 0)).toBe(true);
    expect(await loaded.provider.list({})).toEqual([]);
  });
  it("cleans up after a hanging command hits its deadline", async () => {
    const loaded = ready();
    const original = loaded.provider.exec;
    loaded.provider.exec = (id, input) =>
      input.command === "true" ? new Promise(() => {}) : original(id, input);
    const report = await measureProvider(
      loaded,
      parseConfig(["--runs", "1", "--warmup", "0", "--timeout-ms", "100"]),
    );
    expect(report.metrics.find((metric) => metric.scenario === "cold")?.failures[0]).toContain(
      "timed out",
    );
    expect(report.metrics.find((metric) => metric.scenario === "destroy")?.stats.count).toBe(1);
    expect(await loaded.provider.list({})).toEqual([]);
  });
  it("retries failed destruction and reports the measured failure", async () => {
    const loaded = ready();
    const original = loaded.provider.destroy;
    let attempts = 0;
    loaded.provider.destroy = async (id) => {
      if (++attempts === 1) throw new Error("Temporary delete failure");
      await original(id);
    };
    const report = await measureProvider(loaded, parseConfig(["--runs", "1", "--warmup", "0"]));
    expect(attempts).toBe(2);
    expect(report.metrics.find((metric) => metric.scenario === "destroy")?.failures).toHaveLength(
      1,
    );
    expect(report.cleanupFailures).toEqual([]);
    expect(await loaded.provider.list({})).toEqual([]);
  });
});

describe("late resources", () => {
  it("tracks a native creation that arrives after abort and reports failed cleanup IDs", async () => {
    const loaded = ready();
    const originalCreate = loaded.provider.create;
    const originalDestroy = loaded.provider.destroy;
    let id = "";
    loaded.provider.create = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const info = await originalCreate({ ...input, signal: undefined });
      id = info.id;
      return info;
    };
    loaded.provider.destroy = async () => {
      throw new Error("Delete unavailable");
    };
    const report = await measureProvider(
      loaded,
      parseConfig(["--runs", "2", "--warmup", "0", "--timeout-ms", "50"]),
    );
    expect(id).not.toBe("");
    expect(report.cleanupFailures.join(" ")).toContain(id);
    expect((await loaded.provider.list({})).map((info) => info.id)).toEqual([id]);
    await originalDestroy(id);
  });
  it("drains timed-out writes before releasing a concurrency slot or measuring CPU", async () => {
    const loaded = ready();
    const original = loaded.provider.files.write;
    let active = 0,
      peak = 0;
    loaded.provider.files.write = async (id, path, bytes) => {
      if (!path.endsWith("bench-1024.bin")) return original(id, path, bytes);
      active++;
      peak = Math.max(active, peak);
      try {
        await new Promise((resolve) => setTimeout(resolve, 120));
        await original(id, path, bytes);
      } finally {
        active--;
      }
    };
    const report = await measureProvider(
      loaded,
      parseConfig(["--runs", "3", "--warmup", "0", "--timeout-ms", "50"]),
    );
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(report.metrics.find((metric) => metric.scenario === "files-1kb")?.failures).toHaveLength(
      3,
    );
    expect(report.cleanupFailures).toEqual([]);
    expect(await loaded.provider.list({})).toEqual([]);
  });
  it("disposes a CPU fixture that arrives after its setup deadline", async () => {
    const { overheadHooks } = await import("../src/overhead.js");
    const original = overheadHooks.memory;
    let acquired = false,
      disposed = false;
    overheadHooks.memory = async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      acquired = true;
      return {
        sdkCall: async () => {},
        rawCall: async () => {},
        dispose: async () => {
          disposed = true;
        },
      };
    };
    try {
      const report = await measureProvider(
        ready(),
        parseConfig(["--runs", "1", "--warmup", "0", "--timeout-ms", "50"]),
      );
      expect(acquired).toBe(true);
      expect(disposed).toBe(true);
      expect(report.metrics.find((metric) => metric.scenario === "sdk-cpu")?.failures).toHaveLength(
        1,
      );
      expect(report.cleanupFailures).toEqual([]);
    } finally {
      if (original) overheadHooks.memory = original;
      else delete overheadHooks.memory;
    }
  });
});
