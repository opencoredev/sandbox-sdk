import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import { collectBilling } from "../src/billing.js";
import { collectModal, modalSettledAt, type ModalReport } from "../src/billing/modal.js";
import type { OwnedSandbox } from "../src/billing/input.js";
import { lookupSandbox } from "../src/existence.js";
import { appLabel, attemptApp, journalAppSchema } from "../src/modal-apps.js";
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

  function process(options: { destroy?: Provider["destroy"]; journal?: string } = {}) {
    const known = new Set(["sandbox-sdk"]);
    const visible = (info: SandboxInfo) => known.has(appOf.get(info.id) ?? "sandbox-sdk");

    const adapter: Provider & {
      prepareApp(
        name: string,
        settings?: { createIfMissing?: boolean },
      ): Promise<{ name: string; appId: string } | null>;
    } = {
      ...backing,
      name: "modal",
      create: async (input) => {
        const app = input.labels?.[appLabel] ?? "sandbox-sdk";
        const info = await backing.create(input);
        appOf.set(info.id, app);
        existing.add(app);
        known.add(app);

        return info;
      },
      list: async (labels) => (await backing.list(labels)).filter(visible),
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

    const fresh = cloud.process();

    expect(
      await reapRun(
        [{ kind: "ready", name: "modal", cloud: false, region: null, provider: fresh }],
        config,
        (s) => s,
      ),
    ).toBe(false);
    expect(await cloud.backing.list({ "sandbox-bench-run": run })).toEqual([]);
    expect(cloud.existing.has("sandbox-bench-never")).toBe(false);
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

  function fakeModal(poll: (id: string) => Promise<number | null>) {
    const closed: string[] = [];

    fakeNativeModules({
      "nice-grpc": { ClientError, Status: { NOT_FOUND: 5 } },
      modal: {
        NotFoundError: class extends Error {},
        ModalClient: class {
          readonly images = {
            fromId: async (imageId: string) => ({ imageId }),
            delete: async () => {},
          };

          readonly sandboxes = {
            fromId: async (sandboxId: string) => ({ sandboxId, poll: () => poll(sandboxId) }),
          };

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
});

describe("Modal billing collector", () => {
  const hour = 3_600_000;
  const stop = Date.parse("2026-11-09T13:20:00.000Z");

  const row = (id: string, app: OwnedSandbox["app"]): OwnedSandbox => ({
    provider: "modal",
    id,
    scenarios: new Set(["sandbox-lifetime"]),
    startedAt: "2026-11-09T13:10:00.000Z",
    finishedAt: new Date(stop).toISOString(),
    app,
  });

  const appA = { name: "sandbox-bench-r-i0", appId: "ap-a", sandboxes: ["sb-a"] };
  const appB = { name: "sandbox-bench-r-i1", appId: "ap-b", sandboxes: ["sb-b", "sb-c"] };

  const report: ModalReport = async function* ({ start }) {
    expect(start.toISOString()).toBe("2026-11-09T13:00:00.000Z");
    yield {
      objectId: "ap-a",
      description: appA.name,
      interval: new Date("2026-11-09T12:00:00Z"),
      cost: "9",
    };
    yield {
      objectId: "ap-a",
      description: appA.name,
      interval: new Date("2026-11-09T13:00:00Z"),
      cost: "0.00120000",
    };
    yield {
      objectId: "ap-a",
      description: appA.name,
      interval: new Date("2026-11-09T14:00:00Z"),
      cost: "0.00003000",
    };
    yield {
      objectId: "ap-b",
      description: appB.name,
      interval: new Date("2026-11-09T13:00:00Z"),
      cost: "0.5",
    };
    yield {
      objectId: "ap-other",
      description: "someone-else",
      interval: new Date("2026-11-09T13:00:00Z"),
      cost: "7",
    };
  };

  const rows = [row("sb-a", appA), row("sb-b", appB), row("sb-c", appB), row("sb-d", null)];

  it("prices a sandbox alone in its App from the report, provisional until the hour has closed plus a buffer", async () => {
    expect(new Date(modalSettledAt(stop)).toISOString()).toBe("2026-11-09T14:30:00.000Z");

    const early = await collectModal(rows, { report, now: stop + 10 * 60_000 });

    const cost = (charges: typeof early, id: string) =>
      charges.sandboxes.find((s) => s.id === id)?.cost;

    expect(cost(early, "sb-a")).toMatchObject({
      kind: "billed",
      scope: "sandbox-lifetime",
      complete: false,
      confidence: "low",
    });
    // The 12:00 row is before the window; only this App's rows count.
    expect(cost(early, "sb-a")).toMatchObject({ usd: expect.closeTo(0.00123, 9) });
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
      usd: 0.5,
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

  it("collects billing.json for a run from its samples and journaled Apps", async () => {
    const out = await directory();
    await mkdir(out, { recursive: true });

    const sample = (id: string, scenario: string, startedAt: string, finishedAt: string) =>
      JSON.stringify({ provider: "modal", scenario, sandboxId: id, startedAt, finishedAt });

    await writeFile(
      join(out, "samples.ndjson"),
      [
        sample("sb-a", "cold", "2026-11-09T13:10:00.000Z", "2026-11-09T13:10:01.000Z"),
        sample("sb-a", "sandbox-lifetime", "2026-11-09T13:10:00.000Z", "2026-11-09T13:20:00.000Z"),
      ].join("\n") + "\n",
    );
    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({ runId: "r", resources: [], apps: [{ provider: "modal", ...appA }] }),
    );

    const billing = await collectBilling({
      report: out,
      env: { MODAL_TOKEN_SECRET: "x" },
      modalReport: report,
      now: stop + 2 * hour,
    });

    const modal = billing.providers.find((p) => p.provider === "modal");
    expect(modal?.sandboxes).toEqual([
      expect.objectContaining({
        id: "sb-a",
        cost: expect.objectContaining({ kind: "billed", complete: true }),
      }),
    ]);
    expect(modal?.scenarios.find((s) => s.scenario === "sandbox-lifetime")).toMatchObject({
      billedCostPerTaskUSD: expect.closeTo(0.00123, 9),
    });

    const missing = await collectBilling({ report: out, env: {}, modalReport: report });
    expect(missing.providers[0]?.sandboxes[0]?.cost).toMatchObject({
      kind: "unavailable",
      note: "Missing MODAL_TOKEN_SECRET; no billing call made",
    });
  });
});
