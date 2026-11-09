import { describe, expect, it } from "vitest";
import type { ModalNativeSandbox, NativeModules } from "../src/existence.js";
import { sweepClean, sweepModal } from "../src/modal-sweep.js";

type Client = InstanceType<NativeModules["modal"]["ModalClient"]>;

interface FakeSandbox {
  id: string;
  appId: string;
  tags: Record<string, string> | "unreadable";
  /** Whether terminate takes effect. */
  stops: boolean;
  exit: number | null;
  terminated: number;
}

/** A workspace with Apps and running sandboxes, read through Modal's public client surface. */
function workspace(boxes: FakeSandbox[], apps: { appId: string; name?: string }[]): Client {
  const handle = (box: FakeSandbox): ModalNativeSandbox => ({
    sandboxId: box.id,
    poll: async () => box.exit,
    getTags: async () => {
      if (box.tags === "unreadable") throw Object.assign(new Error("UNAVAILABLE"), { code: 14 });

      return { ...box.tags };
    },
    terminate: async () => {
      box.terminated++;

      if (box.stops) box.exit = 137;
    },
  });

  return {
    images: { fromId: async (imageId) => ({ imageId }), delete: async () => {} },
    sandboxes: {
      fromId: async (id) => {
        const box = boxes.find((entry) => entry.id === id);

        if (!box) throw Object.assign(new Error("NOT_FOUND"), { code: 5 });

        return handle(box);
      },
      async *list(params = {}) {
        for (const box of boxes)
          if (box.exit === null && (params.appId === undefined || params.appId === box.appId))
            yield { sandboxId: box.id };
      },
    },
    environments: {
      objects: {
        async *list() {
          yield {
            name: "main",
            apps: {
              async *list() {
                yield* apps;
              },
            },
          };
        },
      },
    },
    cpClient: { async *workspaceBillingReport() {} },
    close() {},
  };
}

const box = (id: string, appId: string, tags: FakeSandbox["tags"], stops = true): FakeSandbox => ({
  id,
  appId,
  tags,
  stops,
  exit: null,
  terminated: 0,
});

describe("modal-sweep", () => {
  const apps = [
    { appId: "ap-bench", name: "sandbox-bench-run-i0" },
    { appId: "ap-other", name: "someone-elses-app" },
    { appId: "ap-anon" },
  ];

  const fleet = () => [
    // In a bench App, no tags: owned by its App.
    box("sb-1", "ap-bench", {}),
    // In a foreign App with the SDK's tags: owned by its tags.
    box("sb-2", "ap-other", { "sandbox-sdk": "1", "sandbox-bench-run": "r", app: "x" }),
    // Neither: left alone, counted only.
    box("sb-3", "ap-other", { team: "data" }),
    // Tags unreadable, foreign App: reported, never stopped.
    box("sb-4", "ap-anon", "unreadable"),
    // A pending restore the journal missed.
    box("sb-5", "ap-anon", { "sandbox-sdk": "pending" }),
  ];

  it("reports every running bench or SDK sandbox in the workspace without touching it", async () => {
    const boxes = fleet();
    const report = await sweepModal({ client: workspace(boxes, apps) });

    expect(report).toMatchObject({ environments: ["main"], running: 5, others: 1 });
    expect(report.owned.map((entry) => [entry.id, entry.reason, entry.app])).toEqual([
      ["sb-1", "app", "sandbox-bench-run-i0"],
      ["sb-2", "tags", null],
      ["sb-4", "tags-unreadable", null],
      ["sb-5", "tags", null],
    ]);
    // Only ownership tags are reported.
    expect(report.owned[1]?.tags).toEqual({ "sandbox-sdk": "1", "sandbox-bench-run": "r" });
    expect(boxes.every((entry) => entry.terminated === 0)).toBe(true);
    expect(sweepClean(report, false)).toBe(false);
  });

  it("with --terminate stops what it owns, confirms each stop, and leaves everything else", async () => {
    const boxes = fleet();
    const report = await sweepModal({ client: workspace(boxes, apps), terminate: true });

    expect(Object.fromEntries(report.owned.map((entry) => [entry.id, entry.outcome]))).toEqual({
      "sb-1": "stopped",
      "sb-2": "stopped",
      "sb-4": null,
      "sb-5": "stopped",
    });
    expect(boxes.map((entry) => entry.terminated)).toEqual([1, 1, 0, 0, 1]);
    // An owner it could not prove keeps the sweep failing.
    expect(sweepClean(report, true)).toBe(false);

    // A stop Modal never confirms is reported unconfirmed.
    const stuck = [box("sb-9", "ap-bench", {}, false)];

    const unconfirmed = await sweepModal({
      client: workspace(stuck, apps),
      terminate: true,
      stopWaitMs: 50,
    });

    expect(unconfirmed.owned).toMatchObject([{ id: "sb-9", outcome: "unconfirmed" }]);
    expect(sweepClean(unconfirmed, true)).toBe(false);

    const clean = await sweepModal({
      client: workspace([box("sb-8", "ap-bench", {})], apps),
      terminate: true,
    });

    expect(sweepClean(clean, true)).toBe(true);
    expect(sweepClean(await sweepModal({ client: workspace([], apps) }), false)).toBe(true);
  });
});
