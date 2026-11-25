// The Microsandbox journaling and recovery invariants, against the SDK's own local fake of Microsandbox
// Cloud (packages/sdk/tests/microsandbox-fake.ts) and the real adapter: every allocation is journaled
// before it is sent, and cleanup and recovery settle what a lost answer left.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  capturedFrom,
  cleanService,
  isDefiniteRefusal,
  maxMicrosandboxAnswerBytes,
  microsandboxFetch,
  readMicrosandboxJson,
  settleAllocationAttempt,
  settleMicrosandboxCapture,
} from "../src/microsandbox.js";
import { collectProvider } from "../src/billing/providers.js";
import { lookupSandbox } from "../src/existence.js";
import { journalFiles } from "../src/files.js";
import { mergeSources, type MergeSource } from "../src/merge.js";
import {
  createRawMicrosandbox,
  redactMicrosandbox,
  type RawMicrosandboxBox,
} from "../src/microsandbox-raw.js";
import { snapshotProvenanceSchema } from "../src/ownership.js";
import { siteData } from "../src/site-data.js";
import { reapRun } from "../src/recovery.js";
import { deleteProvenSnapshot, inspectSnapshot } from "../src/snapshots.js";
import { DeadlineError, deadline } from "../src/timing.js";
import { parseV2 } from "../src/v2-config.js";
import { runV2 } from "../src/v2-runner.js";
import { fingerprintOf } from "../src/connections.js";
import { bound } from "./native-fakes.js";

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

  return bound(
    microsandbox({ apiKey: key, baseUrl: fake.url, computeType, peer: async () => fake.peer }),
    { apiKey: key, baseUrl: fake.url },
  );
}

/** The connection fingerprints a run through `provider` journals; one connection serves both tiers. */
async function fingerprints(provider: MicrosandboxProvider) {
  const fingerprint = (await fingerprintOf(provider)) ?? "";

  return { microsandbox: fingerprint, "microsandbox-shared": fingerprint };
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

    expect(
      await settleAllocationAttempt({ apiKey: key, baseUrl: fake.url }, attempt, "standard"),
    ).toMatchObject({ kind: "pending" });
    expect(
      await settleAllocationAttempt(
        { apiKey: key, baseUrl: fake.url },
        attempt,
        "standard",
        Date.now() + attemptSettlementMs + 1,
      ),
    ).toMatchObject({ kind: "pending", reason: expect.stringMatching(/15 minutes/) });
  });

  it("admits only the attempt's marker on the attempt's tier", async () => {
    const provider = adapter();
    let seen = { name: "", allocId: "" };
    provider.setAttemptHooks({ create: (a) => void (seen = { name: a.name, allocId: a.allocId }) });
    const info = await provider.create({ labels: {} });
    const attempt = { id: seen.name, attemptedAt: new Date().toISOString() };

    expect(
      await settleAllocationAttempt(
        { apiKey: key, baseUrl: fake.url },
        { ...attempt, allocId: seen.allocId },
        "standard",
      ),
    ).toEqual({
      kind: "sandbox",
      id: info.id,
    });
    expect(
      await settleAllocationAttempt(
        { apiKey: key, baseUrl: fake.url },
        { ...attempt, allocId: "another" },
        "standard",
      ),
    ).toMatchObject({
      kind: "pending",
    });
    expect(
      await settleAllocationAttempt(
        { apiKey: key, baseUrl: fake.url },
        { ...attempt, allocId: seen.allocId },
        "shared",
      ),
    ).toMatchObject({ kind: "pending" });
    fake.faults.specNull = 1;
    expect(
      await settleAllocationAttempt(
        { apiKey: key, baseUrl: fake.url },
        { ...attempt, allocId: seen.allocId },
        "standard",
      ),
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
        connectionFingerprints: await fingerprints(adapter()),
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
        connectionFingerprints: await fingerprints(adapter()),
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
  it("keeps a proven detached Service of a deleted sandbox for manual cleanup and leaves one that targets another sandbox", async () => {
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
        connectionFingerprints: await fingerprints(adapter()),
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

    // Microsandbox deletes only by reusable slug, so even a proven Service is left for manual cleanup.
    expect(fake.services.has(slug)).toBe(true);
    expect(fake.services.has("foreign-slug")).toBe(true);
    expect((await readJournal(out)).resources.map((r) => r.id)).toEqual([slug]);
    fake.services.delete(slug);
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

    expect(
      await cleanService({ apiKey: key, baseUrl: fake.url }, entry("x-slug", "created")),
    ).toEqual({ kind: "foreign" });
    expect(fake.services.has("x-slug")).toBe(true);
    expect(
      await cleanService({ apiKey: key, baseUrl: fake.url }, entry("absent-slug", "created")),
    ).toEqual({ kind: "gone" });
    // An unsettled create that reads 404 may still land: it stays pending, never gone.
    expect(
      await cleanService({ apiKey: key, baseUrl: fake.url }, entry("absent-slug", "pending")),
    ).toMatchObject({ kind: "pending" });
    fake.services.delete("x-slug");
  });
});

describe("captures journaled by name: settled, never cleared on an unresolved 404", () => {
  it("a name with no snapshot and no operation stays unresolved", async () => {
    adapter();
    await expect(
      settleMicrosandboxCapture({ apiKey: key, baseUrl: fake.url }, "sandbox-sdk-never", 1),
    ).rejects.toThrow(/journal entry kept/);
  });

  it("a failed operation is absent; a finished one is found", async () => {
    const provider = adapter();
    const box = await provider.create({ labels: {} });
    let name = "";
    provider.setAttemptHooks({ snapshot: (a) => void (name = a.name) });
    fake.faults.operationFails = true;
    await expect(provider.snapshot!(box.id)).rejects.toMatchObject({ code: "provider" });
    expect(await settleMicrosandboxCapture({ apiKey: key, baseUrl: fake.url }, name, 5000)).toEqual(
      { kind: "absent" },
    );

    const { id } = await provider.snapshot!(box.id);

    expect(await settleMicrosandboxCapture({ apiKey: key, baseUrl: fake.url }, name, 5000)).toEqual(
      { kind: "exists", managedId: id },
    );
    await provider.deleteSnapshot!(id);
    expect(await settleMicrosandboxCapture({ apiKey: key, baseUrl: fake.url }, name, 5000)).toEqual(
      { kind: "absent" },
    );
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
        connectionFingerprints: await fingerprints(adapter()),
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

    // A reap reads only through the connection the run journaled.
    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        connectionFingerprints: await fingerprints(shared),
        resources: [],
      }),
    );

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
    return bound(
      microsandbox({
        apiKey: key,
        baseUrl: fake.url,
        computeType: "standard",
        peer: async () => fake.peer,
        ...options,
      }),
      { apiKey: options.apiKey ?? key, baseUrl: options.baseUrl ?? fake.url },
    );
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

  const journal = async (resources: unknown[]) =>
    writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        connectionFingerprints: await fingerprints(adapter()),
        resources,
      }),
    );

  const journalText = () => readFile(join(out, "ownership.json"), "utf8");

  /** A Service nothing proves is the run's, after a reap: still there and still journaled for review. */
  const leftForReview = async (slug: string) => ({
    kept: fake.services.has(slug),
    journaled: z
      .object({ resources: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(await journalText()))
      .resources.some((r) => r.id === slug),
  });

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
    // The Service that lands later is attached, but nothing proves it is this run's create.
    expect(await leftForReview(slug)).toEqual({ kept: true, journaled: true });
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

  test("PR88-6 a promoted allocation attempt clears its name-keyed review, across a failed results.json write", async () => {
    const p = adapter();
    let attempt: { name: string; allocId: string } | undefined;
    p.setAttemptHooks({
      create: ({ name, allocId }) => {
        attempt = { name, allocId };
      },
    });
    const { id: sandbox } = await p.create({ labels: labels() });

    if (attempt === undefined) throw new Error("the create hook did not run");
    await journal([
      {
        provider: "microsandbox",
        id: attempt.name,
        kind: "allocation-attempt",
        parent: null,
        allocId: attempt.allocId,
        attemptedAt: new Date().toISOString(),
      },
    ]);

    // Microsandbox cannot be read: the attempt goes under review, and its sandbox stays.
    const unreadable = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) =>
        new URL(String(input)).pathname.startsWith("/v1/sandboxes")
          ? Response.json({ error: { code: "internal_error" } }, { status: 500 })
          : realFetch(input, init),
      );

    expect(await reap()).toBe(true);
    unreadable.mockRestore();
    expect(fake.sandboxes.has(sandbox)).toBe(true);
    expect(await readFile(join(out, "results.json"), "utf8")).toContain(attempt.name);

    // The next reap promotes the attempt and deletes its sandbox, but results.json cannot be written.
    const realRename = journalFiles.rename;

    const rename = vi
      .spyOn(journalFiles, "rename")
      .mockImplementation((from, to) =>
        to === join(out, "results.json")
          ? Promise.reject(new Error("simulated results write failure"))
          : realRename(from, to),
      );

    await expect(reap()).rejects.toThrow("simulated results write failure");
    rename.mockRestore();
    expect(fake.sandboxes.has(sandbox)).toBe(false);

    const failed = await reap();

    const results = z
      .object({ cleanupReview: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(await readFile(join(out, "results.json"), "utf8")));

    expect({ failed, reviewedIds: results.cleanupReview.map((item) => item.id) }).toEqual({
      failed: false,
      reviewedIds: [],
    });
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
        connection: { apiKey: key, baseUrl: fake.url },
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

  test("PR88-S2 a fresh reap never trades the journal's Service identity for a replacement's", async () => {
    const p = adapter();
    const { id: sandbox } = await p.create({ labels: labels() });
    const sandboxName = fake.sandboxes.get(sandbox)?.name;

    await p.previewUrl(sandbox, 3000);

    const slug = [...fake.services.keys()].find((s) => s.endsWith("-p3000"));

    if (slug === undefined || sandboxName === undefined) throw new Error("no fake Service");

    // The journal holds the create this run saw; the live Service at the slug is another one.
    await journal([
      { provider: "microsandbox", id: sandbox, kind: "sandbox", parent: null },
      {
        provider: "microsandbox",
        id: slug,
        kind: "service",
        parent: sandbox,
        sandboxName,
        serviceState: "created",
        serviceCreatedAt: "2001-01-01T00:00:00.000Z",
      },
    ]);
    await reap();

    expect(fake.services.has(slug)).toBe(true);
    fake.services.delete(slug);
  });

  test("R2-1 runV2 keeps a pending Service and its parent sandbox journaled while the Service returns 404", async () => {
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
    expect(fake.sandboxes.size).toBe(1);

    const resources = z
      .object({ resources: z.array(z.looseObject({ id: z.string(), kind: z.string() })) })
      .parse(JSON.parse(await journalText())).resources;

    expect(resources.some((item) => item.kind === "service" && item.id === slug)).toBe(true);
    expect(resources.some((item) => item.kind === "sandbox")).toBe(true);
  }, 15_000);

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
        connection: { apiKey: key, baseUrl: fake.url },
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

  test("PR88 merge review: source discovery of a name-journaled capture replaces the name entry before deleting", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    let name = "";
    p.setAttemptHooks({
      snapshot: (attempt) => {
        name = attempt.name;
      },
    });
    const { id: snapshotId } = await capture(p, source.id);

    let listing = false;

    // The name is not indexed and its operation is past the search limit: only the source can find it.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if (!listing && url.pathname === "/v1/snapshots")
        return Response.json({ error: { code: "internal_error" } }, { status: 500 });

      if (url.pathname === `/v1/snapshots/by-name/${name}`)
        return Response.json({ error: { code: "snapshot_not_found" } }, { status: 404 });

      if (url.pathname === "/v1/snapshot-operations") {
        const page = Number(url.searchParams.get("cursor") ?? "0");

        return Response.json({ data: [], next_cursor: page < 10 ? String(page + 1) : null });
      }

      return realFetch(input, init);
    });

    await journal([
      {
        provider: "microsandbox",
        id: source.id,
        kind: "snapshot-source",
        parent: null,
        snapshotProof: proof(source.id),
      },
      {
        provider: "microsandbox",
        id: name,
        kind: "snapshot",
        parent: source.id,
        snapshotName: name,
        snapshotProof: proof(source.id),
      },
    ]);

    // A first sweep that cannot list leaves a review keyed by the capture's name.
    expect(await reap()).toBe(true);

    listing = true;
    const failed = await reap();

    const results = z
      .object({ cleanupReview: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(await readFile(join(out, "results.json"), "utf8")));

    expect({
      failed,
      snapshot: fake.snapshots.has(snapshotId),
      reviewedIds: results.cleanupReview.map((item) => item.id),
    }).toEqual({ failed: false, snapshot: false, reviewedIds: [] });
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

  test("R5-2 failed Service listing during reap still reaches a confirmed Service via exact sweep, kept for manual cleanup", async () => {
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
    expect(await reap()).toBe(true);
    expect(fake.sandboxes.has(source.id)).toBe(false);
    expect(fake.services.has(slug)).toBe(true);
    expect(
      z
        .object({ cleanupReview: z.array(z.object({ id: z.string(), reason: z.string() })) })
        .parse(JSON.parse(await readFile(join(out, "results.json"), "utf8")))
        .cleanupReview.find((item) => item.id === slug)?.reason,
    ).toMatch(/manual cleanup/);
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
    // Deleted by hand, as cleanup asks: the reap only settles the journal.
    fake.services.delete(slug1);
    fake.services.delete(slug2);
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
    // Deleted by hand, as cleanup asks: the reap only settles the journal.
    fake.services.delete(slug);
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

  test("R6-1 SDK destroy keeps a detached original retryable when one read lacks created_at", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    await p.previewUrl(source.id, 3000);
    const original = fake.services.get(slug);

    if (!original) throw new Error("Original Service missing");
    fake.faults.serviceDeleteFails = true;
    await expect(p.destroy(source.id)).rejects.toThrow("could not be removed");
    expect(fake.sandboxes.has(source.id)).toBe(false);
    fake.faults.serviceDeleteFails = false;

    const incomplete = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method !== "GET" || new URL(String(input)).pathname !== `/v1/services/${slug}`)
        return realFetch(input, init);
      const response = await realFetch(input, init);
      const value = z.looseObject({ created_at: z.string() }).parse(await response.json());
      const { created_at: _, ...withoutCreatedAt } = value;

      return Response.json(withoutCreatedAt, { status: response.status });
    });

    await expect(p.destroy(source.id)).rejects.toThrow("could not be removed");
    expect(fake.services.get(slug)).toBe(original);
    incomplete.mockRestore();
    await p.destroy(source.id);
    expect(fake.services.has(slug)).toBe(false);
  });

  test("R6-2 reap clears a Service review created by a failed ownership journal write", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const sandbox = fake.sandboxes.get(source.id);

    if (!sandbox) throw new Error("Owned sandbox is missing");
    const first = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    const second = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3001`;
    await p.previewUrl(source.id, 3000);
    await p.previewUrl(source.id, 3001);
    await journal([
      { provider: "microsandbox", id: source.id, kind: "sandbox", parent: null },
      {
        provider: "microsandbox",
        id: first,
        kind: "service",
        parent: source.id,
        sandboxName: sandbox.name,
        serviceState: "created",
        serviceCreatedAt: fake.services.get(first)?.createdAt,
      },
      {
        provider: "microsandbox",
        id: second,
        kind: "service",
        parent: source.id,
        sandboxName: sandbox.name,
        serviceState: "created",
        serviceCreatedAt: fake.services.get(second)?.createdAt,
      },
    ]);
    // Deleted by hand, as cleanup asks: the reap only settles the journal.
    fake.services.delete(first);
    fake.services.delete(second);

    const del = await realFetch(`${fake.url}/v1/sandboxes/${source.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });

    await del.body?.cancel();
    expect(del.ok).toBe(true);

    const ownershipPath = join(out, "ownership.json");
    const realRename = journalFiles.rename;
    let failedOnce = false;

    const rename = vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
      if (to === ownershipPath && !failedOnce) {
        const ids = z
          .object({ resources: z.array(z.object({ id: z.string() })) })
          .parse(JSON.parse(await readFile(from, "utf8")))
          .resources.map((r) => r.id);

        if (!ids.includes(first) && ids.includes(second)) {
          failedOnce = true;
          throw new Error("simulated first Service journal rename failure");
        }
      }

      await realRename(from, to);
    });

    expect(await reap()).toBe(true);
    expect(failedOnce).toBe(true);
    expect(fake.services.size).toBe(0);
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

  test("R7-1 reap retires a pending Service after verified deletion and a one-shot journal rename failure", async () => {
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
        serviceState: "pending",
      },
    ]);
    const ownershipPath = join(out, "ownership.json");
    const realRename = journalFiles.rename;
    let failedOnce = false;

    const rename = vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
      if (to === ownershipPath && !failedOnce) {
        const ids = z
          .object({ resources: z.array(z.object({ id: z.string() })) })
          .parse(JSON.parse(await readFile(from, "utf8")))
          .resources.map((r) => r.id);

        if (ids.includes(source.id) && !ids.includes(slug)) {
          failedOnce = true;
          throw new Error("simulated one-shot Service settlement rename failure");
        }
      }

      await realRename(from, to);
    });

    // A pending entry is never proof, so no reap deletes the Service: it stays journaled for review.
    expect(await reap()).toBe(true);
    rename.mockRestore();
    expect(await reap()).toBe(true);
    expect({
      sandbox: fake.sandboxes.has(source.id),
      ...(await leftForReview(slug)),
    }).toEqual({ sandbox: false, kept: true, journaled: true });
  });

  test("R7-2 SDK destroy never takes an attached read's created_at as its own Service's identity", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const { pathname } = new URL(String(input));

      if (pathname === "/v1/services" && init?.method === "POST") {
        const response = await realFetch(input, init);

        const { created_at: _, ...body } = z
          .looseObject({ created_at: z.string() })
          .parse(await response.json());

        return Response.json(body, { status: response.status });
      }

      if (pathname === "/v1/services" && init?.method === "GET")
        return Response.json({ error: "list unavailable" }, { status: 503 });

      return realFetch(input, init);
    });

    await p.previewUrl(source.id, 3000);
    fake.faults.serviceDeleteFails = true;
    await expect(p.destroy(source.id)).rejects.toThrow("nothing proves this client made");
    expect(fake.services.get(slug)?.status).toBe("detached");
    expect(fake.sandboxes.has(source.id)).toBe(false);
    fetchMock.mockRestore();
    fake.faults.serviceDeleteFails = false;
    await p.destroy(source.id).catch(() => {});
    expect(fake.services.has(slug)).toBe(true);
    fake.services.delete(slug);
  });

  test("R8-1 verified sweep deletion survives a transient journal rename failure", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const sandbox = fake.sandboxes.get(source.id);

    if (!sandbox) throw new Error("Fixture sandbox missing");
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    const snapshot = await capture(p, source.id);
    await journal([
      { provider: "microsandbox", id: source.id, kind: "sandbox", parent: null },
      {
        provider: "microsandbox",
        id: slug,
        kind: "service",
        parent: source.id,
        sandboxName: sandbox.name,
        serviceState: "pending",
      },
      {
        provider: "microsandbox",
        id: snapshot.id,
        kind: "snapshot",
        parent: source.id,
        snapshotProof: proof(source.id),
      },
    ]);
    await writeFile(join(out, "results.json"), JSON.stringify({ runId: run }));
    await p.previewUrl(source.id, 3000);

    const ownershipPath = join(out, "ownership.json");
    const realRename = journalFiles.rename;
    let failures = 0;

    const rename = vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
      if (to === ownershipPath && failures === 0) {
        const ids = z
          .object({ resources: z.array(z.object({ id: z.string() })) })
          .parse(JSON.parse(await readFile(from, "utf8")))
          .resources.map((r) => r.id);

        if (ids.includes(snapshot.id) && ids.includes(source.id) && !ids.includes(slug)) {
          failures++;
          throw new Error("simulated one-shot sweep retirement rename failure");
        }
      }

      await realRename(from, to);
    });

    // The snapshot and sandbox go; the pending Service is never proof, so it is kept and named.
    await reap();
    expect(fake.snapshots.has(snapshot.id)).toBe(false);
    expect(fake.sandboxes.has(source.id)).toBe(false);
    rename.mockRestore();

    const retryFailed = await reap();

    const results = z
      .object({ cleanupReview: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(await readFile(join(out, "results.json"), "utf8")));

    expect({
      retryFailed,
      reviewedIds: results.cleanupReview.map((item) => item.id),
      ...(await leftForReview(slug)),
    }).toEqual({ retryFailed: true, reviewedIds: [slug], kept: true, journaled: true });
  });

  test("R8-2 fresh reap removes a verified pending Service after one DELETE failure", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const sandbox = fake.sandboxes.get(source.id);

    if (!sandbox) throw new Error("Fixture sandbox missing");
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    await journal([
      { provider: "microsandbox", id: source.id, kind: "sandbox", parent: null },
      {
        provider: "microsandbox",
        id: slug,
        kind: "service",
        parent: source.id,
        sandboxName: sandbox.name,
        serviceState: "pending",
      },
    ]);
    await writeFile(join(out, "results.json"), JSON.stringify({ runId: run }));
    await p.previewUrl(source.id, 3000);

    let failures = 0;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (
        new URL(String(input)).pathname === `/v1/services/${slug}` &&
        init?.method === "DELETE" &&
        failures === 0
      ) {
        failures++;

        return Response.json(
          { error: "simulated one-shot Service DELETE failure" },
          { status: 500 },
        );
      }

      return realFetch(input, init);
    });

    // A pending Service is never proof, so no DELETE is sent for it, failing or not.
    await reap();
    expect({ failures, sandbox: fake.sandboxes.has(source.id) }).toEqual({
      failures: 0,
      sandbox: false,
    });
    fetchMock.mockRestore();

    const retryFailed = await reap();

    const results = z
      .object({ cleanupReview: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(await readFile(join(out, "results.json"), "utf8")));

    expect({
      retryFailed,
      reviewedIds: results.cleanupReview.map((item) => item.id),
      ...(await leftForReview(slug)),
    }).toEqual({ retryFailed: true, reviewedIds: [slug], kept: true, journaled: true });
  });

  test("R9-1 fresh reap recovers pending Service after a failed promotion rename before DELETE", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const sandbox = fake.sandboxes.get(source.id);

    if (!sandbox) throw new Error("Fixture sandbox missing");
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    await journal([
      { provider: "microsandbox", id: source.id, kind: "sandbox", parent: null },
      {
        provider: "microsandbox",
        id: slug,
        kind: "service",
        parent: source.id,
        sandboxName: sandbox.name,
        serviceState: "pending",
      },
    ]);
    await writeFile(join(out, "results.json"), JSON.stringify({ runId: run }));
    await p.previewUrl(source.id, 3000);
    const createdAt = fake.services.get(slug)?.createdAt;
    expect(createdAt).toBeDefined();

    const ownershipPath = join(out, "ownership.json");
    const realRename = journalFiles.rename;
    let renameFailures = 0;

    const rename = vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
      if (to === ownershipPath && renameFailures === 0) {
        const parsed = z
          .object({
            resources: z.array(
              z.object({
                id: z.string(),
                serviceState: z.string().optional(),
                serviceCreatedAt: z.string().optional(),
              }),
            ),
          })
          .parse(JSON.parse(await readFile(from, "utf8")));

        const promotion = parsed.resources.find((entry) => entry.id === slug);

        if (promotion?.serviceState === "created" && promotion.serviceCreatedAt === createdAt) {
          renameFailures++;
          throw new Error("simulated one-shot promotion rename failure");
        }
      }

      await realRename(from, to);
    });

    const unprovenDeletes: unknown[] = [];
    let deleteFailures = 0;

    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (
        init?.method === "DELETE" &&
        new URL(String(input)).pathname === `/v1/services/${slug}` &&
        deleteFailures === 0
      ) {
        const parsed = z
          .object({
            resources: z.array(
              z.object({
                id: z.string(),
                serviceState: z.string().optional(),
                serviceCreatedAt: z.string().optional(),
              }),
            ),
          })
          .parse(JSON.parse(await journalText()));

        for (const entry of parsed.resources.filter((r) => r.id === slug))
          if (entry.serviceState !== "created" || entry.serviceCreatedAt !== createdAt)
            unprovenDeletes.push(entry);
        deleteFailures++;

        return Response.json(
          { error: "simulated one-shot Service DELETE failure" },
          { status: 500 },
        );
      }

      return realFetch(input, init);
    });

    // A reap never promotes a pending entry from what it reads, so nothing is renamed or deleted.
    await reap();
    wire.mockRestore();
    rename.mockRestore();

    const failed = await reap();

    const results = z
      .object({ cleanupReview: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(await readFile(join(out, "results.json"), "utf8")));

    expect({
      failed,
      renameFailures,
      deleteFailures,
      reviewedIds: results.cleanupReview.map((item) => item.id),
      ...(await leftForReview(slug)),
      unprovenDeletes,
    }).toEqual({
      failed: true,
      renameFailures: 0,
      deleteFailures: 0,
      reviewedIds: [slug],
      kept: true,
      journaled: true,
      unprovenDeletes: [],
    });
  });

  test("R9-2 runV2 never learns an attached timestamp as proof when POST omitted created_at", async () => {
    const p = adapter();
    const create = p.create.bind(p);
    let slug = "";
    let timestamp: string | undefined;
    p.create = async (input) => {
      const source = await create(input);
      slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
      await p.previewUrl(source.id, 3000);
      timestamp = fake.services.get(slug)?.createdAt;

      return source;
    };

    const proofs: { id: string; serviceState?: string; serviceCreatedAt?: string }[] = [];

    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const { pathname } = new URL(String(input));

      if (pathname === "/v1/services" && init?.method === "POST") {
        const response = await realFetch(input, init);

        const { created_at: _, ...body } = z
          .looseObject({ created_at: z.string() })
          .parse(await response.json());

        return Response.json(body, { status: response.status });
      }

      if (slug && pathname === `/v1/services/${slug}` && init?.method === "DELETE") {
        const parsed = z
          .object({
            resources: z.array(
              z.object({
                id: z.string(),
                serviceState: z.string().optional(),
                serviceCreatedAt: z.string().optional(),
              }),
            ),
          })
          .parse(JSON.parse(await journalText()));

        proofs.push(...parsed.resources.filter((entry) => entry.id === slug));

        return Response.json({ error: "Service DELETE temporarily unavailable" }, { status: 500 });
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
        "5000",
        "--scenarios",
        "cold",
      ]),
      async () => {},
    );
    // A create answer without created_at leaves no identity to match, so the timestamp a later read
    // shows is never learned as proof and no DELETE is sent.
    expect(timestamp).toBeDefined();
    expect(proofs).toEqual([]);
    wire.mockRestore();
    await writeFile(join(out, "results.json"), JSON.stringify({ runId: run }));

    const failed = await reap();

    expect({ failed, ...(await leftForReview(slug)) }).toEqual({
      failed: true,
      kept: true,
      journaled: true,
    });
  });

  test("R10-1 runV2 proves Service on disk before DELETE after a preview settlement rename failure", async () => {
    const ownership = join(out, "ownership.json");
    const p = adapter();
    const destroy = p.destroy.bind(p);
    let sourceId = "";
    let slug = "";
    let timestamp: string | undefined;
    let renameFailures = 0;
    p.destroy = async (sandboxId) => {
      if (sourceId === "") {
        sourceId = sandboxId;
        slug = `sbx-${sandboxId.replaceAll("-", "").slice(0, 16)}-p3000`;
        await expect(p.previewUrl(sandboxId, 3000)).rejects.toThrow(
          "one-shot preview settlement rename failure",
        );
        timestamp = fake.services.get(slug)?.createdAt;
      }

      return destroy(sandboxId);
    };

    const readProof = async (file: Parameters<typeof readFile>[0]) =>
      z
        .object({
          resources: z.array(
            z.object({
              kind: z.string(),
              id: z.string(),
              serviceState: z.enum(["pending", "created"]).optional(),
              serviceCreatedAt: z.string().optional(),
            }),
          ),
        })
        .parse(JSON.parse(await readFile(file, "utf8")))
        .resources.find((r) => r.id === slug);

    const rename = journalFiles.rename;
    vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
      if (to === ownership && slug && renameFailures === 0) {
        const entry = await readProof(from);

        if (entry?.serviceState === "created" && entry.serviceCreatedAt) {
          renameFailures++;
          throw new Error("one-shot preview settlement rename failure");
        }
      }

      await rename(from, to);
    });

    const deletes: { kind: "service" | "sandbox"; proof: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (slug && init?.method === "DELETE") {
        const path = new URL(String(input)).pathname;

        if (path === `/v1/services/${slug}` && !deletes.some((d) => d.kind === "service")) {
          deletes.push({ kind: "service", proof: await readProof(ownership) });

          return Response.json({ error: "one-shot Service DELETE failure" }, { status: 500 });
        }

        if (path === `/v1/sandboxes/${sourceId}` && !deletes.some((d) => d.kind === "sandbox"))
          deletes.push({ kind: "sandbox", proof: await readProof(ownership) });
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
        "5000",
        "--scenarios",
        "cold",
      ]),
      async () => {},
    );
    expect(renameFailures).toBe(1);

    const expected = {
      id: slug,
      kind: "service",
      serviceState: "created",
      serviceCreatedAt: timestamp,
    };

    expect(deletes).toEqual([
      { kind: "service", proof: expected },
      { kind: "sandbox", proof: expected },
    ]);
  });

  test("R10-2 reap sends no fallback Service sweep DELETE for a pending entry it cannot prove", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const sandbox = fake.sandboxes.get(source.id);

    if (sandbox === undefined) throw new Error("Fixture sandbox missing");
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    const ownership = join(out, "ownership.json");
    await p.previewUrl(source.id, 3000);
    const timestamp = fake.services.get(slug)?.createdAt;

    if (timestamp === undefined) throw new Error("Fixture Service missing");
    await journal([
      { provider: "microsandbox", id: source.id, kind: "sandbox", parent: null },
      {
        provider: "microsandbox",
        id: slug,
        kind: "service",
        parent: source.id,
        sandboxName: sandbox.name,
        serviceState: "pending",
      },
    ]);
    await writeFile(join(out, "results.json"), JSON.stringify({ runId: run }));

    const readProof = async (file: Parameters<typeof readFile>[0]) =>
      z
        .object({
          resources: z.array(
            z.object({
              kind: z.string(),
              id: z.string(),
              serviceState: z.enum(["pending", "created"]).optional(),
              serviceCreatedAt: z.string().optional(),
            }),
          ),
        })
        .parse(JSON.parse(await readFile(file, "utf8")))
        .resources.find((r) => r.id === slug);

    const rename = journalFiles.rename;
    let renameFailures = 0;
    let promotionInFlight = false;
    vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
      if (to === ownership && renameFailures === 0) {
        const entry = await readProof(from);

        if (entry?.serviceState === "created" && entry.serviceCreatedAt === timestamp) {
          renameFailures++;
          promotionInFlight = true;
          await new Promise((resolve) => setTimeout(resolve, 350));
          promotionInFlight = false;
          throw new Error("stalled promotion rename eventually failed");
        }
      }

      await rename(from, to);
    });

    const deletes: { proof: unknown; promotionInFlight: boolean }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "DELETE" && new URL(String(input)).pathname === `/v1/services/${slug}`)
        deletes.push({ proof: await readProof(ownership), promotionInFlight });

      return realFetch(input, init);
    });

    // No reap promotes a pending entry from a read, so no promotion write and no DELETE happen.
    await reap();
    expect({ renameFailures, deletes, ...(await leftForReview(slug)) }).toEqual({
      renameFailures: 0,
      deletes: [],
      kept: true,
      journaled: true,
    });
  });

  test.each([true, false])(
    "R11 persists known Service identity before DELETE after preview rename failure (exactGetFails=%s)",
    async (failRead) => {
      const ownership = join(out, "ownership.json");
      const p = adapter();
      const destroy = p.destroy.bind(p);
      let sourceId = "";
      let slug = "";
      let timestamp: string | undefined;
      let promotionFailures = 0;
      let cleanupFaults = 0;
      let startedCleanup = false;
      let proofAtMutation: unknown;

      const readProof = async (file: Parameters<typeof readFile>[0]) =>
        z
          .object({
            resources: z.array(
              z.object({
                kind: z.string(),
                id: z.string(),
                serviceState: z.enum(["pending", "created"]).optional(),
                serviceCreatedAt: z.string().optional(),
              }),
            ),
          })
          .parse(JSON.parse(await readFile(file, "utf8")))
          .resources.find((r) => r.id === slug);

      const rename = journalFiles.rename;
      vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
        if (to === ownership && slug && promotionFailures === 0) {
          const entry = await readProof(from);

          if (entry?.serviceState === "created" && entry.serviceCreatedAt !== undefined) {
            promotionFailures++;
            throw new Error("one-shot preview settlement rename failure");
          }
        }

        await rename(from, to);
      });

      p.destroy = async (sandboxId) => {
        if (sourceId === "") {
          sourceId = sandboxId;
          slug = `sbx-${sandboxId.replaceAll("-", "").slice(0, 16)}-p3000`;
          await expect(p.previewUrl(sandboxId, 3000)).rejects.toThrow(
            "one-shot preview settlement rename failure",
          );
          const service = fake.services.get(slug);

          if (!service || service.createdAt === undefined) throw new Error("Service missing");
          timestamp = service.createdAt;

          if (!failRead) {
            service.target = null;
            service.status = "detached";
          }

          startedCleanup = true;
        }

        return destroy(sandboxId);
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (startedCleanup) {
          const url = new URL(String(input));
          const servicePath = `/v1/services/${slug}`;
          const sandboxPath = `/v1/sandboxes/${sourceId}`;

          if (cleanupFaults === 0 && url.pathname === servicePath) {
            if (failRead && init?.method === "GET") {
              cleanupFaults++;

              return Response.json(
                { error: "one-shot exact Service GET failure" },
                { status: 500 },
              );
            }

            if (!failRead && init?.method === "DELETE") {
              cleanupFaults++;
              proofAtMutation = await readProof(ownership);

              return Response.json({ error: "one-shot Service DELETE failure" }, { status: 500 });
            }
          }

          if (
            failRead &&
            proofAtMutation === undefined &&
            (url.pathname === sandboxPath || url.pathname === servicePath) &&
            init?.method === "DELETE" &&
            fake.services.has(slug)
          )
            proofAtMutation = await readProof(ownership);
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
          "5000",
          "--scenarios",
          "cold",
        ]),
        async () => {},
      );
      vi.restoreAllMocks();
      const failed = await reap();

      expect({
        proofAtMutation,
        failed,
        serviceAfterReap: fake.services.get(slug)?.status,
        stillJournaled: (await readProof(ownership))?.serviceState,
      }).toEqual({
        proofAtMutation: {
          id: slug,
          kind: "service",
          serviceState: "created",
          serviceCreatedAt: timestamp,
        },
        // The SDK's delete failed once; the bench never deletes by slug, so the Service waits for
        // manual cleanup, still journaled with its proof.
        failed: true,
        serviceAfterReap: "detached",
        stillJournaled: "created",
      });
    },
  );

  test("R12 fresh reap keeps an attached Service only a pending entry names, even when filtered Service list fails", async () => {
    const creator = adapter();
    const source = await creator.create({ labels: labels() });
    const ownership = join(out, "ownership.json");
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;

    const readProof = async () =>
      z
        .object({
          resources: z.array(
            z.object({
              id: z.string(),
              kind: z.string(),
              serviceState: z.enum(["pending", "created"]).optional(),
              serviceCreatedAt: z.string().optional(),
            }),
          ),
        })
        .parse(JSON.parse(await readFile(ownership, "utf8")))
        .resources.find((entry) => entry.id === slug);

    creator.setAttemptHooks({
      service: async ({ sandboxId, sandboxName, slug: attemptSlug }) => {
        await journal([
          { provider: "microsandbox", id: sandboxId, kind: "sandbox", parent: null },
          {
            provider: "microsandbox",
            id: attemptSlug,
            kind: "service",
            parent: sandboxId,
            sandboxName,
            serviceState: "pending",
          },
        ]);
      },
    });
    await creator.previewUrl(source.id, 3000);
    const service = fake.services.get(slug);

    if (!service || service.target === null || service.createdAt === undefined)
      throw new Error("Fixture did not create the attached Service");
    const createdAt = service.createdAt;
    let failedLists = 0;
    let proofAtFirstDelete: unknown;
    let firstDelete: string | undefined;
    const servicePath = `/v1/services/${slug}`;
    const sandboxPath = `/v1/sandboxes/${source.id}`;

    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if (
        failedLists === 0 &&
        init?.method === "GET" &&
        url.pathname === "/v1/services" &&
        url.searchParams.get("sandbox") === service.target?.sandbox
      ) {
        failedLists++;

        return Response.json({ error: "one-shot filtered Service list failure" }, { status: 500 });
      }

      if (
        firstDelete === undefined &&
        init?.method === "DELETE" &&
        (url.pathname === servicePath || url.pathname === sandboxPath)
      ) {
        firstDelete = url.pathname;
        proofAtFirstDelete = await readProof();
      }

      return realFetch(input, init);
    });

    await reap();
    expect(failedLists).toBe(1);
    wire.mockRestore();

    const retryFailed = await reap();

    // Attachment never promotes the pending entry: only the sandbox is deleted, and the Service
    // stays journaled as pending for review.
    expect({
      firstDelete,
      proofAtFirstDelete,
      retryFailed,
      serviceAfterRetry: fake.services.get(slug)?.createdAt,
      stillJournaled: (await readProof())?.serviceState,
    }).toEqual({
      firstDelete: sandboxPath,
      proofAtFirstDelete: { id: slug, kind: "service", serviceState: "pending" },
      retryFailed: true,
      serviceAfterRetry: createdAt,
      stillJournaled: "pending",
    });
  });

  test("R13 fresh reap holds parent sandbox while a pending Service create returns 404 so a late POST remains recoverable", async () => {
    const creator = adapter();
    const source = await creator.create({ labels: labels() });
    const ownership = join(out, "ownership.json");
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;

    creator.setAttemptHooks({
      service: async ({ sandboxId, sandboxName, slug: attemptSlug }) => {
        await journal([
          { provider: "microsandbox", id: sandboxId, kind: "sandbox", parent: null },
          {
            provider: "microsandbox",
            id: attemptSlug,
            kind: "service",
            parent: sandboxId,
            sandboxName,
            serviceState: "pending",
          },
        ]);
      },
    });

    let finalizePost: (() => Promise<void>) | undefined;

    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if ((init?.method ?? "GET") === "POST" && url.pathname === "/v1/services") {
        finalizePost = async () => {
          const accepted = await realFetch(input, { ...init, signal: null });
          await accepted.body?.cancel();
          expect(accepted.status).toBe(201);
        };

        throw new TypeError("connection lost while Service POST was in flight");
      }

      return realFetch(input, init);
    });

    await expect(creator.previewUrl(source.id, 3000)).rejects.toThrow();
    expect(finalizePost).toBeDefined();
    expect(await reap()).toBe(true);
    expect(fake.sandboxes.has(source.id)).toBe(true);
    wire.mockRestore();
    await finalizePost?.();
    // The late create lands attached, but nothing proves it is this run's: the sandbox goes, and the
    // Service stays journaled for review.
    expect(await reap()).toBe(true);
    expect({
      sandbox: fake.sandboxes.has(source.id),
      ...(await leftForReview(slug)),
      ownership: (await readFile(ownership, "utf8")).includes(slug),
    }).toEqual({ sandbox: false, kept: true, journaled: true, ownership: true });
  });

  test("R14-1 runV2 holds parent sandbox while a pending Service create returns 404 so a late POST remains recoverable", async () => {
    const provider = adapter();
    const create = provider.create.bind(provider);
    let boxId = "";
    let slug = "";
    let postAccepted = false;
    let finalizePost: (() => Promise<void>) | undefined;

    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (method === "POST" && url.pathname === "/v1/services") {
        finalizePost = async () => {
          const accepted = await realFetch(input, { ...init, signal: null });
          await accepted.body?.cancel();
          expect(accepted.status).toBe(201);
          postAccepted = true;
        };

        throw new TypeError("connection lost while Service POST was in flight");
      }

      if (method === "DELETE" && url.pathname === `/v1/sandboxes/${boxId}`) {
        if (finalizePost && !postAccepted) await finalizePost();
      }

      return realFetch(input, init);
    });

    provider.create = async (input) => {
      const result = await create(input);
      boxId = result.id;
      slug = `sbx-${boxId.replaceAll("-", "").slice(0, 16)}-p3000`;
      await expect(provider.previewUrl(boxId, 3000)).rejects.toThrow();

      return result;
    };

    await runV2(
      loaded(provider),
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
        "1500",
        "--scenarios",
        "cold",
      ]),
      async () => {},
    );
    wire.mockRestore();

    if (finalizePost && !postAccepted) await finalizePost();
    // The late create lands attached, but nothing proves it is this run's: it is kept for review.
    expect(await reap()).toBe(true);
    expect({ sandbox: fake.sandboxes.has(boxId), ...(await leftForReview(slug)) }).toEqual({
      sandbox: false,
      kept: true,
      journaled: true,
    });
  }, 15_000);

  test("R14-2 superseded 409 base slug does not block sandbox cleanup after retry retires and sandbox DELETE fails once", async () => {
    const p = adapter();
    const source = await p.create({ labels: labels() });
    const slug = `sbx-${source.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    const sandboxPath = `/v1/sandboxes/${source.id}`;
    const servicePath = `/v1/services/${slug}`;

    const initialEntries: {
      provider: string;
      id: string;
      kind: string;
      parent: string | null;
      sandboxName?: string;
      serviceState?: "pending" | "created";
      serviceCreatedAt?: string;
    }[] = [{ provider: "microsandbox", id: source.id, kind: "sandbox", parent: null }];

    fake.services.set(slug, { slug, target: null, status: "detached" });

    const wire = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () =>
        Response.json({ error: { code: "service_not_found" } }, { status: 404 }),
      );

    p.setAttemptHooks({
      service: async ({ sandboxId, sandboxName, slug: attemptSlug }) => {
        initialEntries.push({
          provider: "microsandbox",
          id: attemptSlug,
          kind: "service",
          parent: sandboxId,
          sandboxName,
          serviceState: "pending",
        });
        await journal(initialEntries);
      },
      serviceSettled: async ({ slug: settledSlug, outcome, createdAt }) => {
        if (outcome === "conflict") throw new Error("simulated failed conflict journal write");
        const found = initialEntries.find((entry) => entry.id === settledSlug);

        if (found) {
          found.serviceState = "created";
          found.serviceCreatedAt = createdAt;
        }

        await journal(initialEntries);
      },
    });

    await expect(p.previewUrl(source.id, 3000)).rejects.toThrow(
      "simulated failed conflict journal write",
    );
    await p.previewUrl(source.id, 3000);

    const retry = initialEntries.find((entry) => entry.id.startsWith(`${slug}-`));

    if (!retry) throw new Error("expected retry slug");
    // Deleted by hand, as cleanup asks: the reap only settles the journal.
    fake.services.delete(retry.id);

    const removedByOwner = await realFetch(`${fake.url}${servicePath}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(removedByOwner.status).toBe(204);

    let rejectedSandboxDelete = false;
    wire.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (method === "DELETE" && url.pathname === sandboxPath && !rejectedSandboxDelete) {
        rejectedSandboxDelete = true;

        return Response.json({ error: { code: "internal_error" } }, { status: 500 });
      }

      return realFetch(input, init);
    });

    await reap();
    expect(rejectedSandboxDelete).toBe(true);
    expect(fake.sandboxes.has(source.id)).toBe(true);
    expect(fake.services.has(retry.id)).toBe(false);

    expect(await reap()).toBe(false);
    expect(fake.sandboxes.has(source.id)).toBe(false);
    expect(fake.services.has(retry.id)).toBe(false);
  });

  test("R15-1 an older retry slug does not mask a newer pending base-slug attempt", async () => {
    const provider = adapter();
    const create = provider.create.bind(provider);
    let boxId = "";
    let slug = "";
    let retrySlug = "";
    let phase: "first" | "second" | "done" = "first";
    let postAccepted = false;
    let finalizePost: (() => Promise<void>) | undefined;

    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (phase === "first" && method === "GET" && url.pathname === `/v1/services/${slug}`)
        return Response.json({ error: { code: "service_not_found" } }, { status: 404 });

      if (phase === "first" && method === "POST" && url.pathname === "/v1/services") {
        const body = z.object({ slug: z.string() }).parse(JSON.parse(String(init?.body ?? "{}")));

        if (body.slug.startsWith(`${slug}-`)) {
          retrySlug = body.slug;

          return Response.json({ error: { code: "internal_error" } }, { status: 503 });
        }
      }

      if (phase === "second" && method === "POST" && url.pathname === "/v1/services") {
        finalizePost = async () => {
          const accepted = await realFetch(input, { ...init, signal: null });
          await accepted.body?.cancel();
          expect(accepted.status).toBe(201);
          postAccepted = true;
        };

        throw new TypeError("connection lost while re-attempted base POST was in flight");
      }

      return realFetch(input, init);
    });

    provider.create = async (input) => {
      const result = await create(input);
      boxId = result.id;
      slug = `sbx-${boxId.replaceAll("-", "").slice(0, 16)}-p3000`;
      fake.services.set(slug, { slug, target: null, status: "detached" });

      // First call hits 409 on base slug and journals a retry slug whose POST returns 503.
      await expect(provider.previewUrl(boxId, 3000)).rejects.toThrow();
      expect(retrySlug).toMatch(new RegExp(`^${slug}-[0-9a-f]{4}$`));

      // Foreign owner deletes base slug, then a second call re-attempts base slug and loses its reply.
      fake.services.delete(slug);
      phase = "second";
      await expect(provider.previewUrl(boxId, 3000)).rejects.toThrow();
      phase = "done";

      return result;
    };

    await runV2(
      loaded(provider),
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
        "1500",
        "--scenarios",
        "cold",
      ]),
      async () => {},
    );
    wire.mockRestore();

    // The older retry slug must NOT have masked the newer pending base slug, so sandbox stays alive.
    expect(fake.sandboxes.has(boxId)).toBe(true);
    expect(finalizePost).toBeDefined();

    if (finalizePost && !postAccepted) await finalizePost();

    // Simulate the older retry slug being already gone on server (confirming only base needs cleanup).
    const parsed = z
      .looseObject({
        runId: z.string(),
        resources: z.array(
          z.looseObject({
            provider: z.string(),
            id: z.string(),
            kind: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(await journalText()));

    // Drop the old never-created retry entry as if its own sweep settled, keeping base + sandbox.
    const withoutOldRetry = parsed.resources.filter((r) => r.id !== retrySlug);
    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({ ...parsed, resources: withoutOldRetry }),
    );

    // The base slug's late create lands attached, but nothing proves it is this run's: kept for review.
    expect(await reap()).toBe(true);
    expect({ sandbox: fake.sandboxes.has(boxId), ...(await leftForReview(slug)) }).toEqual({
      sandbox: false,
      kept: true,
      journaled: true,
    });
  }, 15_000);

  test("R15-2 a failed pre-POST Service journal write does not leave a phantom pending entry blocking cleanup", async () => {
    const provider = adapter();
    const create = provider.create.bind(provider);
    let boxId = "";
    let slug = "";
    let servicePostCalls = 0;
    let injectedJournalFailure = false;

    const realRename = journalFiles.rename;

    const renameSpy = vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
      if (
        !injectedJournalFailure &&
        slug !== "" &&
        String(to).endsWith("ownership.json") &&
        (await readFile(from, "utf8")).includes(slug)
      ) {
        injectedJournalFailure = true;
        throw new Error("simulated pre-POST Service journal write failure");
      }

      return realRename(from, to);
    });

    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if ((init?.method ?? "GET") === "POST" && url.pathname === "/v1/services") servicePostCalls++;

      return realFetch(input, init);
    });

    provider.create = async (input) => {
      const result = await create(input);
      boxId = result.id;
      slug = `sbx-${boxId.replaceAll("-", "").slice(0, 16)}-p3000`;
      await expect(provider.previewUrl(boxId, 3000)).rejects.toThrow(
        "simulated pre-POST Service journal write failure",
      );

      return result;
    };

    await runV2(
      loaded(provider),
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
        "5000",
        "--scenarios",
        "cold",
      ]),
      async () => {},
    );
    renameSpy.mockRestore();
    wire.mockRestore();

    expect(injectedJournalFailure).toBe(true);
    expect(servicePostCalls).toBe(0);
    expect(fake.sandboxes.has(boxId)).toBe(false);

    const resources = z
      .object({ resources: z.array(z.looseObject({ id: z.string(), kind: z.string() })) })
      .parse(JSON.parse(await journalText())).resources;

    expect(resources).toEqual([]);
  });

  test("R15-3 concurrent burst refusal is not restored when a sibling pre-POST journal rename completes", async () => {
    const provider = adapter();
    const create = provider.create.bind(provider);
    let firstName = "";
    let firstPost = true;
    let gated = false;
    let releaseRefusal = () => {};

    const refusalReady = new Promise<void>((resolve) => {
      releaseRefusal = resolve;
    });

    let releasePostSeen = () => {};

    const postSeen = new Promise<void>((resolve) => {
      releasePostSeen = resolve;
    });

    let releaseHandled = () => {};

    const handled = new Promise<void>((resolve) => {
      releaseHandled = resolve;
    });

    provider.create = async (input) => {
      try {
        return await create(input);
      } catch (error) {
        setImmediate(releaseHandled);
        throw error;
      }
    };

    const realRename = journalFiles.rename;

    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if (firstPost && init?.method === "POST" && url.pathname === "/v1/sandboxes") {
        firstPost = false;
        firstName = z
          .object({ spec: z.object({ name: z.string() }) })
          .parse(JSON.parse(String(init.body))).spec.name;
        releasePostSeen();
        await refusalReady;

        return Response.json(
          { error: { code: "invalid_argument", message: "definite refusal" } },
          { status: 400 },
        );
      }

      return realFetch(input, init);
    });

    const renameSpy = vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
      const candidate = z
        .object({ resources: z.array(z.looseObject({ kind: z.string(), id: z.string() })) })
        .parse(JSON.parse(await readFile(from, "utf8")));

      if (
        !gated &&
        candidate.resources.filter((r) => r.kind === "allocation-attempt").length === 2
      ) {
        gated = true;
        await postSeen;
        releaseRefusal();
        await handled;
      }

      return realRename(from, to);
    });

    try {
      await runV2(
        loaded(provider),
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
          "2",
          "--burst-cohorts",
          "1",
          "--concurrency",
          "2",
          "--scenarios",
          "burst",
          "--timeout-ms",
          "5000",
          "--ownership-visibility-ms",
          "100",
        ]),
        async () => {},
      );
    } finally {
      releaseRefusal();
      renameSpy.mockRestore();
      wire.mockRestore();
    }

    expect(firstName).not.toBe("");
    expect(gated).toBe(true);
    expect(fake.sandboxes.size).toBe(0);

    const afterRun = z
      .object({ resources: z.array(z.looseObject({ kind: z.string(), id: z.string() })) })
      .parse(JSON.parse(await journalText())).resources;

    expect(afterRun).toEqual([]);
    expect(await reap()).toBe(false);

    const afterReap = z
      .object({ resources: z.array(z.looseObject({ kind: z.string(), id: z.string() })) })
      .parse(JSON.parse(await journalText())).resources;

    expect(afterReap).toEqual([]);
  });
});

describe("PR88 merge review: recovery reads through the run adapter's connection", () => {
  it("drops a capture's name entry when its request never went out", async () => {
    const out = await directory("bench-msb-not-started-");
    const provider = adapter();
    const names: string[] = [];
    let failNextRead = false;
    const setHooks = provider.setAttemptHooks.bind(provider);

    provider.setAttemptHooks = (hooks: MicrosandboxHooks | undefined) =>
      setHooks({
        ...hooks,
        snapshot: async (attempt) => {
          await hooks?.snapshot?.(attempt);
          names.push(attempt.name);
          failNextRead = true;
        },
      });

    const capture = provider.snapshot?.bind(provider);
    const keptAfterFailure: unknown[] = [];

    // What a run that died right after the failed capture would leave for the reap.
    provider.snapshot = async (...args) => {
      try {
        return await capture!(...args);
      } catch (error) {
        keptAfterFailure.push(
          ...(await readJournal(out)).resources.filter((r) => names.includes(r.id)),
        );
        throw error;
      }
    };

    const original = globalThis.fetch.bind(globalThis);

    // The capture's first read of its source fails, before any capture request is sent.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));

      if (
        failNextRead &&
        (init?.method ?? "GET") === "GET" &&
        /^\/v1\/sandboxes\/[^/]+$/.test(url.pathname)
      ) {
        failNextRead = false;

        return Response.json({ error: { code: "forbidden" } }, { status: 403 });
      }

      return original(input, init);
    });

    await runV2(
      [{ kind: "ready", name: "microsandbox", cloud: true, region: null, provider }],
      parseV2([
        "--providers",
        "microsandbox",
        "--runs",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "snapshot",
        "--timeout-ms",
        "60000",
        "--out",
        out,
      ]),
      async () => {},
    );

    expect(names.length).toBeGreaterThan(0);
    expect({
      captures: fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/snapshots")
        .length,
      keptAfterFailure,
      kept: (await readJournal(out)).resources.filter((r) => names.includes(r.id)),
    }).toEqual({ captures: 0, keptAfterFailure: [], kept: [] });
  }, 60_000);

  it("keeps the connection fingerprint in the journal an allocation hook writes", async () => {
    const out = await directory("bench-msb-hook-fingerprint-");
    const provider = adapter();
    const atHook: unknown[] = [];
    const setHooks = provider.setAttemptHooks.bind(provider);

    // What a run that died right after sending its create would leave for the reap.
    provider.setAttemptHooks = (hooks: MicrosandboxHooks | undefined) =>
      setHooks({
        ...hooks,
        create: async (attempt) => {
          await hooks?.create?.(attempt);
          atHook.push(
            JSON.parse(await readFile(join(out, "ownership.json"), "utf8")).connectionFingerprints,
          );
        },
      });

    await runV2(
      [{ kind: "ready", name: "microsandbox", cloud: true, region: null, provider }],
      parseV2([
        "--providers",
        "microsandbox",
        "--runs",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "cold",
        "--timeout-ms",
        "60000",
        "--out",
        out,
      ]),
      async () => {},
    );

    const expected = { microsandbox: await fingerprintOf(provider) };

    expect(atHook.length).toBeGreaterThan(0);
    expect(atHook).toEqual(atHook.map(() => expected));
  }, 60_000);

  it("cleans a journaled Service through the bound connection when the environment has changed", async () => {
    const provider = adapter();
    const run = "msb-reap-connection";
    const out = await directory("bench-msb-connection-");
    const box = await provider.create({ labels: runLabels(run) });
    const name = fake.sandboxes.get(box.id)?.name ?? "";
    const { url } = await provider.previewUrl(box.id, 3000);
    const slug = new URL(url).pathname.split("/").at(-1) ?? "";

    await fetch(`${fake.url}/v1/sandboxes/${box.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        connectionFingerprints: await fingerprints(provider),
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
        ],
      }),
    );

    // Deleted by hand, as cleanup asks: only a read through the bound connection sees it gone.
    fake.services.delete(slug);
    // The adapter was bound with the fake's endpoint and key; the environment now names another.
    vi.stubEnv("MSB_API_URL", "http://127.0.0.1:9");
    vi.stubEnv("MSB_API_KEY", "msb_other_key_0123456789");

    await reapRun(
      [{ kind: "ready", name: "microsandbox", cloud: true, region: null, provider }],
      parseV2(["--providers", "microsandbox", "--run", run, "--out", out]),
      (s) => s,
    );

    expect({
      service: fake.services.has(slug),
      journal: (await readJournal(out)).resources,
    }).toEqual({ service: false, journal: [] });
  }, 60_000);
});

describe("PR88 security review", () => {
  const securityLabels = () => ({
    "sandbox-bench-run": crypto.randomUUID(),
    "sandbox-sdk": "1",
    "sandbox-bench-tier": "standard",
  });

  test("PR88-S1 the key never goes over plain http to a host off this machine", async () => {
    const sent = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sent"));

    const outcome = await microsandboxFetch(
      { apiKey: key, baseUrl: "http://api.microsandbox.example" },
      "/sandboxes",
    ).catch((error: Error) => error.message);

    expect({ outcome, sent: sent.mock.calls.length }).toEqual({
      outcome: "Microsandbox API URL must use https; plain http is allowed only for loopback",
      sent: 0,
    });
  });

  test("PR88-S1 an existence probe never follows a redirect to another origin's 404", async () => {
    let followed = 0;

    const elsewhere = createServer((_request, response) => {
      followed++;
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: "sandbox_not_found" } }));
    });

    await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
    const target = `http://127.0.0.1:${z.object({ port: z.number() }).parse(elsewhere.address()).port}`;

    const redirector = createServer((request, response) => {
      response.writeHead(302, { Location: `${target}${request.url ?? "/"}` });
      response.end();
    });

    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${z.object({ port: z.number() }).parse(redirector.address()).port}`;

    try {
      const p = bound(
        microsandbox({
          apiKey: key,
          baseUrl,
          computeType: "standard",
          peer: async () => fake.peer,
        }),
        { apiKey: key, baseUrl },
      );

      const evidence = await lookupSandbox(p, crypto.randomUUID(), 2000);

      expect({ result: evidence.result, followed }).toEqual({
        result: expect.not.stringMatching(/^not-found$/),
        followed: 0,
      });
    } finally {
      elsewhere.close();
      redirector.close();
    }
  });

  test.each([
    ["attached", { sandbox: "ours", port: 3000 }, "enabled"],
    ["detached", null, "detached"],
  ] as const)(
    "backfill #88: cleanService keeps a proven %s Service for manual cleanup and sends no DELETE",
    async (_, target, status) => {
      const createdAt = "2026-11-25T09:00:00.000Z";
      const methods: string[] = [];

      const send = globalThis.fetch.bind(globalThis);

      fake.services.set("proven-slug", { slug: "proven-slug", target, status, createdAt });

      const wire = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        methods.push(init?.method ?? "GET");

        return send(input, init);
      });

      const outcome = await cleanService(
        { apiKey: key, baseUrl: fake.url },
        {
          id: "proven-slug",
          parent: null,
          sandboxName: "ours",
          state: "created",
          createdAt,
          superseded: false,
        },
      );

      expect({ outcome, kept: fake.services.has("proven-slug"), methods }).toEqual({
        outcome: { kind: "pending", reason: expect.stringMatching(/manual cleanup/) },
        kept: true,
        methods: ["GET"],
      });
      wire.mockRestore();
      fake.services.delete("proven-slug");
    },
  );

  test("PR88-S2 cleanService never deletes an attached Service made again at its slug", async () => {
    fake.services.set("re-made-slug", {
      slug: "re-made-slug",
      target: { sandbox: "ours", port: 3000 },
      status: "enabled",
      createdAt: "2026-11-25T10:00:00.000Z",
    });

    const outcome = await cleanService(
      { apiKey: key, baseUrl: fake.url },
      {
        id: "re-made-slug",
        parent: null,
        sandboxName: "ours",
        state: "created",
        createdAt: "2026-11-25T09:00:00.000Z",
        superseded: false,
      },
    );

    expect({ outcome, kept: fake.services.has("re-made-slug") }).toEqual({
      outcome: { kind: "foreign" },
      kept: true,
    });
    fake.services.delete("re-made-slug");
  });

  test("PR88-S3 a raw-path peer error reaches the report without the key", async () => {
    let box: RawMicrosandboxBox | undefined;

    box = await createRawMicrosandbox({
      connection: { apiKey: key, baseUrl: fake.url },
      computeType: "standard",
      labels: securityLabels(),
      peer: {
        RemoteContext: class {
          sandboxes = {
            get: async () => {
              throw new Error(`401 for Bearer ${key}, token msb_pat_0123456789abcdef`);
            },
          };
        },
      },
      admit: (admitted) => {
        box = admitted;
      },
    });

    try {
      const shown = await box.exec().then(
        () => "",
        (error: Error) => error.message,
      );

      expect({
        key: shown.includes(key),
        pat: shown.includes("msb_pat_"),
        redacted: shown.includes("[redacted]"),
      }).toEqual({ key: false, pat: false, redacted: true });
    } finally {
      await box.destroy();
    }
  });

  test("PR88-S5 a caller-set source label never outweighs the snapshot's own sandbox_id", () => {
    const snapshot = (sandboxId: string | null) => ({
      name: "n",
      location: { type: "managed", id: crypto.randomUUID() },
      sandbox_id: sandboxId,
      labels: { "sandbox-sdk-source": "ours" },
    });

    expect([
      capturedFrom(snapshot("theirs"), "ours"),
      capturedFrom(snapshot(null), "ours"),
      capturedFrom(snapshot("ours"), "ours"),
    ]).toEqual([false, true, true]);
  });
});

describe("PR88 security review, second round", () => {
  test("PR88-S1 billing never sends the key over plain http to a host off this machine", async () => {
    let sent = 0;

    await collectProvider(
      "microsandbox",
      [
        {
          provider: "microsandbox",
          id: crypto.randomUUID(),
          startedAt: "2026-11-24T10:00:00.000Z",
          finishedAt: "2026-11-24T10:01:00.000Z",
          scenarios: new Set(),
          confirmedStopAt: null,
          app: null,
        },
      ],
      { MSB_API_KEY: key, MSB_API_URL: "http://billing.microsandbox.example" },
      async () => {
        sent++;

        return { rows: [], sandboxes: [] };
      },
    );

    expect(sent).toBe(0);
  });

  test("PR88-S3 redaction finds the key and token shapes in the original text, however they overlap", () => {
    expect([
      redactMicrosandbox("x KEYmsb_pat_1y z", "KEYmsb_p"),
      redactMicrosandbox("short k9 key", "k9"),
    ]).toEqual(["x [redacted] z", "short [redacted] key"]);
  });
});

describe("PR88 security review, third round", () => {
  const realFetch = globalThis.fetch.bind(globalThis);

  test("PR88-S2 cleanService never deletes an attached Service whose live read lacks the recorded timestamp", async () => {
    fake.services.set("no-stamp-slug", {
      slug: "no-stamp-slug",
      target: { sandbox: "ours", port: 3000 },
      status: "enabled",
    });

    // The live read carries no created_at at all.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);

      if (new URL(String(input)).pathname !== "/v1/services/no-stamp-slug") return response;

      return Response.json(
        z
          .looseObject({})
          .parse(JSON.parse((await response.text()).replaceAll(/"created_at":"[^"]*",?/g, ""))),
        { status: response.status },
      );
    });

    const outcome = await cleanService(
      { apiKey: key, baseUrl: fake.url },
      {
        id: "no-stamp-slug",
        parent: null,
        sandboxName: "ours",
        state: "created",
        createdAt: "2026-11-25T09:00:00.000Z",
        superseded: false,
      },
    );

    expect({ outcome: outcome.kind, kept: fake.services.has("no-stamp-slug") }).toEqual({
      outcome: "pending",
      kept: true,
    });
    fake.services.delete("no-stamp-slug");
  });
});

describe("control-plane answers are read with a byte cap", () => {
  it("parses an answer within the cap", async () => {
    expect(
      await readMicrosandboxJson(Response.json({ id: "sbx" }), z.object({ id: z.string() })),
    ).toEqual({ id: "sbx" });
  });

  it("cancels and refuses an answer past the cap before parsing it", async () => {
    let pulled = 0;
    let cancelled = false;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readMicrosandboxJson(new Response(body), z.unknown())).rejects.toThrow(
      /larger than/,
    );
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(maxMicrosandboxAnswerBytes + 2 * 64 * 1024);
  });
});
