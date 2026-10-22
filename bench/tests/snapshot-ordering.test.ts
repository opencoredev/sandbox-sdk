import {afterEach, expect, it, vi} from "vitest";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {memory} from "@opencoredev/sandbox-sdk/memory";
import {createSandbox} from "@opencoredev/sandbox-sdk";
import type {Provider} from "@opencoredev/sandbox-sdk/provider";
import * as snapshots from "../src/snapshots.js";
import {runV2} from "../src/v2-runner.js";
import {parseV2} from "../src/v2-config.js";
const dirs: string[] = [];
afterEach(async () => {vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(dirs.splice(0).map(out => rm(out, {recursive: true, force: true})));});
async function directory() {const out = await mkdtemp(join(tmpdir(), "bench-snapshot-proof-")); dirs.push(out); return out;}

it("journals source proof, waits for restore labels, then destroys restore before snapshot and source", async () => {
 const out = await directory(); const backing = memory();
 const foreign = await createSandbox(backing, {labels: {"sandbox-bench-run": "foreign"}});
 const events: string[] = []; let source = "", restored = "", hidden = 0, conflicts = 0;
 const provider: Provider = {...backing, capabilities: new Set(["snapshot"]),
  create: async input => {const info = await backing.create(input); if (input.from) restored = info.id; else source = info.id; return info;},
  list: async labels => (await backing.list(labels)).map(info => info.id === restored && hidden++ < 2 ? {...info, labels: {}} : info),
  snapshot: async () => {events.push("snapshot-create"); return {id: "snapshot"};},
  destroy: async id => {events.push(id === source ? "source-delete" : "restore-delete"); await backing.destroy(id);},
 };
 vi.spyOn(snapshots.snapshotMetadata, "inspect").mockImplementation(async () => ({exists: true, sourceId: source}));
 vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {
  expect((await backing.list({})).some(info => info.id === restored)).toBe(false);
  expect((await backing.list({})).some(info => info.id === source)).toBe(true);
  const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
  expect(journal.resources).toContainEqual(expect.objectContaining({id: "snapshot", snapshotProof: expect.objectContaining({sourceId: source, runLabel: "snapshot-run", sdkLabel: "1", verifiedAt: expect.any(String)})}));
  events.push("snapshot-delete");
  if (conflicts++ < 1) throw Object.assign(new Error("Snapshot still in use by running sandbox"), {statusCode: 400});
 });
 try {
  const report = await runV2([{kind: "ready", name: "e2b", cloud: false, region: null, provider}], parseV2(["--providers", "e2b", "--run", "snapshot-run", "--runs", "1", "--bursts", "", "--scenarios", "snapshot", "--timeout-ms", "2000", "--out", out]), async () => {});
  expect(events).toEqual(["snapshot-create", "restore-delete", "snapshot-delete", "snapshot-delete", "source-delete"]);
  expect(report.cleanup).toEqual([{provider: "e2b", remaining: [], error: null}]);
  expect(report.cleanupReview).toEqual([]);
  expect(report.samples.find(s => s.scenario === "create-from-snapshot")?.phases.ownershipVerifyMs).toBeGreaterThanOrEqual(290);
  expect((await backing.list({})).map(info => info.id)).toEqual([foreign.id]);
  expect(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")).resources).toEqual([]);
 } finally {for (const info of await backing.list({})) await backing.destroy(info.id);}
});

it("keeps the snapshot and its source when restore deletion cannot complete", async () => {
 const out = await directory(); const backing = memory(); let source = "", restored = "";
 const provider: Provider = {...backing, capabilities: new Set(["snapshot"]),
  create: async input => {const info = await backing.create(input); if (input.from) restored = info.id; else source = info.id; return info;},
  snapshot: async () => ({id: "snapshot"}),
  destroy: async id => {expect(id).not.toBe(source); throw new Error("Restore deletion unavailable");},
 };
 const remove = vi.fn(async () => {});
 vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(remove);
 vi.spyOn(snapshots.snapshotMetadata, "inspect").mockResolvedValue({exists: true});
 try {
  const report = await runV2([{kind: "ready", name: "e2b", cloud: false, region: null, provider}], parseV2(["--providers", "e2b", "--run", "snapshot-run", "--runs", "1", "--bursts", "", "--scenarios", "snapshot", "--timeout-ms", "100", "--out", out]), async () => {});
  expect(restored).toBeTruthy(); expect(remove).not.toHaveBeenCalled();
  expect((await backing.list({})).map(info => info.id)).toEqual(expect.arrayContaining([source, restored]));
  expect(report.cleanupReview).toContainEqual(expect.objectContaining({id: "snapshot", kind: "snapshot", reason: expect.stringContaining("Restore cleanup unresolved")}));
  expect(report.cleanup[0]?.error).toBeTruthy();
 } finally {for (const info of await backing.list({})) await backing.destroy(info.id);}
});
