import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  catalogTable,
  expandedCommand,
  parseExpandedArgs,
  selectScenarios,
} from "../src/expanded/cli.js";
import { buildScenarios } from "../src/expanded/builds.js";
import { filesystemScenarios } from "../src/expanded/filesystem.js";
import { runtimeScenarios } from "../src/expanded/runtime.js";
import type { LoadedProvider } from "../src/providers.js";
import { bound } from "./native-fakes.js";
import type { ExpandedScenario, VerifyResult } from "../src/expanded/types.js";

const catalog = [...filesystemScenarios, ...buildScenarios, ...runtimeScenarios];

function verifyFake(raw: string, seed: number): VerifyResult {
  return raw === `ok:${seed}`
    ? { ok: true, value: 10, proof: `fake-proof:${seed}` }
    : { ok: false, reason: "wrong file content" };
}

const fakeFiles: ExpandedScenario = {
  id: "fake-files",
  category: "filesystem",
  label: "Fake file round trip",
  description: "Writes one seeded file and reads it back.",
  unit: "files/s",
  better: "higher",
  verifyOutput: verifyFake,
  async run(box, ctx) {
    await box.files.write("/workspace/fake.txt", `ok:${ctx.seed}`);
    const result = verifyFake(await box.files.read("/workspace/fake.txt"), ctx.seed);

    if (!result.ok) throw new Error(result.reason);

    return { value: result.value, proof: result.proof };
  },
};

const fakeBroken: ExpandedScenario = {
  ...fakeFiles,
  id: "fake-broken",
  category: "runtime",
  async run() {
    throw new Error("guest exploded");
  },
};

const resultsFile = z.object({
  runId: z.string(),
  finishedAt: z.string(),
  interrupted: z.enum(["SIGINT", "SIGTERM"]).nullable(),
  scenarioIds: z.array(z.string()),
  samples: z.array(z.object({ scenarioId: z.string(), provider: z.string(), value: z.number() })),
  failures: z.array(z.object({ scenarioId: z.string(), reason: z.string() })),
  cleanupErrors: z.array(
    z.object({
      provider: z.string(),
      sandboxId: z.string().nullable(),
      sample: z.object({ scenarioId: z.string(), run: z.number() }).nullable(),
      reason: z.string(),
    }),
  ),
});

const journalFile = z.object({
  runId: z.string(),
  connectionFingerprints: z.record(z.string(), z.string()),
  resources: z.array(
    z.object({ provider: z.string(), id: z.string(), kind: z.literal("sandbox") }),
  ),
});

function readJson<T>(schema: z.ZodType<T>, path: string): T {
  return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * A `load` that hands out `provider` for "memory" and skips every other name. It binds the
 * provider's connection as `loadProvider` does, so the run can journal its fingerprint.
 */
function loadMemory(provider = memory()) {
  return async (name: string): Promise<LoadedProvider> =>
    name === "memory"
      ? { kind: "ready", name, cloud: false, region: null, provider: bound(provider) }
      : { kind: "skipped", name, note: "no credentials" };
}

const siteFile = z.object({
  scenarioCount: z.number(),
  metrics: z.array(
    z.object({
      id: z.string(),
      values: z.array(z.object({ provider: z.string(), n: z.number() })),
    }),
  ),
});

describe("expanded CLI", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  it("parses providers, selections and numbers", () => {
    expect(
      parseExpandedArgs([
        "--providers",
        "local, e2b",
        "--scenarios",
        "fs-sqlite-oltp,build-git-workflow",
        "--categories",
        "filesystem,builds",
        "--runs",
        "3",
        "--out",
        "/tmp/x",
      ]),
    ).toEqual({
      kind: "run",
      args: {
        providers: ["local", "e2b"],
        scenarios: ["fs-sqlite-oltp", "build-git-workflow"],
        categories: ["filesystem", "builds"],
        runs: 3,
        timeoutMs: 120_000,
        out: "/tmp/x",
        force: false,
      },
    });
    expect(parseExpandedArgs(["--providers", "local", "--force"])).toMatchObject({
      args: { force: true },
    });
    expect(parseExpandedArgs(["--list"])).toEqual({ kind: "list" });
  });

  it("refuses missing providers, bad numbers, unknown categories and unknown flags", () => {
    expect(() => parseExpandedArgs([])).toThrow(/providers/);
    expect(() => parseExpandedArgs(["--providers", "local", "--runs", "0"])).toThrow(/runs/);
    expect(() => parseExpandedArgs(["--providers", "local", "--runs", "two"])).toThrow(/runs/);
    expect(() => parseExpandedArgs(["--providers", "local", "--categories", "gpu"])).toThrow();
    expect(() => parseExpandedArgs(["--providers", "local", "--seed", "1"])).toThrow();
  });

  it("selects by id and category, in catalog order", () => {
    expect(selectScenarios(catalog, ["all"], undefined)).toHaveLength(12);
    expect(selectScenarios(catalog, ["all"], ["builds"]).map((s) => s.id)).toEqual(
      buildScenarios.map((s) => s.id),
    );

    expect(
      selectScenarios(catalog, ["runtime-env-isolation", "fs-sqlite-oltp"], undefined).map(
        (s) => s.id,
      ),
    ).toEqual(["fs-sqlite-oltp", "runtime-env-isolation"]);
    expect(() => selectScenarios(catalog, ["nope"], undefined)).toThrow(/nope/);
    expect(() => selectScenarios(catalog, ["fs-sqlite-oltp"], ["runtime"])).toThrow(/No expanded/);
  });

  it("lists every scenario in the catalog table", () => {
    const table = catalogTable(catalog);

    for (const scenario of catalog) expect(table).toContain(scenario.id);
    expect(table.trimEnd().endsWith("12 scenarios")).toBe(true);
  });

  it("runs each sample on a fresh sandbox and writes results and site data", async () => {
    const out = mkdtempSync(join(tmpdir(), "bench-expanded-cli-"));

    try {
      await expandedCommand(["--providers", "memory,missing", "--runs", "2", "--out", out], {
        load: loadMemory(),
        catalog: [fakeFiles, fakeBroken],
      });

      const results = readJson(resultsFile, join(out, "results.json"));
      const site = readJson(siteFile, join(out, "site-data.json"));

      expect(results.samples.map((s) => [s.scenarioId, s.provider, s.value])).toEqual([
        ["fake-files", "memory", 10],
        ["fake-files", "memory", 10],
      ]);
      expect(results.failures).toHaveLength(2);
      expect(results.failures[0]?.reason).toContain("guest exploded");
      expect(results.cleanupErrors).toEqual([]);
      expect(site.scenarioCount).toBe(2);
      expect(site.metrics.find((m) => m.id === "fake-files")?.values).toEqual([
        expect.objectContaining({ provider: "memory", n: 2 }),
      ]);
      expect(results.interrupted).toBeNull();
      // A failed sample fails the run.
      expect(process.exitCode).toBe(1);
      // Every file was replaced through a renamed temporary, and none is left behind.
      expect(readdirSync(out).sort()).toEqual(["ownership.json", "results.json", "site-data.json"]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("journals each live sandbox for reap and drops it once destroyed", async () => {
    const out = mkdtempSync(join(tmpdir(), "bench-expanded-cli-"));
    const journaledDuringRun: string[][] = [];

    const watched: ExpandedScenario = {
      ...fakeFiles,
      async run(box, ctx) {
        const journal = readJson(journalFile, join(out, "ownership.json"));
        journaledDuringRun.push(journal.resources.map((r) => `${r.provider}/${r.id}`));
        expect(journal.resources).toContainEqual(expect.objectContaining({ id: box.id }));

        return fakeFiles.run(box, ctx);
      },
    };

    try {
      await expandedCommand(["--providers", "memory", "--runs", "2", "--out", out], {
        load: loadMemory(),
        catalog: [watched],
      });

      const results = readJson(resultsFile, join(out, "results.json"));
      const journal = readJson(journalFile, join(out, "ownership.json"));

      expect(results.failures).toEqual([]);
      // One sandbox live at a time, each under the run's id.
      expect(journaledDuringRun.map((ids) => ids.length)).toEqual([1, 1]);
      expect(journal.runId).toBe(results.runId);
      expect(journal.resources).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses an --out whose journal still lists another run's sandboxes, unless --force", async () => {
    const out = mkdtempSync(join(tmpdir(), "bench-expanded-cli-"));

    writeFileSync(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "expanded-earlier",
        connectionFingerprints: {},
        resources: [{ provider: "memory", id: "left-behind", kind: "sandbox", parent: null }],
        apps: [],
      }),
    );

    try {
      const argv = ["--providers", "memory", "--out", out];
      const dependencies = { load: loadMemory(), catalog: [fakeFiles] };

      await expect(expandedCommand(argv, dependencies)).rejects.toThrow(/Reap that run first/);
      await expandedCommand([...argv, "--force"], dependencies);

      expect(readJson(resultsFile, join(out, "results.json")).samples).toHaveLength(1);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("keeps a sandbox journaled after its delete is acknowledged, until a lookup sees it gone", async () => {
    const out = mkdtempSync(join(tmpdir(), "bench-expanded-cli-"));
    const backing = memory();
    const journaledAfterAck: string[][] = [];

    // The delete is acknowledged at once and lands 400 ms later, as on providers that delete
    // asynchronously. At 200 ms the journal must still list the sandbox.
    const provider = {
      ...backing,
      async destroy(id: string) {
        setTimeout(() => {
          journaledAfterAck.push(
            readJson(journalFile, join(out, "ownership.json")).resources.map((r) => r.id),
          );
        }, 200);
        setTimeout(() => void backing.destroy(id), 400);
      },
    };

    try {
      await expandedCommand(["--providers", "memory", "--out", out], {
        load: loadMemory(provider),
        catalog: [fakeFiles],
      });

      const results = readJson(resultsFile, join(out, "results.json"));

      expect(journaledAfterAck).toEqual([[expect.any(String)]]);
      expect(results.samples).toHaveLength(1);
      expect(results.cleanupErrors).toEqual([]);
      expect(readJson(journalFile, join(out, "ownership.json")).resources).toEqual([]);
      expect(await backing.list({})).toEqual([]);
      expect(process.exitCode).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("reports a sandbox whose acknowledged delete never lands, and leaves it journaled", async () => {
    const out = mkdtempSync(join(tmpdir(), "bench-expanded-cli-"));
    const backing = memory();
    // Acknowledges every delete and never deletes anything.
    const provider = { ...backing, destroy: vi.fn(async () => {}) };

    try {
      await expandedCommand(["--providers", "memory", "--timeout-ms", "1000", "--out", out], {
        load: loadMemory(provider),
        catalog: [fakeFiles],
      });

      const results = readJson(resultsFile, join(out, "results.json"));
      const live = await backing.list({});

      expect(live).toHaveLength(1);
      expect(results.cleanupErrors).toEqual([
        {
          provider: "memory",
          sandboxId: live[0]?.id,
          sample: expect.objectContaining({ scenarioId: "fake-files", run: 1 }),
          reason: expect.stringMatching(/deletion not confirmed.*present/),
        },
      ]);
      expect(readJson(journalFile, join(out, "ownership.json")).resources).toEqual([
        expect.objectContaining({ provider: "memory", id: live[0]?.id }),
      ]);
      // The sample's own cleanup and the final sweep each sent a delete.
      expect(provider.destroy).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("final sweep deletes a run-labeled sandbox the run never journaled", async () => {
    const out = mkdtempSync(join(tmpdir(), "bench-expanded-cli-"));
    const provider = memory();

    // A sandbox whose create response the run never saw: only the run's label marks it.
    const strays: ExpandedScenario = {
      ...fakeFiles,
      async run(box, ctx) {
        const { runId } = readJson(journalFile, join(out, "ownership.json"));
        await createSandbox(provider, { labels: { "sandbox-bench-run": runId } });

        return fakeFiles.run(box, ctx);
      },
    };

    try {
      await expandedCommand(["--providers", "memory", "--out", out], {
        load: loadMemory(provider),
        catalog: [strays],
      });

      const results = readJson(resultsFile, join(out, "results.json"));

      expect(results.cleanupErrors).toEqual([]);
      expect(await provider.list({})).toEqual([]);
      expect(readJson(journalFile, join(out, "ownership.json")).resources).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("on SIGINT destroys the live sandbox, starts nothing more and exits 130", async () => {
    const out = mkdtempSync(join(tmpdir(), "bench-expanded-cli-"));
    const provider = memory();
    const signals = new EventEmitter();

    const interrupted: ExpandedScenario = {
      ...fakeFiles,
      async run(box) {
        signals.emit("SIGINT", "SIGINT");
        // The handler destroys this sandbox while the scenario is still running.
        await vi.waitFor(async () => expect(await provider.list({})).toEqual([]));
        await box.files.read("/workspace/fake.txt");

        throw new Error("the sandbox survived the interrupt");
      },
    };

    try {
      await expandedCommand(["--providers", "memory", "--runs", "3", "--out", out], {
        load: loadMemory(provider),
        catalog: [interrupted, fakeFiles],
        signals,
      });

      const results = readJson(resultsFile, join(out, "results.json"));

      expect(results.interrupted).toBe("SIGINT");
      expect(results.samples).toEqual([]);
      expect(results.failures).toEqual([
        expect.objectContaining({
          scenarioId: "fake-files",
          reason: expect.stringMatching(/^interrupted by SIGINT/),
        }),
      ]);
      expect(results.failures[0]?.reason).not.toMatch(/survived/);
      expect(results.cleanupErrors).toEqual([]);
      expect(readJson(journalFile, join(out, "ownership.json")).resources).toEqual([]);
      expect(await provider.list({})).toEqual([]);
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(process.exitCode).toBe(130);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
