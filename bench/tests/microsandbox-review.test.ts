// The Microsandbox journaling and recovery invariants, against the SDK's own local fake of Microsandbox
// Cloud (packages/sdk/tests/microsandbox-fake.ts) and the real adapter: every allocation is journaled
// before it is sent, and cleanup and recovery settle what a lost answer left.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from "vitest";
import { z } from "zod";
import {
  microsandbox,
  type MicrosandboxHooks,
  type MicrosandboxOptions,
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
import { collectProvider } from "../src/billing/providers.js";
import { lookupSandbox } from "../src/existence.js";
import { journalFiles } from "../src/files.js";
import { mergeSources, type MergeSource } from "../src/merge.js";
import { createRawMicrosandbox, type RawMicrosandboxBox } from "../src/microsandbox-raw.js";
import { snapshotProvenanceSchema } from "../src/ownership.js";
import { siteData } from "../src/site-data.js";
import { reapRun } from "../src/recovery.js";
import { deleteProvenSnapshot, inspectSnapshot } from "../src/snapshots.js";
import { DeadlineError, deadline } from "../src/timing.js";
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
  it("reads a 404 as pending however old the attempt is", async () => {
    adapter();
    const attempt = { id: "sbx-never-made", allocId: "a-1", attemptedAt: new Date().toISOString() };

    expect(await settleAllocationAttempt(attempt, "standard")).toMatchObject({ kind: "pending" });
    expect(
      await settleAllocationAttempt(attempt, "standard", Date.now() + attemptSettlementMs + 1),
    ).toMatchObject({ kind: "pending", reason: expect.stringMatching(/15 minutes/) });
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
            serviceState: "created",
            serviceCreatedAt: fake.services.get(slug)?.createdAt,
          },
          {
            provider: "microsandbox",
            id: "foreign-slug",
            kind: "service",
            parent: box.id,
            sandboxName: name,
            serviceState: "created",
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

    const entry = (id: string, state: "pending" | "created") => ({
      id,
      parent: null,
      sandboxName: "ours",
      state,
      superseded: false,
    });

    expect(await cleanService(entry("x-slug", "created"))).toEqual({ kind: "foreign" });
    expect(fake.services.has("x-slug")).toBe(true);
    expect(await cleanService(entry("absent-slug", "created"))).toEqual({ kind: "gone" });
    // An unsettled create that reads 404 may still land: it stays pending, never gone.
    expect(await cleanService(entry("absent-slug", "pending"))).toMatchObject({ kind: "pending" });
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
    expect(await settleMicrosandboxCapture(name, 5000)).toEqual({ kind: "absent" });

    const { id } = await provider.snapshot!(box.id);

    expect(await settleMicrosandboxCapture(name, 5000)).toEqual({ kind: "exists", managedId: id });
    await provider.deleteSnapshot!(id);
    expect(await settleMicrosandboxCapture(name, 5000)).toEqual({ kind: "absent" });
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

// GPT-6.2 Sol's independent review (2026-11-24): its reproductions, kept verbatim as regressions, each
// against a fresh fake and output directory. The adapter-only ones are in
// packages/sdk/tests/microsandbox-review.test.ts.
describe("independent review reproductions", () => {
  const run = "independent-review";
  const id = "00000000-0000-0000-0000-0000000000b2";
  let fake: MicrosandboxFake;
  let out: string;
  const realFetch = globalThis.fetch.bind(globalThis);

  beforeEach(async () => {
    fake = await microsandboxFake();
    out = await mkdtemp(join(tmpdir(), "msb-independent-"));
    vi.stubEnv("MSB_API_KEY", key);
    vi.stubEnv("MSB_API_URL", fake.url);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fake.close();
    await rm(out, { recursive: true, force: true });
  });

  function adapter(options: MicrosandboxOptions = {}) {
    return microsandbox({
      apiKey: key,
      baseUrl: fake.url,
      computeType: "standard",
      peer: async () => fake.peer,
      ...options,
    });
  }

  function capture(provider: ReturnType<typeof adapter>, id: string) {
    if (!provider.snapshot) throw new Error("Snapshot support is required for this fixture");

    return provider.snapshot(id);
  }

  function loaded(provider = adapter()) {
    return [
      { kind: "ready", name: "microsandbox", cloud: true, region: null, provider },
    ] satisfies Parameters<typeof reapRun>[0];
  }

  const proof = (sourceId: string) => ({
    sourceId,
    runLabel: run,
    sdkLabel: "1",
    verifiedAt: new Date().toISOString(),
  });

  const labels = (tier = "standard") => ({
    "sandbox-bench-run": run,
    "sandbox-sdk": "1",
    "sandbox-bench-tier": tier,
  });

  const reap = () =>
    reapRun(
      loaded(),
      parseV2(["--providers", "microsandbox", "--run", run, "--out", out, "--timeout-ms", "1000"]),
      (s) => s,
    );

  const journal = (resources: unknown[]) =>
    writeFile(join(out, "ownership.json"), JSON.stringify({ runId: run, resources }));

  const journalText = () => readFile(join(out, "ownership.json"), "utf8");

  test("R3 a transient Service 404 cannot retire its pre-POST journal entry", async () => {
    const slug = "sbx-0000000000000000-p3000";
    await journal([
      { provider: "microsandbox", id: slug, kind: "service", parent: id, sandboxName: "sbx-owner" },
    ]);
    await reap();
    fake.services.set(slug, {
      slug,
      target: { sandbox: "sbx-owner", port: 3000 },
      status: "enabled",
    });
    await reap();
    expect(fake.services.has(slug)).toBe(false);
  });

  test("R4 a Service refused with 409 must not authorize deletion of its detached slug", async () => {
    const p = adapter();
    const { id: sandbox } = await p.create({ labels: labels() });
    const slug = "sbx-" + sandbox.replaceAll("-", "").slice(0, 16) + "-p3000";
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () =>
      Response.json({ error: { code: "service_not_found" } }, { status: 404 }),
    );
    fake.services.set(slug, { slug, target: null, status: "detached" });
    const attempted: unknown[] = [];
    p.setAttemptHooks({
      service: (attempt) => {
        attempted.push({
          provider: "microsandbox",
          id: attempt.slug,
          kind: "service",
          parent: attempt.sandboxId,
          sandboxName: attempt.sandboxName,
        });
      },
    });
    const preview = await p.previewUrl(sandbox, 3000);
    expect(new URL(preview.url).pathname).not.toBe("/svc/" + slug);
    expect(fake.services.has(slug)).toBe(true);
    await journal(attempted);
    await reap();
    expect(fake.services.has(slug)).toBe(true);
  });

  test("R5 recovery uses the managed ID when the succeeded operation is visible and the name is not indexed", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    let name = "";
    p.setAttemptHooks({
      snapshot: (attempt) => {
        name = attempt.name;
      },
    });
    const snapshot = await capture(p, source.id);
    await p.destroy(source.id);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/snapshots/by-name/" + name) {
        return Response.json({ error: { code: "snapshot_not_found" } }, { status: 404 });
      }

      return realFetch(input, init);
    });
    await journal([
      {
        provider: "microsandbox",
        id: name,
        kind: "snapshot",
        parent: source.id,
        snapshotProof: proof(source.id),
        snapshotName: name,
      },
    ]);
    await reap();
    expect(
      fake.requests.some((r) => r.method === "GET" && r.path === "/v1/snapshots/" + snapshot.id),
    ).toBe(true);
    expect({
      stored: fake.snapshots.has(snapshot.id),
      journaled: (await journalText()).includes(name),
    }).toEqual({ stored: false, journaled: false });
  });

  test("R6 restore dependencies survive a sandbox DELETE acknowledgement while the restore is still readable", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const snapshot = await capture(p, source.id);
    const restored = await p.create({ labels: labels(), from: snapshot.id });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (
        init?.method === "DELETE" &&
        new URL(String(input)).pathname === "/v1/sandboxes/" + restored.id
      ) {
        return Response.json({ message: "deletion accepted" });
      }

      return realFetch(input, init);
    });
    await journal([
      { provider: "microsandbox", id: restored.id, kind: "sandbox", parent: null },
      {
        provider: "microsandbox",
        id: source.id,
        kind: "snapshot-source",
        parent: null,
        snapshotProof: proof(source.id),
      },
      {
        provider: "microsandbox",
        id: snapshot.id,
        kind: "snapshot",
        parent: source.id,
        snapshotProof: proof(source.id),
      },
    ]);
    await reap();
    expect(fake.sandboxes.has(restored.id)).toBe(true);
    expect({
      snapshotExists: fake.snapshots.has(snapshot.id),
      sourceExists: fake.sandboxes.has(source.id),
    }).toEqual({ snapshotExists: true, sourceExists: true });
  });

  test("R7 the current-run sweep requires the benchmark tier label as well as compute.type", async () => {
    const p = adapter();
    const other = await p.create({ labels: labels("shared") });
    await runV2(
      loaded(p),
      parseV2([
        "--providers",
        "microsandbox",
        "--run",
        run,
        "--out",
        out,
        "--runs",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "cold",
        "--timeout-ms",
        "3000",
        "--ownership-visibility-ms",
        "100",
      ]),
      async () => {},
    );
    expect(fake.sandboxes.has(other.id)).toBe(true);
  });

  test("R8 an existence response on the other compute tier is not attributed to this adapter", async () => {
    const shared = adapter({ computeType: "shared" });
    const other = await adapter().create({ labels: labels() });
    const evidence = await lookupSandbox(shared, other.id, 1000);
    expect(evidence.result).not.toBe("present");
  });

  test("R9 an old journal and one name 404 do not prove the restore was never allocated", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const snapshot = await capture(p, source.id);
    const restoreName = "sbx-restore-hidden";
    await journal([
      {
        provider: "microsandbox",
        id: restoreName,
        kind: "allocation-attempt",
        parent: snapshot.id,
        sourceId: source.id,
        allocId: "attempt-marker",
        attemptedAt: new Date(Date.now() - attemptSettlementMs - 1000).toISOString(),
      },
      {
        provider: "microsandbox",
        id: source.id,
        kind: "snapshot-source",
        parent: null,
        snapshotProof: proof(source.id),
      },
      {
        provider: "microsandbox",
        id: snapshot.id,
        kind: "snapshot",
        parent: source.id,
        snapshotProof: proof(source.id),
      },
    ]);
    await reap();
    expect({
      journaled: (await journalText()).includes(restoreName),
      snapshot: fake.snapshots.has(snapshot.id),
      source: fake.sandboxes.has(source.id),
    }).toEqual({ journaled: true, snapshot: true, source: true });
  });

  test("R10 a failed invoice cross-check leaves valid per-sandbox metering provisional", async () => {
    const costs = await collectProvider(
      "microsandbox",
      [
        {
          provider: "microsandbox",
          id,
          startedAt: "2026-11-24T10:00:00.000Z",
          finishedAt: "2026-11-24T10:01:00.000Z",
          scenarios: new Set(),
          confirmedStopAt: null,
          app: null,
        },
      ],
      { MSB_API_KEY: key },
      async (url) => {
        if (new URL(url).pathname === "/v1/billing/usage")
          throw new Error("invoice preview unavailable");

        return {
          rows: [
            {
              sandbox_id: id,
              compute_type: "standard",
              day: "2026-11-24T00:00:00Z",
              vcpu_seconds: 3600,
              mem_mib_seconds: 0,
              disk_mib_seconds: 0,
            },
          ],
          sandboxes: [],
        };
      },
    );

    expect(costs.sandboxes[0]?.cost).toMatchObject({
      kind: "metered",
      usd: 0.048,
      complete: false,
      confidence: "low",
    });
  });

  test("R12 both published tier rates include their per-GiB disk charge", () => {
    const fixture: MergeSource = {
      schemaVersion: 2,
      runId: run,
      timestamp: "2026-11-24T00:00:00Z",
      finishedAt: "2026-11-24T01:00:00Z",
      config: { seed: 45, scenarios: ["cold"], bursts: [] },
      metadata: { harnessCommit: "h", sdkCommit: "s" },
      host: { cpu: "test", os: "linux", runtime: "bun" },
      providers: ["microsandbox", "microsandbox-shared"].map((name) => ({
        name,
        configuredRegion: null,
        note: "test",
      })),
      budgets: {},
      cleanup: [],
      methodology: [],
      pricing: {},
      samples: [],
    };

    const rows = siteData(mergeSources([fixture], [])).providers;
    expect(rows.map((row) => ({ id: row.id, rates: row.rates }))).toMatchObject([
      {
        id: "microsandbox",
        rates: { vcpuHour: 0.048, memoryGiBHour: 0.003, diskGiBHour: 0.0000625 },
      },
      {
        id: "microsandbox-shared",
        rates: { vcpuHour: 0.007, memoryGiBHour: 0.000375, diskGiBHour: 0.0000625 },
      },
    ]);
  });

  test("R14 the raw overhead path rejects a response from the other compute tier", async () => {
    fake.faults.compute = "shared";
    await expect(
      createRawMicrosandbox({
        computeType: "standard",
        labels: labels(),
        peer: {
          RemoteContext: class {
            sandboxes = { get: async () => ({ exec: async () => ({ code: 0 }) }) };
          },
        },
        admit: () => {},
      }),
    ).rejects.toThrow();
  });

  test("R15 a journaled sandbox with the wrong tier label is ineligible for deletion", async () => {
    const p = adapter();
    const other = await p.create({ labels: labels("shared") });
    await journal([{ provider: "microsandbox", id: other.id, kind: "sandbox", parent: null }]);
    await reap();
    expect(fake.sandboxes.has(other.id)).toBe(true);
  });

  test("R2-1 runV2 keeps a pending Service journaled when its sandbox is deleted before the Service appears", async () => {
    const p = adapter();
    const create = p.create.bind(p);
    let slug = "";
    let attempted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "POST" && new URL(String(input)).pathname === "/v1/services") {
        attempted = true;

        return Response.json({ error: { code: "internal_error" } }, { status: 503 });
      }

      return realFetch(input, init);
    });
    p.create = async (input) => {
      const result = await create(input);
      slug = `sbx-${result.id.replaceAll("-", "").slice(0, 16)}-p3000`;
      await expect(p.previewUrl(result.id, 3000)).rejects.toThrow();

      return result;
    };

    await runV2(
      loaded(p),
      parseV2([
        "--providers",
        "microsandbox",
        "--run",
        run,
        "--out",
        out,
        "--runs",
        "1",
        "--max-sandboxes",
        "4",
        "--bursts",
        "",
        "--ownership-visibility-ms",
        "100",
        "--timeout-ms",
        "3000",
        "--scenarios",
        "cold",
      ]),
      async () => {},
    );
    expect(attempted).toBe(true);
    expect(fake.sandboxes.size).toBe(0);

    const resources = z
      .object({ resources: z.array(z.looseObject({ id: z.string(), kind: z.string() })) })
      .parse(JSON.parse(await journalText())).resources;

    expect(resources.some((item) => item.kind === "service" && item.id === slug)).toBe(true);
  });

  test("R2-2 does not delete a detached conflicting Service if the 409 settlement could not be persisted", async () => {
    const p = adapter();
    const { id: sandboxId } = await p.create({ labels: labels() });
    const slug = `sbx-${sandboxId.replaceAll("-", "").slice(0, 16)}-p3000`;
    fake.services.set(slug, { slug, target: null, status: "detached" });

    const wire = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () =>
        Response.json({ error: { code: "service_not_found" } }, { status: 404 }),
      );

    let conflicts = 0;
    p.setAttemptHooks({
      service: (attempt) =>
        journal([
          {
            provider: "microsandbox",
            id: attempt.slug,
            kind: "service",
            parent: attempt.sandboxId,
            sandboxName: attempt.sandboxName,
            serviceState: "pending",
          },
        ]),
      serviceSettled: ({ outcome }) => {
        if (outcome !== "conflict") throw new Error("Fixture expected a collision");
        conflicts++;
        throw new Error("simulated failed journal write");
      },
    });

    await expect(p.previewUrl(sandboxId, 3000)).rejects.toThrow("simulated failed journal write");
    expect(conflicts).toBe(1);
    wire.mockRestore();
    await p.destroy(sandboxId);
    expect(fake.services.has(slug)).toBe(true);
    expect(await reap()).toBe(true);
    expect(fake.services.has(slug)).toBe(true);
  });

  test("R2-3 clears the capture-name cleanupReview after recovery deletes its managed snapshot", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    let name = "";
    p.setAttemptHooks({
      snapshot: (attempt) => {
        name = attempt.name;
      },
    });
    const snapshot = await capture(p, source.id);
    await p.destroy(source.id);

    let visible = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (path === `/v1/snapshots/by-name/${name}`)
        return Response.json({ error: { code: "snapshot_not_found" } }, { status: 404 });

      if (!visible && path === "/v1/snapshot-operations")
        return Response.json({ data: [], next_cursor: null });

      return realFetch(input, init);
    });

    await journal([
      {
        provider: "microsandbox",
        id: name,
        kind: "snapshot",
        parent: source.id,
        snapshotName: name,
        snapshotProof: proof(source.id),
      },
    ]);
    expect(await reap()).toBe(true);
    expect(await readFile(join(out, "results.json"), "utf8")).toContain(name);

    visible = true;
    const stillNeedsReview = await reap();

    const results = z
      .object({ cleanupReview: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(await readFile(join(out, "results.json"), "utf8")));

    expect(fake.snapshots.has(snapshot.id)).toBe(false);
    expect(
      z.object({ resources: z.array(z.unknown()) }).parse(JSON.parse(await journalText()))
        .resources,
    ).toEqual([]);
    expect({
      stillNeedsReview,
      reviewedIds: results.cleanupReview.map((entry) => entry.id),
    }).toEqual({
      stillNeedsReview: false,
      reviewedIds: [],
    });
  });

  test("R2-4 gives the raw overhead cleanup the ID when the wrong-tier sandbox DELETE fails", async () => {
    fake.faults.compute = "shared";
    const admitted: RawMicrosandboxBox[] = [];
    let refusedDeletes = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (
        init?.method === "DELETE" &&
        new URL(String(input)).pathname.startsWith("/v1/sandboxes/")
      ) {
        if (refusedDeletes === 0) {
          refusedDeletes++;

          return Response.json({ error: { code: "internal_error" } }, { status: 500 });
        }
      }

      return realFetch(input, init);
    });

    await expect(
      createRawMicrosandbox({
        computeType: "standard",
        labels: labels(),
        peer: {
          RemoteContext: class {
            sandboxes = { get: async () => ({ exec: async () => ({ code: 0 }) }) };
          },
        },
        admit: (box) => admitted.push(box),
      }),
    ).rejects.toThrow();
    expect(refusedDeletes).toBe(1);

    for (const box of admitted) await box.destroy();
    expect({ admitted: admitted.length, remaining: fake.sandboxes.size }).toEqual({
      admitted: 1,
      remaining: 0,
    });
  });

  test("R3-1 end-of-run sweep leaves a replacement Service at a previously confirmed slug alone", async () => {
    const p = adapter();
    const replacementTarget = await p.create({ labels: {} });
    const create = p.create.bind(p);
    let ownedId = "";
    let slug = "";
    let replacementCreated = false;
    p.create = async (input) => {
      const result = await create(input);
      ownedId = result.id;
      slug = `sbx-${result.id.replaceAll("-", "").slice(0, 16)}-p3000`;
      await p.previewUrl(result.id, 3000);

      return result;
    };

    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE" && path === `/v1/sandboxes/${ownedId}` && !replacementCreated) {
        expect(fake.services.has(slug)).toBe(false);
        const target = fake.sandboxes.get(replacementTarget.id);

        if (!target) throw new Error("Replacement target is missing");

        const created = await realFetch(`${fake.url}/v1/services`, {
          method: "POST",
          headers,
          body: JSON.stringify({ slug, target: { sandbox: target.name, port: 3000 } }),
        });

        expect(created.status).toBe(201);
        await created.body?.cancel();

        const deleted = await realFetch(`${fake.url}/v1/sandboxes/${replacementTarget.id}`, {
          method: "DELETE",
          headers,
        });

        expect(deleted.ok).toBe(true);
        await deleted.body?.cancel();
        replacementCreated = true;
      }

      return realFetch(input, init);
    });

    await runV2(
      loaded(p),
      parseV2([
        "--providers",
        "microsandbox",
        "--run",
        run,
        "--out",
        out,
        "--runs",
        "1",
        "--max-sandboxes",
        "4",
        "--bursts",
        "",
        "--ownership-visibility-ms",
        "100",
        "--timeout-ms",
        "3000",
        "--scenarios",
        "cold",
      ]),
      async () => {},
    );
    expect(replacementCreated).toBe(true);
    expect(fake.sandboxes.has(ownedId)).toBe(false);

    const deletes = fake.requests.filter(
      (r) => r.method === "DELETE" && r.path === `/v1/services/${slug}`,
    );

    expect({ replacementPresent: fake.services.has(slug), serviceDeletes: deletes.length }).toEqual(
      { replacementPresent: true, serviceDeletes: 1 },
    );
  });

  test("R3-2 clears capture review across failed results.json rename and clears results.md", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    let name = "";
    p.setAttemptHooks({
      snapshot: (attempt) => {
        name = attempt.name;
      },
    });
    const snapshot = await capture(p, source.id);
    await p.destroy(source.id);

    let visible = false;
    let refuseDelete = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (path === `/v1/snapshots/by-name/${name}`)
        return Response.json({ error: { code: "snapshot_not_found" } }, { status: 404 });

      if (!visible && path === "/v1/snapshot-operations")
        return Response.json({ data: [], next_cursor: null });

      if (refuseDelete && init?.method === "DELETE" && path === `/v1/snapshots/${snapshot.id}`)
        return Response.json({ error: { code: "internal_error" } }, { status: 500 });

      return realFetch(input, init);
    });

    await journal([
      {
        provider: "microsandbox",
        id: name,
        kind: "snapshot",
        parent: source.id,
        snapshotName: name,
        snapshotProof: proof(source.id),
      },
    ]);
    expect(await reap()).toBe(true);
    expect(await readFile(join(out, "results.md"), "utf8")).toContain(name);

    visible = true;
    refuseDelete = true;
    const realRename = journalFiles.rename;

    const rename = vi.spyOn(journalFiles, "rename").mockImplementation((from, to) => {
      if (to === join(out, "results.json"))
        return Promise.reject(new Error("simulated results write failure"));

      return realRename(from, to);
    });

    await expect(reap()).rejects.toThrow("simulated results write failure");
    refuseDelete = false;
    await expect(reap()).rejects.toThrow("simulated results write failure");
    expect(fake.snapshots.has(snapshot.id)).toBe(false);
    rename.mockRestore();

    const failed = await reap();

    const results = z
      .object({ cleanupReview: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(await readFile(join(out, "results.json"), "utf8")));

    expect({ failed, reviewedIds: results.cleanupReview.map((item) => item.id) }).toEqual({
      failed: false,
      reviewedIds: [],
    });
    expect(await readFile(join(out, "results.md"), "utf8")).not.toContain(name);
  });

  test("R4-1 reap leaves a replacement Service alone after slug reuse during destroy or interrupted settlement write", async () => {
    const p = adapter();
    const other = await p.create({ labels: {} });
    const create = p.create.bind(p);
    let sandboxId = "";
    let slug = "";
    p.create = async (input) => {
      const result = await create(input);
      sandboxId = result.id;
      slug = `sbx-${result.id.replaceAll("-", "").slice(0, 16)}-p3000`;
      await p.previewUrl(result.id, 3000);

      return result;
    };

    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    let released = false;
    let crashJournal = "";
    let failedWrites = 0;
    const realRename = journalFiles.rename;
    vi.spyOn(journalFiles, "rename").mockImplementation((from, to) => {
      if (released && crashJournal === "" && to === join(out, "ownership.json")) {
        failedWrites++;

        return Promise.reject(new Error("simulated Service settlement write failure"));
      }

      return realRename(from, to);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (
        init?.method === "DELETE" &&
        path === `/v1/sandboxes/${sandboxId}` &&
        crashJournal === ""
      ) {
        expect(failedWrites).toBe(1);
        crashJournal = await readFile(join(out, "ownership.json"), "utf8");
        const target = fake.sandboxes.get(other.id);

        if (!target) throw new Error("Replacement target is missing");

        const replacement = await realFetch(`${fake.url}/v1/services`, {
          method: "POST",
          headers,
          body: JSON.stringify({ slug, target: { sandbox: target.name, port: 3000 } }),
        });

        expect(replacement.status).toBe(201);
        await replacement.body?.cancel();

        const removed = await realFetch(`${fake.url}/v1/sandboxes/${other.id}`, {
          method: "DELETE",
          headers,
        });

        expect(removed.ok).toBe(true);
        await removed.body?.cancel();
      }

      const response = await realFetch(input, init);

      if (init?.method === "DELETE" && path === `/v1/services/${slug}` && response.ok)
        released = true;

      return response;
    });

    await runV2(
      loaded(p),
      parseV2([
        "--providers",
        "microsandbox",
        "--run",
        run,
        "--out",
        out,
        "--runs",
        "1",
        "--max-sandboxes",
        "4",
        "--bursts",
        "",
        "--ownership-visibility-ms",
        "100",
        "--timeout-ms",
        "3000",
        "--scenarios",
        "cold",
      ]),
      async () => {},
    );
    await writeFile(join(out, "ownership.json"), crashJournal);
    await reap();

    const deletes = fake.requests.filter(
      (r) => r.method === "DELETE" && r.path === `/v1/services/${slug}`,
    );

    expect({ replacementPresent: fake.services.has(slug), serviceDeletes: deletes.length }).toEqual(
      { replacementPresent: true, serviceDeletes: 1 },
    );
  });

  test("R4-2 clears a deleted capture review after results write failure even past the operation search limit", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    let name = "";
    p.setAttemptHooks({
      snapshot: (attempt) => {
        name = attempt.name;
      },
    });
    const { id: snapshotId } = await capture(p, source.id);
    await p.destroy(source.id);

    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const operations = await realFetch(`${fake.url}/v1/snapshot-operations`, { headers });

    const original = z
      .object({ data: z.array(z.looseObject({ snapshot_name: z.string() })) })
      .parse(await operations.json())
      .data.find((op) => op.snapshot_name === name);

    if (original === undefined) throw new Error("Capture operation fixture missing");

    let nameVisible = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if (!nameVisible && url.pathname === `/v1/snapshots/by-name/${name}`)
        return Response.json({ error: { code: "snapshot_not_found" } }, { status: 404 });

      if (url.pathname === "/v1/snapshot-operations") {
        const page = Number(url.searchParams.get("cursor") ?? "0");

        if (page === 10) return Response.json({ data: [original], next_cursor: null });

        return Response.json({
          data: Array.from({ length: 100 }, (_, index) => {
            const sequence = String(100 * page + index).padStart(12, "0");

            return {
              ...original,
              id: `00000000-0000-4000-8000-${sequence}`,
              snapshot_name: `other-${sequence}`,
              status: "failed",
              error: { code: "capture_failed", message: "unrelated failure" },
              result: null,
            };
          }),
          next_cursor: String(page + 1),
        });
      }

      return realFetch(input, init);
    });

    await journal([
      {
        provider: "microsandbox",
        id: name,
        kind: "snapshot",
        parent: source.id,
        snapshotName: name,
        snapshotProof: proof(source.id),
      },
    ]);
    expect(await reap()).toBe(true);

    nameVisible = true;
    const realRename = journalFiles.rename;

    const rename = vi.spyOn(journalFiles, "rename").mockImplementation((from, to) => {
      if (to === join(out, "results.json"))
        return Promise.reject(new Error("simulated results write failure"));

      return realRename(from, to);
    });

    await expect(reap()).rejects.toThrow("simulated results write failure");
    expect(fake.snapshots.has(snapshotId)).toBe(false);
    rename.mockRestore();

    const failed = await reap();

    const results = z
      .object({ cleanupReview: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(await readFile(join(out, "results.json"), "utf8")));

    expect({ failed, reviewedIds: results.cleanupReview.map((item) => item.id) }).toEqual({
      failed: false,
      reviewedIds: [],
    });
  });

  test("R4-3 dispatches sandbox DELETE within caller deadline while Service settlement hook is stalled", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    await p.previewUrl(source.id, 3000);
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    let resolveHook: (() => void) | undefined;
    let resolveUnblock: (() => void) | undefined;

    const hookEntered = new Promise<void>((resolve) => {
      resolveHook = resolve;
    });

    const unblock = new Promise<void>((resolve) => {
      resolveUnblock = resolve;
    });

    p.setAttemptHooks({
      serviceSettled: ({ outcome }) => {
        if (outcome === "deleted") {
          resolveHook?.();

          return unblock;
        }
      },
    });

    const destroying = p.destroy(source.id);

    const waitForDelete = async () => {
      try {
        return await deadline(500, async () => {
          await destroying;

          return !fake.sandboxes.has(source.id);
        });
      } catch (error) {
        if (error instanceof DeadlineError) return !fake.sandboxes.has(source.id);
        throw error;
      }
    };

    try {
      await deadline(2000, () => Promise.race([hookEntered, destroying]));
      expect(fake.services.has(slug)).toBe(false);
      expect(await waitForDelete()).toBe(true);
    } finally {
      resolveUnblock?.();
      await destroying;
    }
  });

  test("R5-1 retrying SDK destroy preserves a detached replacement Service with a different created_at", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const other = await p.create({ labels: {} });
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    await p.previewUrl(source.id, 3000);
    const original = fake.services.get(slug);
    const replacementTarget = fake.sandboxes.get(other.id);

    if (!original || !replacementTarget) throw new Error("Missing Service retry fixtures");
    fake.faults.serviceDeleteFails = true;
    await expect(p.destroy(source.id)).rejects.toThrow("could not be removed");
    expect(fake.sandboxes.has(source.id)).toBe(false);
    fake.faults.serviceDeleteFails = false;

    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

    const delOrig = await realFetch(`${fake.url}/v1/services/${slug}`, {
      method: "DELETE",
      headers,
    });

    await delOrig.body?.cancel();
    expect(delOrig.ok).toBe(true);

    const makeRep = await realFetch(`${fake.url}/v1/services`, {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, target: { sandbox: replacementTarget.name, port: 3000 } }),
    });

    await makeRep.body?.cancel();
    expect(makeRep.ok).toBe(true);

    const delTarget = await realFetch(`${fake.url}/v1/sandboxes/${other.id}`, {
      method: "DELETE",
      headers,
    });

    await delTarget.body?.cancel();
    expect(delTarget.ok).toBe(true);
    const replacement = fake.services.get(slug);
    expect(replacement?.status).toBe("detached");
    expect(replacement?.createdAt).not.toBe(original.createdAt);
    await p.destroy(source.id);
    expect(fake.services.get(slug)).toBe(replacement);
  });

  test("R5-2 failed Service listing during reap still cleans confirmed Service via exact sweep", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const sandbox = fake.sandboxes.get(source.id);

    if (!sandbox) throw new Error("Owned sandbox is missing");
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    await p.previewUrl(source.id, 3000);
    const createdAt = fake.services.get(slug)?.createdAt;

    if (!createdAt) throw new Error("Created Service lacks a timestamp");
    await journal([
      { provider: "microsandbox", id: source.id, kind: "sandbox", parent: null },
      {
        provider: "microsandbox",
        id: slug,
        kind: "service",
        parent: source.id,
        sandboxName: sandbox.name,
        serviceState: "created",
        serviceCreatedAt: createdAt,
      },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(String(input));

      if (url.pathname === "/v1/services" && url.searchParams.has("sandbox"))
        return Promise.resolve(
          Response.json({ error: { code: "internal_error" } }, { status: 500 }),
        );

      return realFetch(input, init);
    });
    expect(await reap()).toBe(false);
    expect(fake.sandboxes.has(source.id)).toBe(false);
    expect(fake.services.has(slug)).toBe(false);
  });

  test("R5-3 timed-out cleanup hook cannot overwrite a newer ownership journal", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const sandbox = fake.sandboxes.get(source.id);

    if (!sandbox) throw new Error("Owned sandbox is missing");
    const slug1 = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    const slug2 = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3001`;
    await p.previewUrl(source.id, 3000);
    await p.previewUrl(source.id, 3001);
    await journal([
      { provider: "microsandbox", id: source.id, kind: "sandbox", parent: null },
      {
        provider: "microsandbox",
        id: slug1,
        kind: "service",
        parent: source.id,
        sandboxName: sandbox.name,
        serviceState: "created",
        serviceCreatedAt: fake.services.get(slug1)?.createdAt,
      },
      {
        provider: "microsandbox",
        id: slug2,
        kind: "service",
        parent: source.id,
        sandboxName: sandbox.name,
        serviceState: "created",
        serviceCreatedAt: fake.services.get(slug2)?.createdAt,
      },
    ]);
    const ownershipPath = join(out, "ownership.json");
    const realRename = journalFiles.rename;
    let releaseFirst: (() => void) | undefined;

    const allowFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let held = false;
    vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
      if (to === ownershipPath && !held) {
        const ids = z
          .object({ resources: z.array(z.object({ id: z.string() })) })
          .parse(JSON.parse(await readFile(from, "utf8")))
          .resources.map((r) => r.id);

        if (ids.includes(source.id) && ids.includes(slug2) && ids.length === 2) {
          held = true;
          await allowFirst;
        }
      }

      await realRename(from, to);
    });
    const reaping = reap();

    try {
      await deadline(600, () => reaping);
    } catch (error) {
      if (!(error instanceof DeadlineError)) throw error;
    } finally {
      releaseFirst?.();
    }

    expect(await reaping).toBe(false);
    expect(fake.sandboxes.has(source.id)).toBe(false);
    expect(fake.services.size).toBe(0);
    expect(
      z.object({ resources: z.array(z.unknown()) }).parse(JSON.parse(await journalText()))
        .resources,
    ).toEqual([]);
  });

  test("R5-4 interrupted results write does not leave an orphan Service review", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const sandbox = fake.sandboxes.get(source.id);

    if (!sandbox) throw new Error("Owned sandbox is missing");
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    await p.previewUrl(source.id, 3000);
    await journal([
      { provider: "microsandbox", id: source.id, kind: "sandbox", parent: null },
      {
        provider: "microsandbox",
        id: slug,
        kind: "service",
        parent: source.id,
        sandboxName: sandbox.name,
        serviceState: "created",
        serviceCreatedAt: fake.services.get(slug)?.createdAt,
      },
    ]);
    await writeFile(
      join(out, "results.json"),
      JSON.stringify({
        runId: run,
        cleanupReview: [
          { provider: "microsandbox", id: slug, kind: "service", reason: "old cleanup failure" },
        ],
      }),
    );
    const realRename = journalFiles.rename;

    const rename = vi
      .spyOn(journalFiles, "rename")
      .mockImplementation((from, to) =>
        to === join(out, "results.json")
          ? Promise.reject(new Error("simulated results write failure"))
          : realRename(from, to),
      );

    await expect(reap()).rejects.toThrow("simulated results write failure");
    expect(fake.services.has(slug)).toBe(false);
    rename.mockRestore();

    const failed = await reap();

    const results = z
      .object({ cleanupReview: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(await readFile(join(out, "results.json"), "utf8")));

    expect({ failed, reviewedIds: results.cleanupReview.map((item) => item.id) }).toEqual({
      failed: false,
      reviewedIds: [],
    });
  });
});
