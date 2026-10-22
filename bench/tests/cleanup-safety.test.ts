import {expect, it, vi} from "vitest";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {SandboxError, createSandbox} from "@opencoredev/sandbox-sdk";
import {memory} from "@opencoredev/sandbox-sdk/memory";
import {parseV2} from "../src/v2-config.js";
import {runV2} from "../src/v2-runner.js";
import {writeV2} from "../src/v2-report.js";
import {reapRun} from "../src/recovery.js";
import type {Provider} from "@opencoredev/sandbox-sdk/provider";

it.each(["generic-cause", "sdk-foreign", "sdk-no-sdk-marker", "sdk-unreadable", "sdk-notfound"])("quarantines %s IDs and never destroys or journals them as owned", async mode => {
 const out = await mkdtemp(join(tmpdir(), "bench-safety-"));
 const backing = memory();
 const run = "safety-run";
 const candidate = mode === "sdk-no-sdk-marker"
   ? await backing.create({labels: {"sandbox-bench-run": run}})
   : await createSandbox(backing, {labels: {"sandbox-bench-run": ["generic-cause", "sdk-foreign"].includes(mode) ? "different-run" : run}});
 const destroy = vi.fn(backing.destroy);
 const provider = {...backing, destroy,
  list: mode === "sdk-unreadable" ? async () => {throw new Error("Labels unreadable");} : mode === "sdk-notfound" ? async () => [] : backing.list,
  create: async () => {
   const cause = {sandboxId: candidate.id, operation: "create", stage: "waitReady", ...(mode !== "sdk-unmarked" ? {admittedByThisCall: true} : {})};
   if (mode === "generic-cause") throw new Error("No allocation admitted", {cause});
   throw new SandboxError("Create rejected", {provider: "memory", code: "provider", sandboxId: candidate.id, cause});
  },
 };
 try {
  const config = parseV2(["--providers", "memory", "--run", run, "--runs", "1", "--scenarios", "command", "--bursts", "", "--ownership-visibility-ms", "300", "--out", out]);
  const report = await runV2([{kind: "ready", name: "memory", cloud: false, region: null, provider}], config, r => writeV2(r, out));
  expect(destroy).not.toHaveBeenCalled();
  expect((await backing.list({})).map(s => s.id)).toContain(candidate.id);
  expect(report.samples.find(s => s.scenario === "cold")).toMatchObject({sandboxId: null, outcome: {kind: "failure", unverifiedSandboxId: candidate.id}});
  expect(report.cleanupReview).toContainEqual(expect.objectContaining({provider: "memory", id: candidate.id, kind: "sandbox"}));
  expect(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")).resources).toEqual([]);
  expect(JSON.parse(await readFile(join(out, "results.json"), "utf8")).cleanupReview).toEqual(report.cleanupReview);
  expect(await readFile(join(out, "results.md"), "utf8")).toContain(`cleanupReview: `);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
   expect(await reapRun([{kind: "ready", name: "memory", cloud: false, region: null, provider}], config, s => s)).toBe(true);
   expect(stderr).toHaveBeenCalledWith(expect.stringContaining(candidate.id));
   expect(destroy).not.toHaveBeenCalled();
  } finally {stderr.mockRestore();}
 } finally {await backing.destroy(candidate.id); await rm(out, {recursive: true, force: true});}
});

it.each(["sdk-unmarked", "generic", "wrong-provider"])("releases %s create-error quarantine only after live label proof", async mode => {
 const out = await mkdtemp(join(tmpdir(), "bench-release-"));
 const backing = memory();
 const run = "release-run";
 const candidate = await createSandbox(backing, {labels: {"sandbox-bench-run": run}});
 const destroy = vi.fn(async (id: string) => {
  const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
  expect(journal.resources).toContainEqual(expect.objectContaining({id, kind: "sandbox"}));
  await backing.destroy(id);
 });
 const provider: Provider = {...backing, destroy, create: async () => {
  const cause = {sandboxId: candidate.id, operation: "create"};
  if (mode === "generic") throw new Error("Create failed", {cause});
  throw new SandboxError("Create failed", {provider: mode === "wrong-provider" ? "tenki" : "memory", code: "provider", sandboxId: candidate.id, cause});
 }};
 try {
  const config = parseV2(["--providers", "memory", "--run", run, "--runs", "1", "--scenarios", "command", "--bursts", "", "--ownership-visibility-ms", "300", "--out", out]);
  const report = await runV2([{kind: "ready", name: "memory", cloud: false, region: null, provider}], config, r => writeV2(r, out));
  expect(destroy.mock.calls).toEqual([[candidate.id]]);
  expect(await backing.list({})).toEqual([]);
  expect(report.cleanupReview).toEqual([]);
  expect(report.cleanupReleased).toContainEqual(expect.objectContaining({id: candidate.id, proof: "live-run-sdk-labels", releasedAt: expect.any(String)}));
  expect(report.samples.find(s => s.scenario === "cold")).toMatchObject({sandboxId: candidate.id, outcome: {kind: "failure", ownershipReleased: true}});
  expect(JSON.parse(await readFile(join(out, "results.json"), "utf8")).cleanupReleased).toEqual(report.cleanupReleased);
  expect(await readFile(join(out, "results.md"), "utf8")).toContain("cleanupReleased: ");
  expect(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")).resources).toEqual([]);
 } finally {await backing.destroy(candidate.id); await rm(out, {recursive: true, force: true});}
});

it("reap releases a quarantined sandbox only when labels become readable", async () => {
 const out = await mkdtemp(join(tmpdir(), "bench-reap-release-"));
 const backing = memory();
 const run = "reap-release";
 const own = await createSandbox(backing, {labels: {"sandbox-bench-run": run}});
 let readable = false;
 const destroy = vi.fn(backing.destroy);
 const provider: Provider = {...backing, destroy, list: async labels => readable ? backing.list(labels) : [], create: async () => {
  throw new SandboxError("Create failed", {provider: "memory", code: "provider", sandboxId: own.id});
 }};
 const config = parseV2(["--providers", "memory", "--run", run, "--runs", "1", "--scenarios", "command", "--bursts", "", "--ownership-visibility-ms", "300", "--out", out]);
 const loaded = [{kind: "ready", name: "memory", cloud: false, region: null, provider}] satisfies Parameters<typeof reapRun>[0];
 const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
 const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
 try {
  const report = await runV2(loaded, config, r => writeV2(r, out));
  expect(report.cleanupReview).toHaveLength(1);
  expect(await reapRun(loaded, config, s => s)).toBe(true);
  expect(destroy).not.toHaveBeenCalled();
  readable = true;
  expect(await reapRun(loaded, config, s => s)).toBe(false);
  expect(destroy.mock.calls).toEqual([[own.id]]);
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("cleanupReleased:"));
  const recovered = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
  expect(recovered.cleanupReview).toEqual([]);
  expect(recovered.cleanupReleased).toHaveLength(1);
  expect(await readFile(join(out, "results.md"), "utf8")).toContain("cleanupReview: []");
  expect(await backing.list({})).toEqual([]);
 } finally {stderr.mockRestore(); stdout.mockRestore(); await backing.destroy(own.id); await rm(out, {recursive: true, force: true});}
});

it("quarantines a released ID again if live ownership proof disappears before a retry", async () => {
 const out = await mkdtemp(join(tmpdir(), "bench-release-retry-"));
 const backing = memory();
 const run = "release-retry";
 const own = await createSandbox(backing, {labels: {"sandbox-bench-run": run}});
 let readable = true;
 const destroy = vi.fn(async () => {readable = false; throw new Error("Delete failed");});
 const provider: Provider = {...backing, destroy, list: async labels => readable ? backing.list(labels) : [], create: async () => {
  throw new SandboxError("Create failed", {provider: "memory", code: "provider", sandboxId: own.id});
 }};
 try {
  const config = parseV2(["--providers", "memory", "--run", run, "--runs", "1", "--scenarios", "command", "--bursts", "", "--ownership-visibility-ms", "300", "--out", out]);
  const report = await runV2([{kind: "ready", name: "memory", cloud: false, region: null, provider}], config, r => writeV2(r, out));
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(report.cleanupReleased).toHaveLength(1);
  expect(report.cleanupReview).toContainEqual(expect.objectContaining({id: own.id}));
  const cold = report.samples.find(s => s.scenario === "cold");
  expect(cold?.outcome).toMatchObject({kind: "failure", unverifiedSandboxId: own.id});
  expect(cold?.outcome).not.toHaveProperty("ownershipReleased");
  expect(await backing.list({})).toHaveLength(1);
 } finally {await backing.destroy(own.id); await rm(out, {recursive: true, force: true});}
});

it("does not trust an admission marker on an exec error", async () => {
 const out = await mkdtemp(join(tmpdir(), "bench-exec-safety-"));
 const backing = memory();
 const foreign = await createSandbox(backing, {labels: {"sandbox-bench-run": "different-run"}});
 const destroy = vi.fn(backing.destroy);
 const provider: Provider = {...backing, destroy, exec: async () => {
  throw new SandboxError("Spoofed admission", {provider: "memory", code: "provider", sandboxId: foreign.id,
   cause: {operation: "create", admittedByThisCall: true, sandboxId: foreign.id}});
 }};
 try {
  const config = parseV2(["--providers", "memory", "--run", "exec-safety", "--runs", "1", "--scenarios", "command", "--bursts", "", "--ownership-visibility-ms", "300", "--out", out]);
  const report = await runV2([{kind: "ready", name: "memory", cloud: false, region: null, provider}], config, r => writeV2(r, out));
  expect(destroy.mock.calls.some(([id]) => id === foreign.id)).toBe(false);
  expect((await backing.list({})).map(s => s.id)).toEqual([foreign.id]);
  expect(report.cleanupReview).toContainEqual(expect.objectContaining({id: foreign.id}));
 } finally {await backing.destroy(foreign.id); await rm(out, {recursive: true, force: true});}
});

it("rechecks ownership at deletion and records the ID when labels become unreadable", async () => {
 const out = await mkdtemp(join(tmpdir(), "bench-changed-labels-"));
 const backing = memory();
 const destroy = vi.fn(backing.destroy);
 let listings = 0;
 const provider: Provider = {...backing, destroy, list: async labels => {
  if (++listings > 1) throw new Error("Labels unreadable");
  return backing.list(labels);
 }};
 try {
  const config = parseV2(["--providers", "memory", "--run", "changed-labels", "--runs", "1", "--scenarios", "command", "--bursts", "", "--ownership-visibility-ms", "300", "--out", out]);
  const report = await runV2([{kind: "ready", name: "memory", cloud: false, region: null, provider}], config, r => writeV2(r, out));
  const [survivor] = await backing.list({});
  expect(survivor).toBeDefined();
  expect(destroy).not.toHaveBeenCalled();
  expect(report.samples.find(s => s.scenario === "destroy")?.outcome).toMatchObject({kind: "failure", unverifiedSandboxId: survivor?.id});
  expect(report.cleanupReview).toContainEqual(expect.objectContaining({id: survivor?.id}));
 } finally {for (const info of await backing.list({})) await backing.destroy(info.id); await rm(out, {recursive: true, force: true});}
});

it("recovery refuses a snapshot ID not linked to its verified parent", async () => {
 const snapshots = await import("../src/snapshots.js");
 const out = await mkdtemp(join(tmpdir(), "bench-snapshot-safety-"));
 const backing = memory();
 const own = await createSandbox(backing, {labels: {"sandbox-bench-run": "snapshot-safety"}});
 const cleaner = vi.fn();
 const discover = vi.spyOn(snapshots, "snapshotsFromSource").mockResolvedValue([{id: "own-snapshot", name: "own-snapshot"}]);
 const factory = vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(cleaner);
 const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
 try {
  await writeFile(join(out, "ownership.json"), JSON.stringify({runId: "snapshot-safety", resources: [{provider: "daytona", id: "foreign-snapshot", kind: "snapshot", parent: own.id}]}));
  const config = parseV2(["--providers", "daytona", "--run", "snapshot-safety", "--out", out]);
  expect(await reapRun([{kind: "ready", name: "daytona", cloud: false, region: null, provider: backing}], config, s => s)).toBe(true);
  expect(cleaner).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(out, "results.json"), "utf8")).cleanupReview).toContainEqual(expect.objectContaining({id: "foreign-snapshot"}));
 } finally {discover.mockRestore(); factory.mockRestore(); stderr.mockRestore(); await backing.destroy(own.id); await rm(out, {recursive: true, force: true});}
});

it("recovery rejects foreign bare journal IDs and snapshot parents, but deletes verified run-labelled sandboxes", async () => {
 const out = await mkdtemp(join(tmpdir(), "bench-recovery-safety-"));
 const backing = memory();
 const run = "recovery-safety";
 const own = await createSandbox(backing, {labels: {"sandbox-bench-run": run}});
 const foreign = await createSandbox(backing, {labels: {"sandbox-bench-run": "different-run"}});
 const noSdk = await backing.create({labels: {"sandbox-bench-run": run}});
 const destroy = vi.fn(backing.destroy);
 const provider = {...backing, destroy};
 const config = parseV2(["--providers", "memory", "--run", run, "--out", out, "--timeout-ms", "100"]);
 const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
 try {
  const resources: {provider: string; id: string; kind: string; parent: string | null}[] = [foreign.id, noSdk.id, own.id].map(id => ({provider: "memory", id, kind: "sandbox", parent: null}));
  resources.push({provider: "memory", id: "foreign-snapshot", kind: "snapshot", parent: foreign.id});
  await writeFile(join(out, "ownership.json"), JSON.stringify({runId: run, resources}));
  await writeFile(join(out, "results.json"), JSON.stringify({cleanupReview: []}));
  expect(await reapRun([{kind: "ready", name: "memory", cloud: false, region: null, provider}], config, s => s)).toBe(true);
  expect(destroy.mock.calls).toEqual([[own.id]]);
  expect((await backing.list({})).map(s => s.id)).toEqual(expect.arrayContaining([foreign.id, noSdk.id]));
  const report = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
  expect(report.cleanupReview).toHaveLength(3);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(foreign.id));
  expect(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")).resources).toHaveLength(3);
 } finally {stderr.mockRestore(); for (const box of await backing.list({})) await backing.destroy(box.id); await rm(out, {recursive: true, force: true});}
});
