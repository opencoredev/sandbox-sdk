import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { it, expect, vi, afterEach } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import { runV2 } from "../src/v2-runner.js";
import { parseV2 } from "../src/v2-config.js";
import { proveSnapshotSource, UnverifiedOwnershipError } from "../src/ownership.js";

const dirs: string[] = [];
afterEach(async () => {vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, {recursive: true, force: true})));});
async function config(run: string) {
  const out = await mkdtemp(join(tmpdir(), "bench-ownership-visibility-")); dirs.push(out);
  return parseV2(["--run", run, "--runs", "1", "--bursts", "", "--scenarios", "command", "--timeout-ms", "60000", "--out", out]);
}
type View = "visible" | "hidden" | "foreign";
/** A list whose view of each sandbox is scripted per call, as a lagging control plane would show it. */
function scriptedList(backing: Provider, view: (call: number) => View) {
  let call = 0;
  return vi.fn(async (labels: Record<string, string>) => {
    const current = view(++call);
    const all = await backing.list({});
    return all.flatMap((info): SandboxInfo[] => current === "hidden" ? []
      : current === "foreign" ? [{...info, labels: {...info.labels, "sandbox-bench-run": "someone-else"}}]
      : Object.entries(labels).every(([k, v]) => info.labels[k] === v) ? [info] : []);
  });
}

it.each([
  {lag: 0, verify: 1},
  {lag: 3, verify: 4},
])("destroys a sandbox the listing shows after $lag lagging reads", async ({lag, verify}) => {
  const backing = memory();
  // Call 1 is the post-create check; the destroy check starts at call 2.
  const list = scriptedList(backing, call => call > 1 && call <= 1 + lag ? "hidden" : "visible");
  const report = await runV2([{kind: "ready", name: "memory", provider: {...backing, list}, region: null, cloud: false}], await config("visible-run"), async () => {});
  const destroy = report.samples.find(s => s.scenario === "destroy");
  expect(destroy?.outcome.kind).toBe("sample");
  expect(report.cleanupReview ?? []).toEqual([]);
  // Ownership checks read the unfiltered listing; run-wide sweeps filter by run label.
  expect(list.mock.calls.filter(([labels]) => Object.keys(labels).length === 0)).toHaveLength(1 + verify);
  // Waiting for visibility is bookkeeping, outside the destroy request metric.
  if (lag) {
    expect(destroy?.phases.ownershipVerifyMs).toBeGreaterThanOrEqual(100 + 200 + 400);
    expect(destroy?.durationMs ?? Infinity).toBeLessThan(100);
  }
  expect(await backing.list({})).toEqual([]);
});

it("keeps a sandbox whose live labels name another run, without waiting", async () => {
  const backing = memory();
  const list = scriptedList(backing, call => call > 1 ? "foreign" : "visible");
  const destroy = vi.fn(backing.destroy);
  const report = await runV2([{kind: "ready", name: "memory", provider: {...backing, list, destroy}, region: null, cloud: false}], await config("foreign-run"), async () => {});
  expect(destroy).not.toHaveBeenCalled();
  expect(report.samples.find(s => s.scenario === "destroy")?.outcome).toMatchObject({kind: "failure"});
  expect(report.cleanupReview).toContainEqual(expect.objectContaining({provider: "memory", kind: "sandbox", status: "unresolved"}));
  const failed = report.samples.find(s => s.scenario === "destroy");
  expect(failed?.phases.ownershipVerifyMs ?? Infinity).toBeLessThan(100);
  const left = await backing.list({});
  expect(left).toHaveLength(1);
  for (const info of left) await backing.destroy(info.id);
});

it.each<{view: View; owned: boolean; calls: (n: number) => boolean}>([
  {view: "visible", owned: true, calls: n => n === 4},
  {view: "foreign", owned: false, calls: n => n === 1},
  {view: "hidden", owned: false, calls: n => n > 4 && n < 25},
])("snapshot-source proof waits for a lagging list, rejecting $view labels", async ({view, owned, calls}) => {
  vi.useFakeTimers();
  const backing = memory();
  const info = await backing.create({labels: {"sandbox-bench-run": "run", "sandbox-sdk": "1"}});
  const list = scriptedList(backing, call => view === "visible" && call < 4 ? "hidden" : view);
  const proof = proveSnapshotSource({...backing, list}, info.id, "run", 120_000, 30_000);
  const settled = proof.then(value => ({value}), (error: unknown) => ({error}));
  await vi.advanceTimersByTimeAsync(31_000);
  const result = await settled;
  if (owned) expect(result).toMatchObject({value: {sourceId: info.id, runLabel: "run", sdkLabel: "1"}});
  else expect(result).toEqual({error: expect.any(UnverifiedOwnershipError)});
  expect(calls(list.mock.calls.length)).toBe(true);
  await backing.destroy(info.id);
});
