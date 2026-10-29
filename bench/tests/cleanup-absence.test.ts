import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import * as existence from "../src/existence.js";
import { runV2 } from "../src/v2-runner.js";
import { parseV2 } from "../src/v2-config.js";
import { writeV2 } from "../src/v2-report.js";
import { reapRun } from "../src/recovery.js";
import { DeletionWork, deadline } from "../src/timing.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function config() {
  const out = await mkdtemp(join(tmpdir(), "bench-absence-"));
  dirs.push(out);

  return parseV2([
    "--providers",
    "memory",
    "--run",
    "absence-run",
    "--runs",
    "1",
    "--scenarios",
    "command",
    "--bursts",
    "",
    "--ownership-visibility-ms",
    "300",
    "--out",
    out,
  ]);
}

it.each(["terminal", "not-found", "unavailable"] as const)(
  "resolves an admitted create error only for definitive native %s evidence",
  async (result) => {
    const cfg = await config();
    const backing = memory();
    const destroy = vi.fn(backing.destroy);

    const provider = {
      ...backing,
      destroy,
      create: async () => {
        throw new SandboxError("Terminated before readiness", {
          provider: "memory",
          code: "not_found",
          sandboxId: "target",
          cause: { admittedByThisCall: true, operation: "create", nativeState: "TERMINATED" },
        });
      },
    };

    const lookup = vi.spyOn(existence, "lookupSandbox").mockResolvedValue({
      result,
      checkedAt: "2026-10-22T05:45:00Z",
      method: "native-exact-get",
      ...(result === "terminal"
        ? { nativeState: "TERMINATED" }
        : { httpStatus: result === "not-found" ? 404 : 503 }),
    });

    const report = await runV2(
      [{ kind: "ready", name: "memory", cloud: false, region: null, provider }],
      cfg,
      (r) => writeV2(r, cfg.out),
    );

    expect(destroy).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalled();
    expect(report.cleanupReview).toHaveLength(result === "unavailable" ? 1 : 0);
    expect(report.cleanupResolved?.length).toBe(result === "unavailable" ? 0 : 1);

    if (result !== "unavailable") {
      expect(report.samples.find((s) => s.scenario === "cold")?.outcome).toMatchObject({
        kind: "failure",
        cleanupResolved: "absent",
      });
      expect(report.cleanupResolved?.[0]).toMatchObject({
        id: "target",
        resolution: "absent",
        evidence: { result, method: "native-exact-get" },
      });
      expect(JSON.parse(await readFile(join(cfg.out, "ownership.json"), "utf8")).resources).toEqual(
        [],
      );
      expect(await readFile(join(cfg.out, "results.md"), "utf8")).toContain("cleanupResolved: ");
    }
  },
);

it.each(["not-found", "unavailable"] as const)(
  "reap rechecks quarantined journal IDs using exact native %s evidence",
  async (result) => {
    const cfg = await config();
    const backing = memory();
    const destroy = vi.fn(backing.destroy);
    const provider = { ...backing, destroy };
    await writeFile(
      join(cfg.out, "ownership.json"),
      JSON.stringify({
        runId: cfg.run,
        resources: [{ provider: "memory", id: "target", kind: "sandbox", parent: null }],
      }),
    );
    await writeFile(
      join(cfg.out, "results.json"),
      JSON.stringify({
        cleanupReview: [
          { provider: "memory", id: "target", kind: "sandbox", reason: "Labels missing" },
        ],
      }),
    );
    vi.spyOn(existence, "lookupSandbox").mockResolvedValue({
      result,
      checkedAt: new Date().toISOString(),
      method: "native-exact-get",
      httpStatus: result === "not-found" ? 404 : 500,
    });
    expect(
      await reapRun(
        [{ kind: "ready", name: "memory", cloud: false, region: null, provider }],
        cfg,
        (s) => s,
      ),
    ).toBe(result === "unavailable");
    expect(destroy).not.toHaveBeenCalled();
    const report = JSON.parse(await readFile(join(cfg.out, "results.json"), "utf8"));
    expect(report.cleanupReview).toHaveLength(result === "unavailable" ? 1 : 0);
    expect(report.cleanupResolved).toHaveLength(result === "unavailable" ? 0 : 1);
    expect(
      JSON.parse(await readFile(join(cfg.out, "ownership.json"), "utf8")).resources,
    ).toHaveLength(result === "unavailable" ? 1 : 0);
  },
);

it("retains a native deletion across the deadline without submitting a second deletion", async () => {
  const work = new DeletionWork();
  let complete = () => {};

  const operation = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );

  const native = work.start("memory", "target", operation);
  await expect(deadline(10, () => native)).rejects.toThrow("timed out");
  expect(work.start("memory", "target", operation)).toBe(native);
  complete();
  await work.wait("memory", "target", 100);
  expect(operation).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "resolves a delete that completes after its deadline (reap=%s)",
  async (reap) => {
    const cfg = { ...(await config()), "timeout-ms": 1000 };
    const backing = memory();

    const destroy = vi.fn(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1250));
      await backing.destroy(id);
    });

    const provider = { ...backing, destroy };

    const loaded = [
      { kind: "ready", name: "memory", cloud: false, region: null, provider },
    ] satisfies Parameters<typeof reapRun>[0];

    if (reap) {
      const own = await backing.create({
        labels: { "sandbox-bench-run": cfg.run, "sandbox-sdk": "1" },
      });

      await writeFile(
        join(cfg.out, "ownership.json"),
        JSON.stringify({
          runId: cfg.run,
          resources: [{ provider: "memory", id: own.id, kind: "sandbox", parent: null }],
        }),
      );
      expect(await reapRun(loaded, cfg, (s) => s)).toBe(false);
    } else {
      const report = await runV2(loaded, cfg, (r) => writeV2(r, cfg.out));
      expect(report.samples.find((s) => s.scenario === "destroy")?.outcome).toMatchObject({
        kind: "failure",
        cleanupResolved: "absent",
      });
      expect(report.cleanupReview).toEqual([]);
      expect(report.cleanup.every((p) => !p.error && !p.remaining.length)).toBe(true);
    }

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(await backing.list({})).toEqual([]);
    const report = JSON.parse(await readFile(join(cfg.out, "results.json"), "utf8"));
    expect(report.cleanupResolved).toContainEqual(
      expect.objectContaining({
        resolution: "absent",
        evidence: expect.objectContaining({ result: "not-found" }),
      }),
    );
    expect(JSON.parse(await readFile(join(cfg.out, "ownership.json"), "utf8")).resources).toEqual(
      [],
    );
  },
);

it("resolves an absent resource even when its native delete promise never settles", async () => {
  const cfg = { ...(await config()), "timeout-ms": 1000 };
  const backing = memory();

  const destroy = vi.fn(async (id: string) => {
    await backing.destroy(id);
    await new Promise<void>(() => {});
  });

  const provider = { ...backing, destroy };

  const report = await runV2(
    [{ kind: "ready", name: "memory", cloud: false, region: null, provider }],
    cfg,
    (r) => writeV2(r, cfg.out),
  );

  expect(destroy).toHaveBeenCalledTimes(1);
  expect(report.cleanupResolved).toContainEqual(expect.objectContaining({ resolution: "absent" }));
  expect(report.cleanupReview).toEqual([]);
  expect(report.cleanup.every((p) => !p.error && !p.remaining.length)).toBe(true);
  expect(report.admissionStopped).toEqual([]);
  expect(await backing.list({})).toEqual([]);
});

it("does not publish lookup latency as destroy latency when no delete request was needed", async () => {
  const cfg = await config();
  const backing = memory();
  let lists = 0;
  const destroy = vi.fn(backing.destroy);

  const provider = {
    ...backing,
    destroy,
    list: async (labels: Parameters<typeof backing.list>[0]) => {
      const rows = await backing.list(labels);

      if (++lists > 1) {
        for (const row of rows) await backing.destroy(row.id);

        return [];
      }

      return rows;
    },
  };

  const report = await runV2(
    [{ kind: "ready", name: "memory", cloud: false, region: null, provider }],
    cfg,
    (r) => writeV2(r, cfg.out),
  );

  expect(destroy).not.toHaveBeenCalled();
  expect(report.samples.find((s) => s.scenario === "destroy")?.outcome.kind).toBe("skipped");
  expect(report.cleanupResolved).toContainEqual(expect.objectContaining({ resolution: "absent" }));
  expect(report.cleanupReview).toEqual([]);
});
