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

it.each(["e2b", "daytona", "superserve"])("orders %s restore, snapshot and source deletion after lagged labels", async name => {
 const out = await directory(); const backing = memory();
 const foreign = await createSandbox(backing, {labels: {"sandbox-bench-run": "foreign"}});
 const events: string[] = []; let source = "", restored = "", hidden = 0, conflicts = 0;
 let snapshotDeleted = false, snapshotId = "snapshot";
 vi.spyOn(snapshots, "createNamedDaytonaSnapshot").mockImplementation(async (_provider, _source, id) => {snapshotId = id; events.push("snapshot-create"); return {id};});
 vi.spyOn(snapshots, "snapshotsFromSource").mockImplementation(async () => snapshotDeleted ? [] : [{id: snapshotId}]);
 const provider: Provider = {...backing, capabilities: new Set(["snapshot"]),
  create: async input => {const info = await backing.create(input); if (input.from) restored = info.id; else source = info.id; return info;},
  list: async labels => (await backing.list(labels)).map(info => info.id === restored && hidden++ < 2 ? {...info, labels: {}} : info),
  snapshot: async () => {events.push("snapshot-create"); return {id: snapshotId};},
  destroy: async id => {events.push(id === source ? "source-delete" : "restore-delete"); await backing.destroy(id);},
 };
 vi.spyOn(snapshots.snapshotMetadata, "inspect").mockImplementation(async () => ({exists: true, sourceId: source}));
 vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {
  expect((await backing.list({})).some(info => info.id === restored)).toBe(false);
  expect((await backing.list({})).some(info => info.id === source)).toBe(true);
  const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
  expect(journal.resources).toContainEqual(expect.objectContaining({id: snapshotId, snapshotProof: expect.objectContaining({sourceId: source, runLabel: "snapshot-run", sdkLabel: "1", verifiedAt: expect.any(String)})}));
  events.push("snapshot-delete");
  if (conflicts++ < 1) throw Object.assign(new Error("Snapshot still in use by running sandbox"), {statusCode: 400});
  snapshotDeleted = true;
 });
 try {
  const report = await runV2([{kind: "ready", name, cloud: false, region: null, provider}], parseV2(["--providers", name, "--run", "snapshot-run", "--runs", "1", "--bursts", "", "--scenarios", "snapshot", "--timeout-ms", "2000", "--out", out]), async () => {});
  expect(events).toEqual(["snapshot-create", "restore-delete", "snapshot-delete", "snapshot-delete", "source-delete"]);
  expect(report.cleanup).toEqual([{provider: name, remaining: [], error: null}]);
  expect(report.cleanupReview).toEqual([]);
  expect(report.samples.find(s => s.scenario === "create-from-snapshot")?.phases.ownershipVerifyMs).toBeGreaterThanOrEqual(290);
  expect((await backing.list({})).map(info => info.id)).toEqual([foreign.id]);
  expect(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")).resources).toEqual([]);
 } finally {for (const info of await backing.list({})) await backing.destroy(info.id);}
});

it.each(["e2b", "daytona", "superserve"])("keeps the %s snapshot and source when a verified restore cannot be deleted", async name => {
 const out = await directory(); const backing = memory(); let source = "", restored = "", snapshotId = "snapshot";
 const destroy = vi.fn(async (id: string) => {if (id === source) await backing.destroy(id); else throw new Error("Restore deletion unavailable");});
 const provider: Provider = {...backing, capabilities: new Set(["snapshot"]),
  create: async input => {const info = await backing.create(input); if (input.from) restored = info.id; else source = info.id; return info;},
  snapshot: async () => ({id: snapshotId}),
  destroy,
 };
 const remove = vi.fn(async () => {});
 vi.spyOn(snapshots, "createNamedDaytonaSnapshot").mockImplementation(async (_provider, _source, id) => {snapshotId = id; return {id};});
 const discover = vi.spyOn(snapshots, "snapshotsFromSource").mockImplementation(async () => [{id: snapshotId}]);
 vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(remove);
 vi.spyOn(snapshots.snapshotMetadata, "inspect").mockResolvedValue({exists: true});
 try {
  const report = await runV2([{kind: "ready", name, cloud: false, region: null, provider}], parseV2(["--providers", name, "--run", "snapshot-run", "--runs", "1", "--bursts", "", "--scenarios", "snapshot", "--timeout-ms", "100", "--out", out]), async () => {});
  expect(restored).toBeTruthy(); expect(remove).not.toHaveBeenCalled();
  expect(destroy.mock.calls.every(([id]) => id === restored)).toBe(true);
  expect(discover).not.toHaveBeenCalled();
  const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
  expect(journal.resources).toEqual(expect.arrayContaining([
   expect.objectContaining({id: source, kind: "sandbox"}), expect.objectContaining({id: restored, kind: "sandbox"}),
   expect.objectContaining({id: snapshotId, kind: "snapshot", parent: source}),
  ]));
  if (name !== "e2b") expect(journal.resources).toContainEqual(expect.objectContaining({id: source, kind: "snapshot-source"}));
  expect((await backing.list({})).map(info => info.id)).toEqual(expect.arrayContaining([source, restored]));
  expect(report.cleanupReview).toContainEqual(expect.objectContaining({id: snapshotId, kind: "snapshot", reason: expect.stringContaining("Restore cleanup unresolved")}));
  expect(report.cleanup[0]?.error).toBeTruthy();
 } finally {for (const info of await backing.list({})) await backing.destroy(info.id);}
});

it.each(["daytona", "superserve"])("releases the %s snapshot/source dependency after a later verified restore deletion succeeds", async name => {
 const out = await directory(); const backing = memory(); let source = "", restored = "", snapshotDeleted = false, snapshotId = "snapshot", attempts = 0;
 const events: string[] = [];
 const provider: Provider = {...backing, capabilities: new Set(["snapshot"]),
  create: async input => {const info = await backing.create(input); if (input.from) restored = info.id; else source = info.id; return info;},
  snapshot: async () => ({id: snapshotId}),
  destroy: async id => {
   if (id === restored && ++attempts <= 9) throw new Error("Temporary restore deletion failure");
   events.push(id === source ? "source" : "restore"); await backing.destroy(id);
  },
 };
 vi.spyOn(snapshots, "createNamedDaytonaSnapshot").mockImplementation(async (_provider, _source, id) => {snapshotId = id; return {id};});
 vi.spyOn(snapshots.snapshotMetadata, "inspect").mockResolvedValue({exists: true});
 vi.spyOn(snapshots, "snapshotsFromSource").mockImplementation(async () => snapshotDeleted ? [] : [{id: snapshotId}]);
 vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(async () => {
  expect((await backing.list({})).some(info => info.id === restored)).toBe(false);
  events.push("snapshot"); snapshotDeleted = true;
 });
 try {
  const report = await runV2([{kind: "ready", name, cloud: false, region: null, provider}], parseV2(["--providers", name, "--run", "snapshot-run", "--runs", "1", "--bursts", "", "--scenarios", "snapshot", "--timeout-ms", "100", "--out", out]), async () => {});
  expect(attempts).toBe(10);
  expect(events).toEqual(["restore", "snapshot", "source"]);
  expect(report.cleanup).toEqual([{provider: name, remaining: [], error: null}]);
  expect(report.cleanupReview).toEqual([]);
  expect(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")).resources).toEqual([]);
 } finally {for (const info of await backing.list({})) await backing.destroy(info.id);}
});
