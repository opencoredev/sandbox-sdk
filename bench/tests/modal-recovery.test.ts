import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { CreateInput, Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import { collectBilling } from "../src/billing.js";
import { collectModal, modalSettledAt, type ModalReport } from "../src/billing/modal.js";
import { readRun, type OwnedSandbox } from "../src/billing/input.js";
import { lookupSandbox, type GrpcMiddleware, type GrpcMiddlewareCall } from "../src/existence.js";
import {
  allocationLabel,
  appLabel,
  attemptApp,
  ambiguousAllocations,
  beginAllocation,
  failedAllocation,
  journalApp,
  journalAppSchema,
  type PendingSandbox,
} from "../src/modal-apps.js";
import { destroyTimings } from "../src/providers.js";
import { reapRun } from "../src/recovery.js";
import { parseV2 } from "../src/v2-config.js";
import { runV2 } from "../src/v2-runner.js";
import { fakeNativeModules } from "./native-fakes.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((out) => rm(out, { recursive: true, force: true })));
});

async function directory() {
  const out = await mkdtemp(join(tmpdir(), "bench-modal-recovery-"));
  dirs.push(out);

  return out;
}

/**
 * Modal as the bench sees it, across process restarts: sandboxes live in Apps, and one adapter
 * instance lists only the default App plus the Apps it has created into or prepared, as the real
 * adapter does (Modal deprecates Environment-wide listing).
 */
function modalCloud() {
  const backing = memory();
  const appOf = new Map<string, string>();
  const existing = new Set(["sandbox-sdk"]);
  const prepared: { name: string; journaled: boolean }[] = [];

  /** Allocate a sandbox in the App its labels name, as Modal does on create. */
  async function allocate(input: CreateInput, known: Set<string>) {
    const app = input.labels?.[appLabel] ?? "sandbox-sdk";
    const info = await backing.create(input);
    appOf.set(info.id, app);
    existing.add(app);
    known.add(app);

    return info;
  }

  function process(
    options: {
      destroy?: Provider["destroy"];
      journal?: string;
      /** Replaces create; `allocate` is Modal's own allocation, before any response. */
      create?: (
        input: CreateInput,
        allocate: (input: CreateInput) => Promise<SandboxInfo>,
      ) => Promise<SandboxInfo>;
    } = {},
  ) {
    const known = new Set(["sandbox-sdk"]);
    const visible = (info: SandboxInfo) => known.has(appOf.get(info.id) ?? "sandbox-sdk");

    const adapter: Provider & {
      prepareApp(
        name: string,
        settings?: { createIfMissing?: boolean },
      ): Promise<{ name: string; appId: string } | null>;
      listPending(labels: Record<string, string>): Promise<PendingSandbox[]>;
    } = {
      ...backing,
      name: "modal",
      create: (input) =>
        options.create
          ? options.create(input, (next) => allocate(next, known))
          : allocate(input, known),
      list: async (labels) => (await backing.list(labels)).filter(visible),
      // Restores tagged pending, in the Apps this process knows, as the adapter lists them.
      listPending: async (labels) =>
        (await backing.list({ ...labels, "sandbox-sdk": "pending" }))
          .filter(visible)
          .map((info) => ({ id: info.id, labels: info.labels })),
      destroy: options.destroy ?? backing.destroy,
      prepareApp: async (name, settings = {}) => {
        // Records whether the App was already in the ownership journal when it was prepared.
        const journal = options.journal
          ? await readFile(options.journal, "utf8").catch(() => "")
          : "";

        prepared.push({ name, journaled: journal.includes(`"${name}"`) });

        if (!existing.has(name) && settings.createIfMissing === false) return null;
        existing.add(name);
        known.add(name);

        return { name, appId: `ap-${name}` };
      },
    };

    return adapter;
  }

  return { backing, appOf, existing, prepared, process };
}

describe("per-attempt Modal Apps", () => {
  it("journals each App before allocating in it, and a restarted reap prepares it to find the sandbox", async () => {
    const out = await directory();
    const run = "modal-restart";
    const cloud = modalCloud();

    const config = parseV2([
      "--providers",
      "modal",
      "--runs",
      "2",
      "--scenarios",
      "command",
      "--bursts",
      "",
      "--timeout-ms",
      "1500",
      "--ownership-visibility-ms",
      "1000",
      "--app-per-attempt",
      "modal",
      "--run",
      run,
      "--out",
      out,
    ]);

    // The first process cannot delete anything, as if it crashed before cleanup.
    const crashed = cloud.process({
      journal: join(out, "ownership.json"),
      destroy: async () => {
        throw new Error("process died");
      },
    });

    await runV2(
      [{ kind: "ready", name: "modal", cloud: false, region: null, provider: crashed }],
      config,
      async () => {},
    );

    const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
    const apps = journalAppSchema.array().parse(journal.apps);
    expect(apps.map((app) => app.name).sort()).toEqual(
      [attemptApp(run, 0), attemptApp(run, 1)].sort(),
    );

    for (const app of apps) {
      expect(app).toMatchObject({ provider: "modal", appId: `ap-${app.name}` });
      expect(app.sandboxes).toHaveLength(1);
      expect(cloud.appOf.get(app.sandboxes[0] ?? "")).toBe(app.name);
    }

    // Prepared only once journaled, before the create that allocates in it.
    expect(cloud.prepared.length).toBeGreaterThanOrEqual(2);
    expect(cloud.prepared.every((entry) => entry.journaled)).toBe(true);

    const leftovers = await cloud.backing.list({ "sandbox-bench-run": run });
    expect(leftovers).toHaveLength(2);

    // A fresh process knows only the default App until it prepares the journaled ones.
    const restarted = cloud.process();
    expect(await restarted.list({ "sandbox-bench-run": run })).toEqual([]);

    // Drop the sandbox IDs from the journal too: discovery must come from listing the Apps.
    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({ ...journal, resources: [] }, null, 2),
    );

    const failed = await reapRun(
      [{ kind: "ready", name: "modal", cloud: false, region: null, provider: restarted }],
      config,
      (s) => s,
    );

    expect(failed).toBe(false);
    expect(await cloud.backing.list({ "sandbox-bench-run": run })).toEqual([]);
    // Recovery looked the Apps up without creating any, and kept them journaled.
    expect(
      cloud.prepared
        .slice(-2)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(apps.map((app) => app.name).sort());
    const after = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
    expect(journalAppSchema.array().parse(after.apps)).toHaveLength(2);
  });

  it("a reap in a fresh process deletes a journaled sandbox that only its App's listing shows", async () => {
    const out = await directory();
    const run = "modal-fresh";
    const cloud = modalCloud();
    const owner = cloud.process();
    await owner.prepareApp("sandbox-bench-x");

    const box = await owner.create({
      labels: { "sandbox-bench-run": run, "sandbox-sdk": "1", [appLabel]: "sandbox-bench-x" },
    });

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        resources: [{ provider: "modal", id: box.id, kind: "sandbox", parent: null }],
        apps: [
          { provider: "modal", name: "sandbox-bench-x", appId: "ap-x", sandboxes: [box.id] },
          // Journaled before a create that never happened: looked up, never created.
          { provider: "modal", name: "sandbox-bench-never", appId: null, sandboxes: [] },
        ],
      }),
    );

    const config = parseV2([
      "--run",
      run,
      "--out",
      out,
      "--timeout-ms",
      "1000",
      "--providers",
      "modal",
    ]);

    // As the adapter's onDestroy does once Modal reports the stop (or that the sandbox is gone).
    const fresh = cloud.process({
      destroy: async (id) => {
        await cloud.backing.destroy(id);
        destroyTimings.set(`modal/${id}`, { sandboxId: id, requestMs: null, stoppedMs: 40 });
      },
    });

    expect(
      await reapRun(
        [{ kind: "ready", name: "modal", cloud: false, region: null, provider: fresh }],
        config,
        (s) => s,
      ),
    ).toBe(false);
    expect(await cloud.backing.list({ "sandbox-bench-run": run })).toEqual([]);
    expect(cloud.existing.has("sandbox-bench-never")).toBe(false);
    // Recovery journals the confirmed stop, so billing can settle the App's charge.
    const [owned] = await readRun(out);
    expect(owned).toMatchObject({ id: box.id, confirmedStopAt: expect.any(String) });
  });

  it("names Apps within Modal's limits, stably, and leaves unlabelled runs in the default App", () => {
    const long = "r".repeat(100);
    expect(attemptApp(long, 3)).toMatch(/^[\w.-]{1,63}$/);
    expect(attemptApp(long, 3)).toBe(attemptApp(long, 3));
    expect(attemptApp(long, 3)).not.toBe(attemptApp(long, 4));
    expect(attemptApp("pub-1", 7)).toBe("sandbox-bench-pub-1-i7");
    expect(parseV2([])["app-per-attempt"]).toEqual([]);
    expect(() => parseV2(["--app-per-attempt", "e2b"])).toThrow();
  });
});

describe("Modal native existence", () => {
  class ClientError extends Error {
    constructor(
      readonly code: number,
      message: string,
    ) {
      super(message);
    }
  }

  /** `poll` answers each sandbox's poll RPC; it sees the call's signal, as nice-grpc passes it. */
  function fakeModal(poll: (id: string, signal?: AbortSignal) => Promise<number | null>) {
    const closed: string[] = [];

    fakeNativeModules({
      "nice-grpc": { ClientError, Status: { NOT_FOUND: 5 } },
      modal: {
        NotFoundError: class extends Error {},
        ModalClient: class {
          readonly middleware: readonly GrpcMiddleware[];

          constructor(params?: { grpcMiddleware?: GrpcMiddleware[] }) {
            this.middleware = params?.grpcMiddleware ?? [];
          }

          /** One unary call through the client's middleware, innermost last, as nice-grpc runs it. */
          async call(rpc: (signal?: AbortSignal) => Promise<number | null>) {
            const base: GrpcMiddlewareCall<object, number | null> = {
              request: {},
              async *next(_request, options) {
                const response = await rpc(options.signal);
                // A unary call streams nothing and returns its response.
                yield* [];

                return response;
              },
            };

            const chain = this.middleware.reduceRight<GrpcMiddlewareCall<object, number | null>>(
              (inner, middleware) => ({
                request: {},
                next: (request, options) => middleware(inner, options),
              }),
              base,
            );

            const generator = chain.next({}, {});

            for (;;) {
              const step = await generator.next();

              if (step.done) return z.number().nullable().parse(step.value);
            }
          }

          readonly images = {
            fromId: async (imageId: string) => ({ imageId }),
            delete: async () => {},
          };

          readonly sandboxes = {
            fromId: async (sandboxId: string) => ({
              sandboxId,
              poll: () => this.call((signal) => poll(sandboxId, signal)),
              getTags: async () => ({}),
              terminate: async () => {},
            }),
            async *list() {},
          };

          readonly environments = { objects: { async *list() {} } };

          readonly cpClient = {
            async *workspaceBillingReport() {},
          };

          close() {
            closed.push("closed");
          }
        },
      },
    });

    return closed;
  }

  it("looks a sandbox up exactly with poll: running, finished, genuinely missing or unknown", async () => {
    vi.stubEnv("MODAL_TOKEN_SECRET", "secret-value");
    const provider = { ...memory(), name: "modal" };

    const closed = fakeModal(async (id) => {
      if (id === "sb-running") return null;

      if (id === "sb-done") return 137;

      if (id === "sb-gone") throw new ClientError(5, `NOT_FOUND: sandbox ${id} not found`);

      if (id === "sb-malformed")
        throw new ClientError(3, `INVALID_ARGUMENT: "${id}" is not a valid sandbox ID`);

      // An unmapped error that merely says "not found" is no proof of absence.
      throw new Error("sandbox not found (proxy)");
    });

    const result = async (id: string) => (await lookupSandbox(provider, id, 1000)).result;

    expect(await result("sb-running")).toBe("present");
    expect(await result("sb-done")).toBe("terminal");
    expect(await result("sb-gone")).toBe("not-found");
    expect(await result("sb-malformed")).toBe("unavailable");
    expect(await result("sb-flaky")).toBe("unavailable");
    // Every lookup closes its client.
    expect(closed).toHaveLength(5);

    vi.stubEnv("MODAL_TOKEN_SECRET", "");
    expect(await result("sb-running")).toBe("unavailable");
  });

  it("a stalled poll is cancelled at the deadline and its client closed", async () => {
    vi.stubEnv("MODAL_TOKEN_SECRET", "secret-value");
    const provider = { ...memory(), name: "modal" };
    const cancelled: string[] = [];

    // Modal never answers: the RPC settles only when its call is cancelled.
    const closed = fakeModal(
      (id, signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => {
            cancelled.push(id);
            reject(
              Object.assign(new Error("The operation has been aborted"), { name: "AbortError" }),
            );
          }),
        ),
    );

    const started = Date.now();
    expect(await lookupSandbox(provider, "sb-stalled", 100)).toMatchObject({
      result: "unavailable",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    // Cancelled and closed by the time the lookup answers, not whenever the RPC gives up.
    expect(cancelled).toEqual(["sb-stalled"]);
    expect(closed.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Modal billing collector", () => {
  const hour = 3_600_000;
  const stop = Date.parse("2026-11-09T13:20:00.000Z");

  const row = (
    id: string,
    app: OwnedSandbox["app"],
    confirmedStopAt: string | null = new Date(stop).toISOString(),
  ): OwnedSandbox => ({
    provider: "modal",
    id,
    scenarios: new Set(["sandbox-lifetime"]),
    startedAt: "2026-11-09T13:10:00.000Z",
    finishedAt: new Date(stop).toISOString(),
    confirmedStopAt,
    app,
  });

  const appA = { name: "sandbox-bench-r-i0", appId: "ap-a", sandboxes: ["sb-a"], ambiguous: 0 };

  const appB = {
    name: "sandbox-bench-r-i1",
    appId: "ap-b",
    sandboxes: ["sb-b", "sb-c"],
    ambiguous: 0,
  };

  const item = (
    objectId: string,
    interval: string,
    resources: Record<string, string>,
    description = objectId,
  ) => ({
    objectId,
    description,
    interval: new Date(interval),
    // The report's total is the sum of its resources, as Modal returns it.
    cost: Object.values(resources)
      .reduce((total, value) => total + Number(value), 0)
      .toFixed(8),
    costByResource: resources,
  });

  const report: ModalReport = async function* ({ start }) {
    expect(start.toISOString()).toBe("2026-11-09T13:00:00.000Z");
    yield item("ap-a", "2026-11-09T12:00:00Z", { CPU: "9" });
    yield item("ap-a", "2026-11-09T13:00:00Z", {
      CPU: "0.00100000",
      Memory: "0.00020000",
      "Network Egress": "0.50000000",
    });
    yield item("ap-b", "2026-11-09T13:00:00Z", { CPU: "0.4", Memory: "0.1" });
    yield item("ap-other", "2026-11-09T13:00:00Z", { CPU: "7" });
  };

  const rows = [row("sb-a", appA), row("sb-b", appB), row("sb-c", appB), row("sb-d", null)];

  const cost = (charges: Awaited<ReturnType<typeof collectModal>>, id: string) =>
    charges.sandboxes.find((s) => s.id === id)?.cost;

  it("prices a sandbox alone in its App from the report's compute, provisional until the hour has closed plus a buffer", async () => {
    expect(new Date(modalSettledAt(stop)).toISOString()).toBe("2026-11-09T14:30:00.000Z");

    const early = await collectModal(rows, { report, now: stop + 10 * 60_000 });

    expect(cost(early, "sb-a")).toMatchObject({
      kind: "billed",
      scope: "sandbox-lifetime",
      complete: false,
      confidence: "low",
    });
    // CPU and memory only: egress is not compute. The 12:00 row is before the window.
    expect(cost(early, "sb-a")).toMatchObject({ usd: expect.closeTo(0.0012, 9) });
    expect(cost(early, "sb-b")).toMatchObject({
      kind: "unavailable",
      note: expect.stringMatching(/2 sandboxes/),
    });
    expect(cost(early, "sb-c")).toMatchObject({ kind: "unavailable" });
    expect(cost(early, "sb-d")).toMatchObject({
      kind: "unavailable",
      note: expect.stringMatching(/--app-per-attempt/),
    });
    expect(early.account?.apps.find((a) => a.appId === "ap-b")).toMatchObject({
      computeUSD: 0.5,
      totalUSD: 0.5,
      settled: false,
    });

    const late = await collectModal(rows, { report, now: stop + 2 * hour });
    expect(cost(late, "sb-a")).toMatchObject({ complete: true, confidence: "medium" });

    // A failed report is unavailable, never zero, and leaks nothing of the error text.
    const failing: ModalReport = () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw Object.assign(new Error("token secret-value rejected"), { code: 16 });
        },
      }),
    });

    const failed = await collectModal(rows, { report: failing, now: stop + 2 * hour });
    expect(failed.sandboxes.every((s) => s.cost.kind === "unavailable")).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("secret-value");
    expect(JSON.stringify(failed)).toContain("gRPC 16");
  });

  it("publishes compute only and keeps the App total and egress beside it", async () => {
    const charges = await collectModal([row("sb-a", appA)], { report, now: stop + 2 * hour });
    expect(cost(charges, "sb-a")).toMatchObject({ usd: expect.closeTo(0.0012, 9) });
    expect(charges.account?.apps).toEqual([
      expect.objectContaining({
        appId: "ap-a",
        computeUSD: expect.closeTo(0.0012, 9),
        egressUSD: expect.closeTo(0.5, 9),
        totalUSD: expect.closeTo(0.5012, 9),
      }),
    ]);

    // Without a breakdown, or with a resource it does not know, compute cannot be told apart.
    const unsplit: ModalReport = async function* () {
      yield { ...item("ap-a", "2026-11-09T13:00:00Z", {}), cost: "0.5012" };
    };

    const unknown: ModalReport = async function* () {
      yield item("ap-a", "2026-11-09T13:00:00Z", { CPU: "0.001", Volume: "0.3" });
    };

    for (const source of [unsplit, unknown])
      expect(
        cost(
          await collectModal([row("sb-a", appA)], { report: source, now: stop + 2 * hour }),
          "sb-a",
        ),
      ).toMatchObject({ kind: "unavailable" });
  });

  it("stays provisional without a confirmed stop, or while an hour it ran in has no row", async () => {
    // The latest sample's end is no stop: a cold sample or a failed destroy can end last.
    const unconfirmed = await collectModal([row("sb-a", appA, null)], {
      report,
      now: stop + 6 * hour,
    });

    expect(cost(unconfirmed, "sb-a")).toMatchObject({
      kind: "billed",
      complete: false,
      note: expect.stringMatching(/no confirmed stop/),
    });

    // Ran 13:10 to 14:20; the 14:00 row never arrived. Long after the buffer it is still provisional.
    const longer: OwnedSandbox = {
      ...row("sb-a", appA),
      confirmedStopAt: "2026-11-09T14:20:00.000Z",
    };

    const missing = await collectModal([longer], { report, now: stop + 6 * hour });
    expect(cost(missing, "sb-a")).toMatchObject({
      complete: false,
      note: expect.stringMatching(/no row yet for 2026-11-09T14:00:00.000Z/),
    });
    expect(missing.account?.apps[0]?.missingIntervals).toEqual(["2026-11-09T14:00:00.000Z"]);
  });

  it("a short sandbox crossing an hour boundary needs both hours' rows", async () => {
    // Ran 13:59:30 to 14:00:30; only the 13:00 row exists. The 14:00 charge must not be dropped.
    const straddling: OwnedSandbox = {
      ...row("sb-a", appA),
      startedAt: "2026-11-09T13:59:30.000Z",
      finishedAt: "2026-11-09T14:00:30.000Z",
      confirmedStopAt: "2026-11-09T14:00:30.000Z",
    };

    const charges = await collectModal([straddling], { report, now: stop + 6 * hour });
    expect(cost(charges, "sb-a")).toMatchObject({ complete: false });
    expect(charges.account?.apps[0]?.missingIntervals).toEqual(["2026-11-09T14:00:00.000Z"]);
  });

  it("never attributes an App's charge to one sandbox while a create in it is unresolved", async () => {
    const ambiguous = { ...appA, ambiguous: 1 };
    const charges = await collectModal([row("sb-a", ambiguous)], { report, now: stop + 2 * hour });

    expect(cost(charges, "sb-a")).toMatchObject({
      kind: "unavailable",
      note: expect.stringMatching(/result is unknown/),
    });
    expect(charges.account?.apps[0]).toMatchObject({
      ambiguous: 1,
      computeUSD: expect.any(Number),
    });
  });

  it("collects billing.json for a run from its samples, confirmed stops and journaled Apps", async () => {
    const out = await directory();
    await mkdir(out, { recursive: true });

    const sample = (
      id: string,
      scenario: string,
      startedAt: string,
      finishedAt: string,
      phases: Record<string, number> = {},
    ) =>
      JSON.stringify({ provider: "modal", scenario, sandboxId: id, startedAt, finishedAt, phases });

    const samples = (destroyPhases: Record<string, number>) =>
      [
        sample("sb-a", "cold", "2026-11-09T13:10:00.000Z", "2026-11-09T13:10:01.000Z"),
        sample(
          "sb-a",
          "destroy",
          "2026-11-09T13:19:57.000Z",
          "2026-11-09T13:20:00.000Z",
          destroyPhases,
        ),
        sample("sb-a", "sandbox-lifetime", "2026-11-09T13:10:00.000Z", "2026-11-09T13:20:00.000Z"),
      ].join("\n") + "\n";

    const journal = (allocations: object[]) =>
      JSON.stringify({
        runId: "r",
        resources: [],
        apps: [{ provider: "modal", ...appA, allocations }],
      });

    const collect = () =>
      collectBilling({
        report: out,
        env: { MODAL_TOKEN_SECRET: "x" },
        modalReport: report,
        now: stop + 2 * hour,
      });

    const modalCost = async () =>
      (await collect()).providers.find((p) => p.provider === "modal")?.sandboxes[0]?.cost;

    await writeFile(
      join(out, "samples.ndjson"),
      samples({ terminateRequestMs: 200, confirmedStopMs: 2800 }),
    );
    await writeFile(
      join(out, "ownership.json"),
      journal([{ id: "a1", state: "allocated", sandboxId: "sb-a" }]),
    );

    const billing = await collect();
    const modal = billing.providers.find((p) => p.provider === "modal");
    expect(modal?.sandboxes).toEqual([
      expect.objectContaining({
        id: "sb-a",
        cost: expect.objectContaining({ kind: "billed", complete: true }),
      }),
    ]);
    expect(modal?.scenarios.find((s) => s.scenario === "sandbox-lifetime")).toMatchObject({
      billedCostPerTaskUSD: expect.closeTo(0.0012, 9),
    });

    // A destroy row without Modal's confirmed stop (it timed out) leaves the charge provisional.
    await writeFile(join(out, "samples.ndjson"), samples({ terminateRequestMs: 200 }));
    expect(await modalCost()).toMatchObject({ kind: "billed", complete: false });

    // A second create in the App whose response was lost: no per-sandbox charge at all.
    await writeFile(join(out, "samples.ndjson"), samples({ confirmedStopMs: 2800 }));
    await writeFile(
      join(out, "ownership.json"),
      journal([
        { id: "a1", state: "allocated", sandboxId: "sb-a" },
        { id: "a2", state: "submitted" },
      ]),
    );
    expect(await modalCost()).toMatchObject({ kind: "unavailable" });

    const missing = await collectBilling({ report: out, env: {}, modalReport: report });
    expect(missing.providers[0]?.sandboxes[0]?.cost).toMatchObject({
      kind: "unavailable",
      note: "Missing MODAL_TOKEN_SECRET; no billing call made",
    });
  });
});

describe("lost creates and pending restores", () => {
  const configFor = (run: string, out: string, extra: string[] = []) =>
    parseV2([
      "--providers",
      "modal",
      "--runs",
      "1",
      "--scenarios",
      "command",
      "--bursts",
      "",
      "--timeout-ms",
      "1500",
      "--ownership-visibility-ms",
      "500",
      "--app-per-attempt",
      "modal",
      "--run",
      run,
      "--out",
      out,
      ...extra,
    ]);

  const journalApps = async (out: string) =>
    journalAppSchema
      .array()
      .parse(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")).apps);

  /** Everything the run wrote to stdout while `work` ran. */
  async function stdout(work: () => Promise<void>) {
    const lines: string[] = [];

    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));

      return true;
    });

    try {
      await work();
    } finally {
      spy.mockRestore();
    }

    return lines.join("");
  }

  it("journals each create in its App before submitting it, and settles it when the response returns", async () => {
    const out = await directory();
    const run = "modal-alloc";
    const cloud = modalCloud();
    const seen: { journaled: boolean }[] = [];

    const provider = cloud.process({
      create: async (input, allocate) => {
        // What the journal says at submission time, before Modal allocates anything.
        const apps = await journalApps(out);
        const id = input.labels?.[allocationLabel];

        seen.push({
          journaled: apps.some((app) =>
            app.allocations.some((entry) => entry.id === id && entry.state === "submitted"),
          ),
        });

        return allocate(input);
      },
    });

    await runV2(
      [{ kind: "ready", name: "modal", cloud: false, region: null, provider }],
      configFor(run, out),
      async () => {},
    );

    expect(seen).toEqual([{ journaled: true }]);
    const [app] = await journalApps(out);
    expect(app?.sandboxes).toHaveLength(1);
    expect(app?.allocations).toEqual([
      { id: expect.any(String), state: "allocated", sandboxId: app?.sandboxes[0] },
    ]);
  });

  it("a create whose response is lost stays journaled until a listing ties its sandbox to it", async () => {
    const out = await directory();
    const run = "modal-lost";
    const cloud = modalCloud();
    let leaked = "";

    // Modal allocates, then the response is lost in transport.
    const provider = cloud.process({
      create: async (input, allocate) => {
        leaked = (await allocate(input)).id;
        throw new SandboxError("Modal request failed: unavailable", {
          code: "unavailable",
          provider: "modal",
          retryable: true,
        });
      },
    });

    await runV2(
      [{ kind: "ready", name: "modal", cloud: false, region: null, provider }],
      configFor(run, out),
      async () => {},
    );

    // The runner's own cleanup listing found it, deleted it and tied it to its create.
    expect(leaked).not.toBe("");
    expect(await cloud.backing.list({ "sandbox-bench-run": run })).toEqual([]);
    const [app] = await journalApps(out);
    expect(app?.sandboxes).toEqual([leaked]);
    expect(app?.allocations).toEqual([
      { id: expect.any(String), state: "allocated", sandboxId: leaked },
    ]);

    // Even a refusal can follow an allocation Modal's client does not name (it allocates, then
    // waits for scheduling), so the create stays submitted and the App ambiguous.
    const refusedOut = await directory();

    const refusing = modalCloud().process({
      create: async () => {
        throw new SandboxError("Modal request failed: invalid argument", {
          code: "invalid_argument",
          provider: "modal",
        });
      },
    });

    await runV2(
      [{ kind: "ready", name: "modal", cloud: false, region: null, provider: refusing }],
      configFor("modal-refused", refusedOut),
      async () => {},
    );
    expect((await journalApps(refusedOut))[0]?.allocations).toEqual([
      { id: expect.any(String), state: "submitted" },
    ]);
  });

  it("reap finds a restore left tagged pending, journals and deletes it, and ties it to its create", async () => {
    const out = await directory();
    const run = "modal-pending";
    const app = attemptApp(run, 0);
    const cloud = modalCloud();
    const owner = cloud.process();
    await owner.prepareApp(app);

    // A creator that crashed after Modal allocated its restore, before the marker was cleared.
    const pending = await owner.create({
      labels: {
        "sandbox-bench-run": run,
        "sandbox-sdk": "pending",
        [appLabel]: app,
        [allocationLabel]: "r1",
      },
    });

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        resources: [],
        apps: [
          {
            provider: "modal",
            name: app,
            appId: `ap-${app}`,
            sandboxes: [],
            allocations: [{ id: "r1", state: "submitted" }],
          },
        ],
      }),
    );

    const config = configFor(run, out);
    const fresh = cloud.process();
    let failed = true;

    const printed = await stdout(async () => {
      failed = await reapRun(
        [{ kind: "ready", name: "modal", cloud: false, region: null, provider: fresh }],
        config,
        (s) => s,
      );
    });

    expect(failed).toBe(false);
    expect(printed).toContain("modal: 0 leftovers");
    expect(await cloud.backing.list({ "sandbox-bench-run": run })).toEqual([]);
    const [entry] = await journalApps(out);
    expect(entry?.sandboxes).toEqual([pending.id]);
    expect(entry?.allocations).toEqual([{ id: "r1", state: "allocated", sandboxId: pending.id }]);

    // One it cannot delete is a leftover, never "0 leftovers".
    const stuckOut = await directory();
    const stuckRun = "modal-pending-stuck";
    const stuckApp = attemptApp(stuckRun, 0);
    await owner.prepareApp(stuckApp);
    await owner.create({
      labels: { "sandbox-bench-run": stuckRun, "sandbox-sdk": "pending", [appLabel]: stuckApp },
    });
    await writeFile(
      join(stuckOut, "ownership.json"),
      JSON.stringify({
        runId: stuckRun,
        resources: [],
        apps: [{ provider: "modal", name: stuckApp, appId: `ap-${stuckApp}`, sandboxes: [] }],
      }),
    );

    const stuck = cloud.process({
      destroy: async () => {
        throw new Error("terminate unavailable");
      },
    });

    const stuckPrinted = await stdout(async () => {
      failed = await reapRun(
        [{ kind: "ready", name: "modal", cloud: false, region: null, provider: stuck }],
        configFor(stuckRun, stuckOut),
        (s) => s,
      );
    });

    expect(failed).toBe(true);
    expect(stuckPrinted).toContain("modal: 1 leftovers");
  });

  it("reports a create still unresolved after every listing, and keeps it journaled", async () => {
    const out = await directory();
    const run = "modal-unresolved";
    const app = attemptApp(run, 0);
    const cloud = modalCloud();
    await cloud.process().prepareApp(app);

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        resources: [],
        apps: [
          {
            provider: "modal",
            name: app,
            appId: `ap-${app}`,
            sandboxes: [],
            allocations: [{ id: "x1", state: "submitted" }],
          },
        ],
      }),
    );

    const printed = await stdout(async () => {
      await reapRun(
        [{ kind: "ready", name: "modal", cloud: false, region: null, provider: cloud.process() }],
        configFor(run, out),
        (s) => s,
      );
    });

    expect(printed).toContain(
      `unresolvedAllocation: {"provider":"modal","app":"${app}","creates":1}`,
    );
    expect((await journalApps(out))[0]?.allocations).toEqual([{ id: "x1", state: "submitted" }]);
  });
});

it("a create that fails after Modal allocated its sandbox is journaled as allocated, not rejected", () => {
  const app = journalApp("modal", "sandbox-bench-r-i0");
  const started = beginAllocation(app);
  // A restore whose setup was refused (PERMISSION_DENIED) after allocation, then cleaned up.
  failedAllocation(
    app,
    started.id,
    "modal",
    new SandboxError("tags refused", { code: "auth", provider: "modal", sandboxId: "sb-restored" }),
  );

  expect(app.allocations).toEqual([
    { id: started.id, state: "allocated", sandboxId: "sb-restored" },
  ]);
  expect(app.sandboxes).toContain("sb-restored");

  // A refusal naming no sandbox proves nothing: scheduling can refuse after allocation.
  const refused = beginAllocation(app);
  failedAllocation(
    app,
    refused.id,
    "modal",
    new SandboxError("quota", { code: "quota", provider: "modal" }),
  );
  expect(app.allocations.at(-1)).toEqual({ id: refused.id, state: "submitted" });
  expect(ambiguousAllocations(app)).toBe(1);
});
