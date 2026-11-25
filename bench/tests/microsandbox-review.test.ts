// The Microsandbox journaling and recovery invariants, against the SDK's own local fake of Microsandbox
// Cloud (packages/sdk/tests/microsandbox-fake.ts) and the real adapter: every allocation is journaled
// before it is sent, and cleanup and recovery settle what a lost answer left.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  microsandbox,
  type MicrosandboxHooks,
  type MicrosandboxProvider,
} from "@opencoredev/sandbox-sdk/microsandbox";

import {
  microsandboxFake,
  type MicrosandboxFake,
} from "../../packages/sdk/tests/microsandbox-fake.js";
import {
  attemptSettlementMs,
  cleanService,
  isDefiniteRefusal,
  settleAllocationAttempt,
  settleMicrosandboxCapture,
} from "../src/microsandbox.js";
import { snapshotProvenanceSchema } from "../src/ownership.js";
import { reapRun } from "../src/recovery.js";
import { deleteProvenSnapshot, inspectSnapshot } from "../src/snapshots.js";
import { parseV2 } from "../src/v2-config.js";
import { runV2 } from "../src/v2-runner.js";

// The built adapter, as runV2 loads it, with the fake's peer: the core and the adapter then share one
// SandboxError class.
const key = "msb_fake_key_0123456789";
let fake: MicrosandboxFake;
const dirs: string[] = [];

beforeAll(async () => {
  fake = await microsandboxFake();
});

afterAll(async () => {
  await fake.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();

  for (const name of Object.keys(fake.faults)) Reflect.deleteProperty(fake.faults, name);
  fake.requests.length = 0;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);

  return dir;
}

function adapter(computeType: "standard" | "shared" = "standard"): MicrosandboxProvider {
  vi.stubEnv("MSB_API_KEY", key);
  vi.stubEnv("MSB_API_URL", fake.url);

  return microsandbox({ apiKey: key, baseUrl: fake.url, computeType, peer: async () => fake.peer });
}

const journalSchema = z.object({
  resources: z.array(
    z.looseObject({
      provider: z.string(),
      id: z.string(),
      kind: z.string(),
      parent: z.string().nullable(),
    }),
  ),
});

const readJournal = async (out: string) =>
  journalSchema.parse(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")));

const runLabels = (run: string, tier = "standard") => ({
  "sandbox-bench-run": run,
  "sandbox-sdk": "1",
  "sandbox-bench-tier": tier,
});

const proofFor = (sourceId: string, run: string) =>
  snapshotProvenanceSchema.parse({
    sourceId,
    runLabel: run,
    sdkLabel: "1",
    verifiedAt: new Date().toISOString(),
  });

describe("runV2 journals every Microsandbox allocation before it is sent", () => {
  it("journals the create and the capture first, restores at CPU and memory only, and leaves nothing", async () => {
    const out = await directory("bench-msb-run-");
    const provider = adapter();
    const atHook: { kind: string; journal: z.infer<typeof journalSchema>; posts: number }[] = [];
    const setHooks = provider.setAttemptHooks.bind(provider);

    // Wrap the bench's own hooks to read the journal on disk the moment each one returns.
    provider.setAttemptHooks = (hooks: MicrosandboxHooks | undefined) =>
      setHooks({
        create: async (attempt) => {
          await hooks?.create?.(attempt);
          atHook.push({
            kind: "create",
            journal: await readJournal(out),
            posts: fake.requests.filter(
              (r) => r.method === "POST" && r.path.startsWith("/v1/sandboxes?"),
            ).length,
          });
        },
        snapshot: async (attempt) => {
          await hooks?.snapshot?.(attempt);
          atHook.push({
            kind: "snapshot",
            journal: await readJournal(out),
            posts: fake.requests.filter((r) => r.path.endsWith("/stop")).length,
          });
        },
        service: async (attempt) => hooks?.service?.(attempt),
      });

    const report = await runV2(
      [{ kind: "ready", name: "microsandbox", cloud: true, region: null, provider }],
      parseV2([
        "--providers",
        "microsandbox",
        "--runs",
        "1",
        "--max-sandboxes",
        "4",
        "--bursts",
        "",
        "--scenarios",
        "snapshot",
        "--size",
        "microsandbox=2:2048:8",
        "--timeout-ms",
        "60000",
        "--out",
        out,
      ]),
      async () => {},
    );

    const creates = atHook.filter((h) => h.kind === "create");

    expect(creates.length).toBeGreaterThanOrEqual(2);

    for (const [index, hook] of creates.entries()) {
      // On disk before the create it names was sent.
      expect(hook.posts).toBe(index);
      expect(hook.journal.resources.some((r) => r.kind === "allocation-attempt")).toBe(true);
    }

    const capture = atHook.find((h) => h.kind === "snapshot");

    expect(capture?.posts).toBe(0);
    expect(
      capture?.journal.resources.some((r) => r.kind === "snapshot" && r.snapshotName === r.id),
    ).toBe(true);

    const posts = fake.requests.filter(
      (r) => r.method === "POST" && r.path.startsWith("/v1/sandboxes?"),
    );

    const bodies = posts.map((p) => JSON.stringify(p.body));

    expect(bodies[0]).toContain('"resources":{"vcpus":2,"memory_mib":2048,"disk_size_mib":8192}');
    expect(bodies[0]).toContain('"sandbox-bench-tier":"standard"');
    expect(bodies.some((b) => b.includes('"source":"disk_snapshot"'))).toBe(true);

    for (const body of bodies.filter((b) => b.includes('"source":"disk_snapshot"'))) {
      expect(body).toContain('"resources":{"vcpus":2,"memory_mib":2048}');
      expect(body).not.toContain("disk_size_mib");
    }

    expect((await readJournal(out)).resources).toEqual([]);
    expect(fake.sandboxes.size).toBe(0);
    expect(fake.snapshots.size).toBe(0);
    expect(report.cleanup.every((c) => c.error === null)).toBe(true);
  }, 120_000);
});

describe("allocation attempts: settled by name, by marker and tier", () => {
  it("reads a fresh 404 as pending and an old one as absent", async () => {
    adapter();
    const attempt = { id: "sbx-never-made", allocId: "a-1", attemptedAt: new Date().toISOString() };

    expect(await settleAllocationAttempt(attempt, "standard")).toMatchObject({ kind: "pending" });
    expect(
      await settleAllocationAttempt(attempt, "standard", Date.now() + attemptSettlementMs + 1),
    ).toEqual({ kind: "absent" });
  });

  it("admits only the attempt's marker on the attempt's tier", async () => {
    const provider = adapter();
    let seen = { name: "", allocId: "" };
    provider.setAttemptHooks({ create: (a) => void (seen = { name: a.name, allocId: a.allocId }) });
    const info = await provider.create({ labels: {} });
    const attempt = { id: seen.name, attemptedAt: new Date().toISOString() };

    expect(
      await settleAllocationAttempt({ ...attempt, allocId: seen.allocId }, "standard"),
    ).toEqual({
      kind: "sandbox",
      id: info.id,
    });
    expect(
      await settleAllocationAttempt({ ...attempt, allocId: "another" }, "standard"),
    ).toMatchObject({
      kind: "pending",
    });
    expect(
      await settleAllocationAttempt({ ...attempt, allocId: seen.allocId }, "shared"),
    ).toMatchObject({ kind: "pending" });
    fake.faults.specNull = 1;
    expect(
      await settleAllocationAttempt({ ...attempt, allocId: seen.allocId }, "standard"),
    ).toMatchObject({ kind: "pending", reason: expect.stringContaining("spec") });
    await provider.destroy(info.id);
  });

  it("reapRun deletes the sandbox an unanswered create made and clears its attempt", async () => {
    const provider = adapter();
    const run = "msb-reap-attempt";
    const out = await directory("bench-msb-reap-");
    let seen = { name: "", allocId: "" };
    provider.setAttemptHooks({ create: (a) => void (seen = { name: a.name, allocId: a.allocId }) });
    const info = await provider.create({ labels: runLabels(run) });

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        resources: [
          {
            provider: "microsandbox",
            id: seen.name,
            kind: "allocation-attempt",
            parent: null,
            allocId: seen.allocId,
            attemptedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    await reapRun(
      [{ kind: "ready", name: "microsandbox", cloud: true, region: null, provider: adapter() }],
      parseV2(["--providers", "microsandbox", "--run", run, "--out", out]),
      (s) => s,
    );

    expect(fake.sandboxes.has(info.id)).toBe(false);
    expect((await readJournal(out)).resources).toEqual([]);
  }, 60_000);

  it("reapRun keeps an unresolved restore attempt, its snapshot and its source", async () => {
    const provider = adapter();
    const run = "msb-reap-restore";
    const out = await directory("bench-msb-restore-");
    const source = await provider.create({ labels: runLabels(run) });
    const snapshot = await provider.snapshot!(source.id);
    const proof = proofFor(source.id, run);

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        resources: [
          {
            provider: "microsandbox",
            id: source.id,
            kind: "snapshot-source",
            parent: null,
            snapshotProof: proof,
          },
          {
            provider: "microsandbox",
            id: snapshot.id,
            kind: "snapshot",
            parent: source.id,
            snapshotProof: proof,
          },
          {
            provider: "microsandbox",
            id: "sbx-restore-not-seen-yet",
            kind: "allocation-attempt",
            parent: snapshot.id,
            sourceId: source.id,
            allocId: "a-2",
            attemptedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    const failed = await reapRun(
      [{ kind: "ready", name: "microsandbox", cloud: true, region: null, provider: adapter() }],
      parseV2(["--providers", "microsandbox", "--run", run, "--out", out]),
      (s) => s,
    );

    expect(failed).toBe(true);
    expect(fake.snapshots.has(snapshot.id)).toBe(true);
    expect(fake.sandboxes.has(source.id)).toBe(true);
    const kinds = (await readJournal(out)).resources.map((r) => r.kind).sort();

    expect(kinds).toEqual(["allocation-attempt", "snapshot", "snapshot-source"]);
    await provider.deleteSnapshot!(snapshot.id);
    await provider.destroy(source.id);
  }, 60_000);
});

describe("Services: cleaned independently of their sandbox, never another's", () => {
  it("deletes a detached Service of a deleted sandbox and leaves one that targets another sandbox", async () => {
    const provider = adapter();
    const run = "msb-reap-services";
    const out = await directory("bench-msb-services-");
    const box = await provider.create({ labels: runLabels(run) });
    const name = fake.sandboxes.get(box.id)?.name ?? "";
    const { url } = await provider.previewUrl(box.id, 3000);
    const slug = new URL(url).pathname.split("/").at(-1) ?? "";

    // The sandbox goes, as a lost destroy would leave it: deleted with its Service detached.
    await fetch(`${fake.url}/v1/sandboxes/${box.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(fake.services.get(slug)?.status).toBe("detached");
    fake.services.set("foreign-slug", {
      slug: "foreign-slug",
      target: { sandbox: "other", port: 80 },
      status: "enabled",
    });

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        resources: [
          {
            provider: "microsandbox",
            id: slug,
            kind: "service",
            parent: box.id,
            sandboxName: name,
          },
          {
            provider: "microsandbox",
            id: "foreign-slug",
            kind: "service",
            parent: box.id,
            sandboxName: name,
          },
        ],
      }),
    );

    await reapRun(
      [{ kind: "ready", name: "microsandbox", cloud: true, region: null, provider: adapter() }],
      parseV2(["--providers", "microsandbox", "--run", run, "--out", out]),
      (s) => s,
    );

    expect(fake.services.has(slug)).toBe(false);
    expect(fake.services.has("foreign-slug")).toBe(true);
    expect((await readJournal(out)).resources).toEqual([]);
    fake.services.delete("foreign-slug");
  }, 60_000);

  it("cleanService reports a foreign target without deleting it", async () => {
    adapter();
    fake.services.set("x-slug", {
      slug: "x-slug",
      target: { sandbox: "theirs", port: 1 },
      status: "enabled",
    });

    expect(await cleanService({ id: "x-slug", parent: null, sandboxName: "ours" })).toBe("foreign");
    expect(fake.services.has("x-slug")).toBe(true);
    expect(await cleanService({ id: "absent-slug", parent: null, sandboxName: "ours" })).toBe(
      "gone",
    );
    fake.services.delete("x-slug");
  });
});

describe("captures journaled by name: settled, never cleared on an unresolved 404", () => {
  it("a name with no snapshot and no operation stays unresolved", async () => {
    adapter();
    await expect(settleMicrosandboxCapture("sandbox-sdk-never", 1)).rejects.toThrow(
      /journal entry kept/,
    );
  });

  it("a failed operation is absent; a finished one is found", async () => {
    const provider = adapter();
    const box = await provider.create({ labels: {} });
    let name = "";
    provider.setAttemptHooks({ snapshot: (a) => void (name = a.name) });
    fake.faults.operationFails = true;
    await expect(provider.snapshot!(box.id)).rejects.toMatchObject({ code: "provider" });
    expect(await settleMicrosandboxCapture(name, 5000)).toBe("absent");

    const { id } = await provider.snapshot!(box.id);

    expect(await settleMicrosandboxCapture(name, 5000)).toBe("exists");
    await provider.deleteSnapshot!(id);
    expect(await settleMicrosandboxCapture(name, 5000)).toBe("absent");
    await provider.destroy(box.id);
  });

  it("reapRun keeps a pending capture entry under review", async () => {
    adapter();
    const run = "msb-reap-capture";
    const out = await directory("bench-msb-capture-");
    const proof = proofFor("00000000-0000-0000-0000-0000000000c3", run);

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        resources: [
          {
            provider: "microsandbox",
            id: "sandbox-sdk-pending",
            kind: "snapshot",
            parent: "00000000-0000-0000-0000-0000000000c3",
            snapshotProof: proof,
            snapshotName: "sandbox-sdk-pending",
          },
        ],
      }),
    );

    const failed = await reapRun(
      [{ kind: "ready", name: "microsandbox", cloud: true, region: null, provider: adapter() }],
      parseV2(["--providers", "microsandbox", "--run", run, "--out", out, "--timeout-ms", "1000"]),
      (s) => s,
    );

    expect(failed).toBe(true);
    expect((await readJournal(out)).resources.map((r) => r.id)).toEqual(["sandbox-sdk-pending"]);
  }, 60_000);

  it("a snapshot captured from another source is never deleted", async () => {
    const provider = adapter();
    const box = await provider.create({ labels: {} });
    fake.faults.snapshotForeignSource = "00000000-0000-0000-0000-0000000000d4";
    await expect(provider.snapshot!(box.id)).rejects.toMatchObject({ code: "outcome_unknown" });
    const [foreign] = [...fake.snapshots.values()];

    expect(foreign).toBeDefined();
    expect(await inspectSnapshot("microsandbox", provider, box.id, foreign!.id)).toEqual({
      exists: true,
      sourceId: "00000000-0000-0000-0000-0000000000d4",
    });
    await expect(
      deleteProvenSnapshot(
        "microsandbox",
        provider,
        foreign!.id,
        box.id,
        proofFor(box.id, "r"),
        "r",
        5000,
      ),
    ).rejects.toThrow(/differs/);
    expect(fake.snapshots.has(foreign!.id)).toBe(true);
    fake.snapshots.delete(foreign!.id);
    await provider.destroy(box.id);
  });
});

describe("tier isolation in sweeps", () => {
  it("a Standard recovery never deletes a Shared sandbox of the same run", async () => {
    const run = "msb-reap-tiers";
    const out = await directory("bench-msb-tiers-");
    const shared = adapter("shared");
    const box = await shared.create({ labels: runLabels(run, "shared") });

    await reapRun(
      [
        {
          kind: "ready",
          name: "microsandbox",
          cloud: true,
          region: null,
          provider: adapter("standard"),
        },
      ],
      parseV2(["--providers", "microsandbox", "--run", run, "--out", out]),
      (s) => s,
    );

    expect(fake.sandboxes.has(box.id)).toBe(true);

    await reapRun(
      [{ kind: "ready", name: "microsandbox-shared", cloud: true, region: null, provider: shared }],
      parseV2(["--providers", "microsandbox-shared", "--run", run, "--out", out]),
      (s) => s,
    );

    expect(fake.sandboxes.has(box.id)).toBe(false);
  }, 60_000);
});

describe("definite refusals", () => {
  it("only codes that prove nothing was made", () => {
    for (const code of ["invalid_argument", "auth", "quota", "not_found", "unsupported"])
      expect(isDefiniteRefusal(code)).toBe(true);

    for (const code of ["outcome_unknown", "provider", "timeout", "unavailable", undefined])
      expect(isDefiniteRefusal(code)).toBe(false);
  });
});
