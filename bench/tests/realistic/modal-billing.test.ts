import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { realisticAttemptApp, type JournalApp } from "../../src/modal-apps.js";
import { appJournalFile, stopJournalFile } from "../../src/realistic/apps.js";
import { billingRule } from "../../src/cost/billing-rules.js";
import { wholeMachineListPrice } from "../../src/cost/columns.js";
import { realisticCommand, regionsFile } from "../../src/realistic/cli.js";
import { attributionFor, emptyRecord } from "../../src/realistic/slots.js";
import { attemptRecordSchema } from "../../src/realistic/record.js";
import { attemptBillingSchema, costedAttempt } from "../../src/cost/attempt-input.js";
import { fakeNativeModules } from "../native-fakes.js";
import { buildFixture, type Fixture } from "./fixture.js";
import { z } from "zod";

/** The summary row fields these tests read. */
const summaryRow = z.object({
  wholeMachinePerCompletedUSD: z.number().nullable(),
  wholeMachineBound: z.enum(["exact", "lower"]),
  costPerCompletedUSD: z.number().nullable(),
});

let root: string;
let fixture: Fixture;
let restore: (() => void) | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rw-modal-billing-"));
  fixture = await buildFixture();
});

afterEach(() => {
  restore?.();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await fixture.cleanup();
  await rm(root, { recursive: true, force: true });
});

const startedAt = Date.parse("2026-11-01T10:05:00Z");
const endedAt = Date.parse("2026-11-01T10:08:00Z");

/** One finished Modal attempt with its journaled App, and a billing report for that App. */
async function attemptDir(
  name: string,
  options: {
    stopped: boolean;
    /** The record's sandbox IDs; empty when the create's response was lost. */
    recordSandboxes?: string[];
    /** The App journal's last snapshot, when it differs from one allocated sb-1. */
    journal?: Pick<JournalApp, "sandboxes" | "allocations">;
    completed?: boolean;
    track?: "same-machine" | "default";
  },
) {
  const out = join(root, name);
  const track = options.track ?? "same-machine";
  const slotId = track === "default" ? "fat-default" : "fat-same";
  const attemptId = `${name}-b0-s0-${slotId}-modal`;
  const app = realisticAttemptApp(attemptId);

  const record = emptyRecord(
    {
      runId: name,
      attemptId,
      provider: "modal",
      manifest: fixture.manifest,
      manifestSha256: null,
      profileName: "fix-and-test",
      track,
      variant: "headline",
      batch: 0,
      slot: { index: 0, id: slotId },
      seed: 20261105,
      slotStartedAt: startedAt,
    },
    "error",
    "",
    startedAt,
    attributionFor("modal").attribution,
  );

  if (options.completed ?? true) record.completion = { kind: "completed" };
  record.sandboxIds = options.recordSandboxes ?? ["sb-1"];
  record.startedAt = startedAt;
  record.endedAt = endedAt;
  record.deletionConfirmed = true;

  const journaled: JournalApp = {
    provider: "modal",
    name: app,
    appId: "ap-1",
    sandboxes: ["sb-1"],
    allocations: [{ id: "alloc-1", state: "allocated", sandboxId: "sb-1" }],
    ...options.journal,
  };

  await rm(out, { recursive: true, force: true });
  await import("node:fs/promises").then((fs) => fs.mkdir(out, { recursive: true }));
  await writeFile(join(out, "attempts.jsonl"), JSON.stringify(record) + "\n");
  await writeFile(join(out, appJournalFile), JSON.stringify(journaled) + "\n");

  if (options.stopped)
    await writeFile(
      join(out, stopJournalFile),
      JSON.stringify({
        provider: "modal",
        sandboxId: "sb-1",
        confirmedStopAt: new Date(endedAt).toISOString(),
        requestMs: 110,
        stoppedMs: 640,
      }) + "\n",
    );

  // The App's one hourly row: $0.012 of compute and $0.0005 of egress.
  const spy = fakeNativeModules({
    modal: {
      ModalClient: class {
        readonly images = {
          fromId: async (imageId: string) => ({ imageId }),
          delete: async () => {},
        };

        readonly sandboxes = {
          fromId: async () => {
            throw new Error("billing makes no sandbox reads");
          },
          async *list() {},
        };

        readonly environments = { objects: { async *list() {} } };

        readonly cpClient = {
          async *workspaceBillingReport() {
            yield {
              objectId: "ap-1",
              description: app,
              interval: new Date("2026-11-01T10:00:00Z"),
              cost: "0.0125",
              costByResource: { CPU: "0.01", Memory: "0.002", "Network Egress": "0.0005" },
            };
          },
        };

        close() {}
      },
      NotFoundError: class extends Error {},
    },
  });

  restore = () => spy.mockRestore();
  // The collector needs credentials present; the faked client never sends them.
  vi.stubEnv("MODAL_TOKEN_ID", "ak-test");
  vi.stubEnv("MODAL_TOKEN_SECRET", "as-test");

  return out;
}

async function entries(out: string) {
  await realisticCommand(["billing", "--out", out]);

  return readBilling(out);
}

async function readBilling(out: string) {
  return (await readFile(join(out, "billing.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line)
    .map((line) => attemptBillingSchema.parse(JSON.parse(line)));
}

async function record(out: string) {
  return attemptRecordSchema.parse(
    JSON.parse((await readFile(join(out, "attempts.jsonl"), "utf8")).trim()),
  );
}

async function charges(out: string) {
  await realisticCommand(["billing", "--out", out]);

  return (await readFile(join(out, "billing.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).charge);
}

describe("realistic billing for Modal", () => {
  it("prices the attempt at its App's compute charge, settled after the journaled confirmed stop", async () => {
    const out = await attemptDir("rw-billed", { stopped: true });

    expect(await charges(out)).toEqual([
      expect.objectContaining({ kind: "billed", usd: 0.012, settled: true }),
    ]);
  });

  it("keeps the charge provisional without a confirmed stop", async () => {
    const out = await attemptDir("rw-unstopped", { stopped: false });

    expect(await charges(out)).toEqual([
      expect.objectContaining({ kind: "billed", usd: 0.012, settled: false }),
    ]);
  });

  it("keeps a lost create's cost unavailable instead of reporting nothing created", async () => {
    const out = await attemptDir("rw-lost-create", {
      stopped: false,
      completed: false,
      recordSandboxes: [],
      journal: { sandboxes: [], allocations: [{ id: "alloc-1", state: "submitted" }] },
    });

    const [entry, ...rest] = await entries(out);

    expect(rest).toEqual([]);
    expect(entry?.charge).toEqual(
      expect.objectContaining({ kind: "unavailable", reason: expect.stringMatching(/unknown/) }),
    );

    // An explicit unavailable entry wins over "no-sandbox", which would report nothing-created, $0.
    expect(costedAttempt(await record(out), entry).charge.kind).toBe("unavailable");
  });

  it("bills a sandbox that reconciliation recovered for an attempt that lost its create response", async () => {
    const out = await attemptDir("rw-recovered", {
      stopped: true,
      completed: false,
      recordSandboxes: [],
    });

    const [entry] = await entries(out);

    expect(entry?.charge).toEqual(
      expect.objectContaining({ kind: "billed", usd: 0.012, settled: true }),
    );
    expect(costedAttempt(await record(out), entry).charge.kind).toBe("billed");
  });

  it("still writes no billing for an attempt whose App never received a create", async () => {
    const out = await attemptDir("rw-no-create", {
      stopped: false,
      completed: false,
      recordSandboxes: [],
      journal: { sandboxes: [], allocations: [] },
    });

    expect(await entries(out)).toEqual([]);
    expect(costedAttempt(await record(out)).charge.kind).toBe("no-sandbox");
  });

  it("prices the summary's whole machine at the run's recorded region, with its bound", async () => {
    const rows: z.infer<typeof summaryRow>[] = [];

    for (const track of ["same-machine", "default"] as const) {
      const out = await attemptDir(`rw-region-${track}`, { stopped: true, track });
      await realisticCommand(["billing", "--out", out]);
      await writeFile(join(out, regionsFile), JSON.stringify({ modal: "us-east" }) + "\n");
      const to = join(root, `rw-region-${track}-summary`);
      await mkdir(to, { recursive: true });
      await realisticCommand(["summary", "--out", out, "--to", to]);

      const [row] = z
        .object({ rows: z.array(summaryRow) })
        .parse(JSON.parse(await readFile(join(to, "summary.json"), "utf8"))).rows;

      const [entry] = await readBilling(out);
      const attempt = costedAttempt(await record(out), entry);
      const rule = billingRule("modal", null);

      if (!rule || !row) throw new Error("No Modal rule or summary row");

      const at = (region: string | null) => {
        const whole = wholeMachineListPrice({
          attempt,
          rule,
          fx: { eurToUsd: 1.08, date: "2026-11-05" },
          region,
        });

        return whole.kind === "list-price" ? whole.usd : null;
      };

      expect(at("us-east")).toBeCloseTo((at(null) ?? 0) * 1.75, 12);
      expect(row.wholeMachinePerCompletedUSD).toBeCloseTo(at("us-east") ?? 0, 12);
      rows.push(row);
    }

    // Same-machine pins request = limit; the default track's 0.125 CPU request bursts above it.
    expect(rows.map((row) => row.wholeMachineBound)).toEqual(["exact", "lower"]);
    // Costs come from Modal's billing report, unchanged.
    expect(rows.map((row) => row.costPerCompletedUSD)).toEqual([0.012, 0.012]);
  });

  it("refuses a summary whose environment region differs from the run's recorded one", async () => {
    const out = await attemptDir("rw-region-conflict", { stopped: true });
    await realisticCommand(["billing", "--out", out]);
    await writeFile(join(out, regionsFile), JSON.stringify({ modal: "us-east" }) + "\n");
    vi.stubEnv("BENCH_REGION_MODAL", "eu-west");

    await expect(
      realisticCommand(["summary", "--out", out, "--to", join(root, "rw-region-conflict-to")]),
    ).rejects.toThrow(/us-east.*eu-west|eu-west.*us-east/);
  });
});
