import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { CreateInput, Labels, Provider } from "@opencoredev/sandbox-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { connectionProbes } from "../src/connections.js";
import { expandedCommand, sandboxLifetimeMs } from "../src/expanded/cli.js";
import type { ExpandedScenario } from "../src/expanded/types.js";
import type { LoadedProvider } from "../src/providers.js";
import { bound, boundFake, fakeNativeModules } from "./native-fakes.js";

const fakeFiles: ExpandedScenario = {
  id: "fake-files",
  category: "filesystem",
  label: "Fake file round trip",
  description: "Writes one seeded file and reads it back.",
  unit: "files/s",
  better: "higher",
  verifyOutput: (raw, seed) =>
    raw === `ok:${seed}`
      ? { ok: true, value: 10, proof: `fake-proof:${seed}` }
      : { ok: false, reason: "wrong file content" },
  async run(box, ctx) {
    await box.files.write("/workspace/fake.txt", `ok:${ctx.seed}`);
    const result = this.verifyOutput(await box.files.read("/workspace/fake.txt"), ctx.seed);

    if (!result.ok) throw new Error(result.reason);

    return { value: result.value, proof: result.proof };
  },
};

const resultsFile = z.object({
  runId: z.string(),
  providers: z.array(z.object({ name: z.string(), kind: z.string(), note: z.string() })),
  samples: z.array(z.object({ provider: z.string() })),
  failures: z.array(z.object({ reason: z.string() })),
  cleanupErrors: z.array(z.object({ sandboxId: z.string().nullable(), reason: z.string() })),
});

const journalFile = z.object({
  runId: z.string(),
  connectionFingerprints: z.record(z.string(), z.string()),
  resources: z.array(z.object({ provider: z.string(), id: z.string() })),
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

/** Labels the memory provider lists for `id` once another run has taken the ID over. */
const otherRun = (labels: Labels): Labels => ({ ...labels, "sandbox-bench-run": "another-run" });

/** `backing.list`, with the IDs `relabeled` names listed under another run's label. */
function relabeledList(backing: Provider, relabeled: (id: string) => boolean) {
  return async (labels: Labels) =>
    (await backing.list({}))
      .map((info) => (relabeled(info.id) ? { ...info, labels: otherRun(info.labels) } : info))
      .filter((info) => Object.entries(labels).every(([k, v]) => info.labels[k] === v));
}

describe("expanded run lifecycle", () => {
  let out = "";

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;

    if (out) rmSync(out, { recursive: true, force: true });
    out = "";
  });

  const freshOut = () => (out = mkdtempSync(join(tmpdir(), "bench-expanded-lifecycle-")));

  it("skips a provider whose connection fingerprint cannot be read, before any create", async () => {
    freshOut();
    const backing = memory();
    const create = vi.fn((input: CreateInput) => backing.create(input));
    // Docker's /info fails once: the run cannot record which daemon it created on.
    vi.spyOn(connectionProbes, "dockerDaemonId").mockRejectedValue(new Error("EPIPE"));
    const local = bound({ ...backing, name: "local", create });

    await expandedCommand(["--providers", "local", "--out", out], {
      load: loadOnly(local),
      catalog: [fakeFiles],
    });

    const results = readJson(resultsFile, join(out, "results.json"));

    expect(create).not.toHaveBeenCalled();
    expect(results.providers).toEqual([
      { name: "local", kind: "skipped", note: expect.stringMatching(/No connection fingerprint/) },
    ]);
    expect(results.samples).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a second run on an --out whose run has a create in flight", async () => {
    freshOut();
    const backing = memory();
    let allocated = () => {};
    const inFlight = new Promise<void>((resolve) => (allocated = resolve));
    let answer = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));

    // The sandbox exists from here on, but the run has no ID for it until `answered`.
    const slow = bound({
      ...backing,
      async create(input: CreateInput) {
        const info = await backing.create(input);
        allocated();
        await answered;

        return info;
      },
    });

    const first = expandedCommand(["--providers", "memory", "--out", out], {
      load: loadOnly(slow),
      catalog: [fakeFiles],
    });

    await inFlight;
    const { runId } = readJson(journalFile, join(out, "ownership.json"));

    await expect(
      expandedCommand(["--providers", "memory", "--out", out], {
        load: loadOnly(bound(memory())),
        catalog: [fakeFiles],
      }),
    ).rejects.toThrow(/claims this --out for another run/);
    expect(readJson(journalFile, join(out, "ownership.json")).runId).toBe(runId);

    answer();
    await first;

    expect(readJson(resultsFile, join(out, "results.json")).samples).toHaveLength(1);
    expect(await backing.list({})).toEqual([]);
  });

  it("keeps a died run's claim, so its empty journal is overwritten only with --force", async () => {
    freshOut();
    // A run that died after allocating, before its create returned an ID: nothing journaled. Its
    // claim names a pid on this host that no longer exists.
    writeFileSync(
      join(out, "run.json"),
      JSON.stringify({ runId: "expanded-died", pid: spawnSync("true").pid, host: hostname() }),
    );
    writeFileSync(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "expanded-died",
        connectionFingerprints: {},
        resources: [],
        apps: [],
      }),
    );
    const argv = ["--providers", "memory", "--out", out];
    const dependencies = { load: loadOnly(bound(memory())), catalog: [fakeFiles] };

    await expect(expandedCommand(argv, dependencies)).rejects.toThrow(/Reap that run/);
    expect(readJson(journalFile, join(out, "ownership.json")).runId).toBe("expanded-died");

    await expandedCommand([...argv, "--force"], dependencies);
    // A clean finish gives the claim up, so the next run needs no --force.
    expect(existsSync(join(out, "run.json"))).toBe(false);
    await expandedCommand(argv, dependencies);

    expect(readJson(resultsFile, join(out, "results.json")).samples).toHaveLength(1);
  });

  it("keeps the claim of a run that ends with cleanup still owed", async () => {
    freshOut();
    const backing = memory();
    const provider = bound({ ...backing, destroy: vi.fn(async () => {}) });

    await expandedCommand(["--providers", "memory", "--timeout-ms", "1000", "--out", out], {
      load: loadOnly(provider),
      catalog: [fakeFiles],
    });

    expect(readJson(resultsFile, join(out, "results.json")).cleanupErrors).toHaveLength(1);
    expect(existsSync(join(out, "run.json"))).toBe(true);
  });

  it("creates every sandbox with a hard lifetime where the adapter takes one", async () => {
    freshOut();
    const backing = memory();
    const lifetimes: (number | undefined)[] = [];

    // boxd allocates first and writes the run's labels in the guest later: only its own
    // deletion deadline covers a crash in between.
    const boxd = boundFake({
      ...backing,
      name: "boxd",
      async create(input: CreateInput) {
        lifetimes.push(input.timeoutMs);

        return backing.create(input);
      },
    });

    fakeNativeModules({
      "@boxd-sh/sdk": {
        Boxd: class {
          machines = {
            get: vi
              .fn()
              .mockImplementation(async (id: string) =>
                (await backing.list({})).some((info) => info.id === id)
                  ? { id, state: "running" }
                  : { id, state: "deleted" },
              ),
          };
          snapshots = { get: vi.fn(), delete: vi.fn() };
        },
      },
    });

    await expandedCommand(["--providers", "boxd", "--timeout-ms", "1000", "--out", out], {
      load: loadOnly(boxd),
      catalog: [fakeFiles],
    });

    expect(readJson(resultsFile, join(out, "results.json")).samples).toHaveLength(1);
    expect(lifetimes).toEqual([1_500_000]);
    expect(await backing.list({})).toEqual([]);
  });

  it("gives a hard lifetime to every adapter that labels in the guest, none to one that refuses it", () => {
    for (const adapter of ["boxd", "archil", "beam"])
      expect(sandboxLifetimeMs(adapter, 3_600_000)).toBe(4_200_000);

    for (const adapter of ["upstash", "superserve", "boat", "local", "memory"])
      expect(sandboxLifetimeMs(adapter, 120_000)).toBeNull();
  });

  it(
    "bounds a delete that never answers and keeps the sandbox journaled, sending it once",
    { timeout: 15_000 },
    async () => {
      freshOut();
      const backing = memory();
      const destroy = vi.fn(() => new Promise<void>(() => {}));
      const provider = bound({ ...backing, destroy });

      await expandedCommand(["--providers", "memory", "--timeout-ms", "1000", "--out", out], {
        load: loadOnly(provider),
        catalog: [fakeFiles],
      });

      const results = readJson(resultsFile, join(out, "results.json"));
      const live = await backing.list({});

      expect(live).toHaveLength(1);
      expect(results.cleanupErrors).toEqual([
        {
          sandboxId: live[0]?.id,
          reason: expect.stringMatching(/delete still unanswered.*present/),
        },
      ]);
      expect(readJson(journalFile, join(out, "ownership.json")).resources).toEqual([
        expect.objectContaining({ id: live[0]?.id }),
      ]);
      // The final sweep waited on the sample's unsettled delete instead of sending another.
      expect(destroy).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "releases a sandbox whose delete never answers once a lookup finds it gone",
    { timeout: 15_000 },
    async () => {
      freshOut();
      const backing = memory();

      const provider = bound({
        ...backing,
        async destroy(id: string) {
          await backing.destroy(id);
          await new Promise<void>(() => {});
        },
      });

      await expandedCommand(["--providers", "memory", "--timeout-ms", "1000", "--out", out], {
        load: loadOnly(provider),
        catalog: [fakeFiles],
      });

      expect(readJson(resultsFile, join(out, "results.json")).cleanupErrors).toEqual([]);
      expect(readJson(journalFile, join(out, "ownership.json")).resources).toEqual([]);
      expect(process.exitCode).toBe(0);
    },
  );

  it("sends no delete by ID for a sandbox whose exact ID no longer lists with the run's labels", async () => {
    freshOut();
    const backing = memory();
    // Acknowledges every delete and deletes nothing, so the final sweep retries by ID.
    const destroy = vi.fn(async () => {});
    const taken = new Set<string>();

    const provider = bound({
      ...backing,
      destroy,
      list: relabeledList(backing, (id) => taken.has(id)),
    });

    const handedOver: ExpandedScenario = {
      ...fakeFiles,
      async run(box, ctx) {
        taken.add(box.id);

        return fakeFiles.run(box, ctx);
      },
    };

    await expandedCommand(["--providers", "memory", "--timeout-ms", "1000", "--out", out], {
      load: loadOnly(provider),
      catalog: [handedOver],
    });

    const results = readJson(resultsFile, join(out, "results.json"));
    const [id] = taken;

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(results.cleanupErrors).toEqual([
      { sandboxId: id, reason: expect.stringMatching(/no delete sent.*present/) },
    ]);
    expect(readJson(journalFile, join(out, "ownership.json")).resources).toEqual([
      expect.objectContaining({ id }),
    ]);
  });

  it("sends no sweep delete for a listed sandbox whose exact ID then lists under another run", async () => {
    freshOut();
    const backing = memory();
    let stray = "";
    let sweepListed = false;
    const destroy = vi.fn((id: string) => backing.destroy(id));
    const relabel = relabeledList(backing, (id) => id === stray && sweepListed);

    const provider = bound({
      ...backing,
      destroy,
      async list(labels: Labels) {
        const listed = await relabel(labels);

        if (listed.some((info) => info.id === stray)) sweepListed = true;

        return listed;
      },
    });

    // A run-labeled sandbox whose create the run never saw, taken over between the final
    // sweep's listing and its delete.
    const strays: ExpandedScenario = {
      ...fakeFiles,
      async run(box, ctx) {
        const { runId } = readJson(journalFile, join(out, "ownership.json"));
        stray = (await createSandbox(backing, { labels: { "sandbox-bench-run": runId } })).id;

        return fakeFiles.run(box, ctx);
      },
    };

    await expandedCommand(["--providers", "memory", "--timeout-ms", "1000", "--out", out], {
      load: loadOnly(provider),
      catalog: [strays],
    });

    const results = readJson(resultsFile, join(out, "results.json"));

    expect(destroy).not.toHaveBeenCalledWith(stray);
    expect((await backing.list({})).map((info) => info.id)).toEqual([stray]);
    expect(results.cleanupErrors).toEqual([
      { sandboxId: stray, reason: expect.stringMatching(/no delete sent/) },
    ]);
    expect(readJson(journalFile, join(out, "ownership.json")).resources).toEqual([
      expect.objectContaining({ id: stray }),
    ]);
  });
});
