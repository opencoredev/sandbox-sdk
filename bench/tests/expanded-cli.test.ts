import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { afterEach, describe, expect, it } from "vitest";
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
  scenarioIds: z.array(z.string()),
  samples: z.array(z.object({ scenarioId: z.string(), provider: z.string(), value: z.number() })),
  failures: z.array(z.object({ scenarioId: z.string(), reason: z.string() })),
  cleanupErrors: z.array(z.unknown()),
});

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
      },
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
      await expandedCommand(
        ["--providers", "memory,missing", "--runs", "2", "--out", out],
        async (name) =>
          name === "memory"
            ? { kind: "ready", name, cloud: false, region: null, provider: memory() }
            : { kind: "skipped", name, note: "no credentials" },
        [fakeFiles, fakeBroken],
      );

      const results = resultsFile.parse(
        JSON.parse(readFileSync(join(out, "results.json"), "utf8")),
      );

      const site = siteFile.parse(JSON.parse(readFileSync(join(out, "site-data.json"), "utf8")));

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
      // A failed sample fails the run.
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
