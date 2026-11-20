/**
 * A run never overwrites another run's cleanup journal that still lists resources: `bench reap`
 * for that run would lose them. `--force` overrides.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { parseV2 } from "../src/v2-config.js";
import { runV2 } from "../src/v2-runner.js";
import { writeV2 } from "../src/v2-report.js";
import { bound } from "./native-fakes.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const earlier = {
  runId: "earlier-run",
  connectionFingerprints: {},
  resources: [{ provider: "e2b", id: "sb-left-running", kind: "sandbox", parent: null }],
  apps: [],
};

async function out(journal: typeof earlier | null) {
  const dir = await mkdtemp(join(tmpdir(), "bench-journal-guard-"));
  dirs.push(dir);

  if (journal) await writeFile(join(dir, "ownership.json"), JSON.stringify(journal));

  return dir;
}

async function start(dir: string, run: string, extra: string[] = []) {
  const config = parseV2([
    "--providers",
    "memory",
    "--run",
    run,
    "--runs",
    "1",
    "--scenarios",
    "command",
    "--bursts",
    "",
    "--out",
    dir,
    ...extra,
  ]);

  return runV2(
    [{ kind: "ready", name: "memory", cloud: false, region: null, provider: bound(memory()) }],
    config,
    (r) => writeV2(r, dir),
  );
}

const journalAt = async (dir: string) =>
  JSON.parse(await readFile(join(dir, "ownership.json"), "utf8"));

it("refuses to start over another run's journal with entries, and leaves it as it was", async () => {
  const dir = await out(earlier);

  await expect(start(dir, "new-run")).rejects.toThrow(
    /holds 1 cleanup entries of run earlier-run.*--force/,
  );
  expect(await journalAt(dir)).toEqual(earlier);
});

it("starts over it with --force, and the journal is the new run's", async () => {
  const dir = await out(earlier);

  await start(dir, "new-run", ["--force"]);
  expect((await journalAt(dir)).runId).toBe("new-run");
});

it("starts over an empty journal of another run, or one of the same run", async () => {
  const empty = await out({ ...earlier, resources: [] });

  await start(empty, "new-run");
  expect((await journalAt(empty)).runId).toBe("new-run");

  const same = await out({ ...earlier, runId: "same-run" });

  await start(same, "same-run");
  expect((await journalAt(same)).runId).toBe("same-run");
});
