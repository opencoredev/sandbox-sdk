import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { CreateInput, Labels, Provider } from "@opencoredev/sandbox-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { admissionRefusal, expandedCommand } from "../src/expanded/cli.js";
import type { ExpandedScenario } from "../src/expanded/types.js";
import { lookupSandbox } from "../src/existence.js";
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
  runId: z.string(),
  providers: z.array(z.object({ name: z.string(), kind: z.string(), note: z.string() })),
  samples: z.array(z.object({ provider: z.string() })),
  failures: z.array(z.object({ reason: z.string() })),
  cleanupErrors: z.array(z.object({ sandboxId: z.string().nullable(), reason: z.string() })),
});

const journalFile = z.object({
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

/** `backing.list` without the IDs `hidden` names, filtered by `labels`. */
function listWithout(backing: Provider, hidden: (id: string, labels: Labels) => boolean) {
  return async (labels: Labels) =>
    (await backing.list(labels)).filter((info) => !hidden(info.id, labels));
}

/**
 * A memory provider whose create allocates a sandbox and then throws `error(id)`, as a create
 * whose response was lost or failed after allocation does.
 */
function failingAfterAllocation(error: (id: string) => SandboxError) {
  const backing = memory();
  const allocated: string[] = [];

  const provider = {
    ...backing,
    async create(input: CreateInput) {
      const info = await backing.create(input);
      allocated.push(info.id);

      throw error(info.id);
    },
  };

  return { backing, allocated, provider };
}

const outcomeUnknown = () =>
  new SandboxError("Machine creation outcome is unknown", { code: "outcome_unknown" });

describe("expanded run lifecycle, round 2", () => {
  let out = "";

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.exitCode = 0;

    if (out) rmSync(out, { recursive: true, force: true });
    out = "";
  });

  const freshOut = () => (out = mkdtempSync(join(tmpdir(), "bench-expanded-lifecycle2-")));
  const argv = () => ["--providers", "memory", "--timeout-ms", "1000", "--out", out];

  it("refuses adapters whose leftovers no lifetime ends, or whose deletes no lookup confirms", () => {
    // Railway writes its marker after allocation and refuses timeoutMs; Archil's expiry only
    // pauses a sandbox, out of list(); AgentOS has no exact lookup.
    for (const adapter of ["railway", "archil", "agentos", "sandboxer"])
      expect(admissionRefusal(adapter, 120_000)).toEqual(expect.any(String));

    // boxd's deleteAfter deletes the machine and Beam's lifetime stops it, its own delete.
    for (const adapter of ["boxd", "beam", "e2b", "daytona", "local", "memory", "upstash"])
      expect(admissionRefusal(adapter, 120_000)).toBeNull();
  });

  it.each(["railway", "agentos"])("skips %s before any create", async (name) => {
    freshOut();
    const backing = memory();
    const create = vi.fn((input: CreateInput) => backing.create(input));
    const provider = boundFake({ ...backing, name, create });

    await expandedCommand(["--providers", name, "--out", out], {
      load: loadOnly(provider),
      catalog: [fakeFiles],
    });

    expect(create).not.toHaveBeenCalled();
    expect(readJson(resultsFile, join(out, "results.json")).providers).toEqual([
      { name, kind: "skipped", note: expect.stringMatching(/No exact read-only lookup/) },
    ]);
  });

  it("finds no exact lookup for AgentOS, so a delete there could never be confirmed", async () => {
    const evidence = await lookupSandbox(bound({ ...memory(), name: "agentos" }), "any", 1000);

    expect(evidence.result).toBe("unavailable");
  });

  it("ends owing cleanup, claim kept, after a create that named no sandbox the listing does not show", async () => {
    freshOut();
    const { backing, allocated, provider } = failingAfterAllocation(outcomeUnknown);
    const hidden = bound({ ...provider, list: listWithout(backing, () => true) });

    await expandedCommand(argv(), { load: loadOnly(hidden), catalog: [fakeFiles] });

    const results = readJson(resultsFile, join(out, "results.json"));

    expect(allocated).toHaveLength(1);
    expect(results.cleanupErrors).toEqual([
      { sandboxId: null, reason: expect.stringMatching(/1 failed create\(s\) named no sandbox/) },
    ]);
    expect(existsSync(join(out, "run.json"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("settles a create that named no sandbox once the final sweep finds one and sees it gone", async () => {
    freshOut();
    const { backing, provider } = failingAfterAllocation(outcomeUnknown);

    await expandedCommand(argv(), { load: loadOnly(bound(provider)), catalog: [fakeFiles] });

    expect(readJson(resultsFile, join(out, "results.json")).cleanupErrors).toEqual([]);
    expect(await backing.list({})).toEqual([]);
    expect(existsSync(join(out, "run.json"))).toBe(false);
  });

  it("owes nothing for a create the provider refused", async () => {
    freshOut();

    const refused = {
      ...memory(),
      async create(): Promise<never> {
        throw new SandboxError("Quota exceeded", { code: "quota" });
      },
    };

    await expandedCommand(argv(), { load: loadOnly(bound(refused)), catalog: [fakeFiles] });

    const results = readJson(resultsFile, join(out, "results.json"));

    expect(results.failures).toHaveLength(1);
    expect(results.cleanupErrors).toEqual([]);
    expect(existsSync(join(out, "run.json"))).toBe(false);
  });

  it("journals and deletes by ID a sandbox a failed create named", async () => {
    freshOut();
    let journaled: string[] = [];

    const { backing, allocated, provider } = failingAfterAllocation(
      (id) =>
        new SandboxError("Egress allow-list not confirmed", { code: "unsupported", sandboxId: id }),
    );

    // An exact-ID ownership check sees it; the run-label listing alone (one label) lags behind.
    const lagging = bound({
      ...provider,
      list: listWithout(backing, (_id, labels) => labels["sandbox-sdk"] === undefined),
      async destroy(id: string) {
        journaled = readJson(journalFile, join(out, "ownership.json")).resources.map((r) => r.id);

        return backing.destroy(id);
      },
    });

    await expandedCommand(argv(), { load: loadOnly(lagging), catalog: [fakeFiles] });

    expect(journaled).toEqual(allocated);
    expect(await backing.list({})).toEqual([]);
    expect(readJson(resultsFile, join(out, "results.json")).cleanupErrors).toEqual([]);
    expect(readJson(journalFile, join(out, "ownership.json")).resources).toEqual([]);
  });

  it("gives runs started in the same millisecond different labels", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-25T07:00:00.000Z") });
    const outs = [freshOut(), mkdtempSync(join(tmpdir(), "bench-expanded-lifecycle2-"))];

    try {
      for (const dir of outs)
        await expandedCommand(["--providers", "memory", "--out", dir], {
          load: loadOnly(bound(memory())),
          catalog: [fakeFiles],
        });

      const [first, second] = outs.map(
        (dir) => readJson(resultsFile, join(dir, "results.json")).runId,
      );

      expect(first).toMatch(/^expanded-2026-11-25T07-00-00-000Z-[0-9a-f]{8}$/);
      expect(second).not.toBe(first);
    } finally {
      rmSync(outs[1] ?? "", { recursive: true, force: true });
    }
  });

  it("refuses --force while the claim's process is alive, and takes over a dead one's", async () => {
    freshOut();
    const dependencies = { load: loadOnly(bound(memory())), catalog: [fakeFiles] };

    const claim = (pid: number | undefined) =>
      writeFileSync(
        join(out, "run.json"),
        JSON.stringify({ runId: "expanded-other", pid, host: hostname() }),
      );

    claim(process.pid);
    await expect(expandedCommand([...argv(), "--force"], dependencies)).rejects.toThrow(
      /still alive/,
    );
    expect(readFileSync(join(out, "run.json"), "utf8")).toContain("expanded-other");

    const exited = spawnSync("true").pid;
    claim(exited);
    await expandedCommand([...argv(), "--force"], dependencies);

    expect(readJson(resultsFile, join(out, "results.json")).samples).toHaveLength(1);
    expect(existsSync(join(out, "run.json"))).toBe(false);
  });

  it("refuses to claim while another run holds the claim lock", async () => {
    freshOut();
    mkdirSync(join(out, "run.lock"));

    await expect(
      expandedCommand(argv(), { load: loadOnly(bound(memory())), catalog: [fakeFiles] }),
    ).rejects.toThrow(/run\.lock is held/);
    expect(existsSync(join(out, "run.json"))).toBe(false);
  });
});
