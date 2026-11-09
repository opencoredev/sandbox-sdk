import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { realisticAttemptApp, type JournalApp } from "../../src/modal-apps.js";
import { appJournalFile, stopJournalFile } from "../../src/realistic/apps.js";
import { realisticCommand } from "../../src/realistic/cli.js";
import { attributionFor, emptyRecord } from "../../src/realistic/slots.js";
import { fakeNativeModules } from "../native-fakes.js";
import { buildFixture, type Fixture } from "./fixture.js";

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
async function attemptDir(name: string, options: { stopped: boolean }) {
  const out = join(root, name);
  const attemptId = `${name}-b0-s0-fat-same-modal`;
  const app = realisticAttemptApp(attemptId);

  const record = emptyRecord(
    {
      runId: name,
      attemptId,
      provider: "modal",
      manifest: fixture.manifest,
      manifestSha256: null,
      profileName: "fix-and-test",
      track: "same-machine",
      variant: "headline",
      batch: 0,
      slot: { index: 0, id: "fat-same" },
      seed: 20261105,
      slotStartedAt: startedAt,
    },
    "error",
    "",
    startedAt,
    attributionFor("modal").attribution,
  );

  record.completion = { kind: "completed" };
  record.sandboxIds = ["sb-1"];
  record.startedAt = startedAt;
  record.endedAt = endedAt;
  record.deletionConfirmed = true;

  const journaled: JournalApp = {
    provider: "modal",
    name: app,
    appId: "ap-1",
    sandboxes: ["sb-1"],
    allocations: [{ id: "alloc-1", state: "allocated", sandboxId: "sb-1" }],
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
});
