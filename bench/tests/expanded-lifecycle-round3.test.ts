import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { CreateInput, Labels, Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { admissionRefusal, expandedCommand } from "../src/expanded/cli.js";
import type { ExpandedScenario } from "../src/expanded/types.js";
import type { LoadedProvider } from "../src/providers.js";
import { bound, boundFake } from "./native-fakes.js";

const fakeFiles: ExpandedScenario = {
  id: "fake-files",
  category: "filesystem",
  label: "Fake file round trip",
  description: "Writes one seeded file and reads it back.",
  unit: "files/s",
  better: "higher",
  verifyOutput: (raw, seed) =>
    raw === "ok:" + seed
      ? { ok: true, value: 10, proof: "fake-proof:" + seed }
      : { ok: false, reason: "wrong file content" },
  async run(box, ctx) {
    await box.files.write("/workspace/fake.txt", "ok:" + ctx.seed);
    const result = this.verifyOutput(await box.files.read("/workspace/fake.txt"), ctx.seed);

    if (!result.ok) throw new Error(result.reason);

    return { value: result.value, proof: result.proof };
  },
};

const resultsFile = z.object({
  samples: z.array(z.object({ provider: z.string() })),
  cleanupErrors: z.array(z.object({ sandboxId: z.string().nullable(), reason: z.string() })),
});

function readJson<T>(schema: z.ZodType<T>, path: string): T {
  return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** A `load` that hands out `provider` under its own name and skips every other name. */
function loadOnly(provider: Provider) {
  return async (name: string): Promise<LoadedProvider> =>
    name === provider.name
      ? { kind: "ready", name, cloud: false, region: null, provider }
      : { kind: "skipped", name, note: "no credentials" };
}

/**
 * A memory provider whose second create allocates a sandbox the listing never shows, then throws
 * `error` without naming it. Its listing is stale: it still shows every sandbox ever listed,
 * deleted ones included, with their labels.
 */
function staleListing(error: SandboxError) {
  const backing = memory();
  const seen = new Map<string, SandboxInfo>();
  let creates = 0;

  const provider = {
    ...backing,
    async create(input: CreateInput) {
      const info = await backing.create(input);

      if (++creates === 2) throw error;
      seen.set(info.id, info);

      return info;
    },
    async list(labels: Labels) {
      for (const info of await backing.list({})) if (seen.has(info.id)) seen.set(info.id, info);

      return [...seen.values()].filter((info) =>
        Object.entries(labels).every(([key, value]) => info.labels[key] === value),
      );
    },
  };

  return { backing, provider };
}

describe("expanded run lifecycle, round 3", () => {
  let out = "";

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;

    if (out) rmSync(out, { recursive: true, force: true });
    out = "";
  });

  const freshOut = () => (out = mkdtempSync(join(tmpdir(), "bench-expanded-lifecycle3-")));

  it("admits an adapter only when its label attaches at allocation or its expiry deletes it", () => {
    const atAllocation = [
      "memory",
      "local",
      "tenki",
      "upstash",
      "e2b",
      "daytona",
      "baseten",
      "freestyle",
      "styne",
      "maritime",
      "instabox",
      "superserve",
      "modal",
      "vercel",
    ];

    for (const adapter of [...atAllocation, "boxd", "beam"])
      expect(admissionRefusal(adapter, 120_000)).toBeNull();

    for (const adapter of ["boat", "archil"])
      expect(admissionRefusal(adapter, 120_000)).toMatch(
        /^Labels arrive after create and expiry does not delete/,
      );
  });

  it("skips Boat before any create and says why in the run output", async () => {
    freshOut();
    const backing = memory();
    const create = vi.fn((input: CreateInput) => backing.create(input));
    const boat = boundFake({ ...backing, name: "boat", create });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expandedCommand(["--providers", "boat", "--out", out], {
      load: loadOnly(boat),
      catalog: [fakeFiles],
    });

    const printed = output.mock.calls.map(([text]) => String(text)).join("");
    output.mockRestore();

    expect(create).not.toHaveBeenCalled();
    expect(printed).toContain("SKIP boat: Labels arrive after create and expiry does not delete");
  });

  it("never settles an unnamed create with a sandbox a stale listing still shows after it was gone", async () => {
    freshOut();

    const { backing, provider } = staleListing(
      new SandboxError("Machine creation outcome is unknown", { code: "outcome_unknown" }),
    );

    await expandedCommand(
      ["--providers", "memory", "--runs", "2", "--timeout-ms", "1000", "--out", out],
      {
        load: loadOnly(bound(provider)),
        catalog: [fakeFiles],
      },
    );

    const results = readJson(resultsFile, join(out, "results.json"));

    expect(results.samples).toHaveLength(1);
    expect(results.cleanupErrors).toEqual([
      { sandboxId: null, reason: expect.stringMatching(/1 failed create\(s\) named no sandbox/) },
    ]);
    // The unnamed allocation is still there, out of every listing.
    expect(await backing.list({})).toHaveLength(1);
    expect(existsSync(join(out, "run.json"))).toBe(true);
  });

  it.each(["auth", "quota"] as const)(
    "keeps owing cleanup after a %s error that names no sandbox, as boxd raises after allocating",
    async (code) => {
      freshOut();
      const backing = memory();

      const failing = {
        ...backing,
        async create(input: CreateInput): Promise<never> {
          await backing.create(input);

          throw new SandboxError("Setup failed after allocation", { code });
        },
        list: async () => [],
      };

      await expandedCommand(["--providers", "memory", "--timeout-ms", "1000", "--out", out], {
        load: loadOnly(bound(failing)),
        catalog: [fakeFiles],
      });

      expect(readJson(resultsFile, join(out, "results.json")).cleanupErrors).toEqual([
        { sandboxId: null, reason: expect.stringMatching(/1 failed create\(s\) named no sandbox/) },
      ]);
      expect(existsSync(join(out, "run.json"))).toBe(true);
      expect(process.exitCode).toBe(1);
    },
  );

  describe("--force", () => {
    const dependencies = () => ({ load: loadOnly(bound(memory())), catalog: [fakeFiles] });
    const forced = () => ["--providers", "memory", "--out", out, "--force"];
    const exited = () => spawnSync("true").pid;

    it.each([
      ["a v2-style claim with only a run id", JSON.stringify({ runId: "v2-live" })],
      ["a claim without a host", JSON.stringify({ runId: "x", pid: 1 })],
      ["a claim from another host", JSON.stringify({ runId: "x", pid: 1, host: "elsewhere" })],
      ["an unreadable claim", "{ not json"],
    ])("refuses to take over %s", async (_case, text) => {
      freshOut();
      writeFileSync(join(out, "run.json"), text);

      await expect(expandedCommand(forced(), dependencies())).rejects.toThrow(/still alive/);
      expect(readFileSync(join(out, "run.json"), "utf8")).toBe(text);
    });

    it("refuses another host's claim even when its pid does not exist here", async () => {
      freshOut();
      const text = JSON.stringify({ runId: "x", pid: exited(), host: "elsewhere" });
      writeFileSync(join(out, "run.json"), text);

      await expect(expandedCommand(forced(), dependencies())).rejects.toThrow(/still alive/);
      expect(readFileSync(join(out, "run.json"), "utf8")).toBe(text);
    });

    it("takes over a complete same-host claim whose pid is gone", async () => {
      freshOut();
      writeFileSync(
        join(out, "run.json"),
        JSON.stringify({ runId: "expanded-died", pid: exited(), host: hostname() }),
      );

      await expandedCommand(forced(), dependencies());

      expect(readJson(resultsFile, join(out, "results.json")).samples).toHaveLength(1);
      expect(existsSync(join(out, "run.json"))).toBe(false);
    });
  });
});
