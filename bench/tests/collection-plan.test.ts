import {expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {metricDefs} from "../src/site-data.js";
import {collectionPolicy} from "../src/collection-policy.js";
const script = readFileSync(new URL("../src/collection-plan.sh", import.meta.url), "utf8");
const scriptPath = fileURLToPath(new URL("../src/collection-plan.sh", import.meta.url));
function plan(mode: string, cwd?: string) {
  const result = spawnSync("bash", [scriptPath, mode], {cwd, encoding: "utf8", env: {...process.env, BENCH_PLAN_DRY_RUN: "1"}, timeout: 5000});
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.replaceAll("\\,", ",");
}
it("plans every default scenario and all 27 metric IDs on a pinned commit", () => {
  const output = plan("default-nonboat");
  expect(metricDefs).toHaveLength(27);
  const scenarios = /--scenarios ([^ ]+)/.exec(output)?.[1]?.split(",") ?? [];
  expect(scenarios).toEqual(["command", "files-1kb", "files-10mb", "reconnect", "pause-resume", "perf", "git-clone", "npm-install", "dev-server", "preview-first-byte", "edit-loop", "tool-replay", "pip-install"]);
  for (const def of metricDefs) {
    const covered = ["cold", "destroy", "snapshot", "create-from-snapshot"].includes(def.scenario) || def.scenario.startsWith("burst-") || def.suite === "main" && (scenarios.includes(def.scenario) || ["cpu-single", "cpu-all", "memory-mbps", "disk-write-mbps", "disk-read-mbps", "disk-4k-write-iops", "disk-4k-read-iops", "tcp-ms", "network-mbps"].includes(def.scenario) && scenarios.includes("perf"));
    expect(covered, def.id).toBe(true);
  }
  expect(output).toContain("--template e2b=base");
  expect(output).toContain("--template superserve=sandbox-bench-node22-py311-1x1-pinned ");
  expect(output).not.toContain("--template superserve=sandbox-bench-node22-py311-1x1 ");
  expect(script).toContain('git rev-parse HEAD');
  expect(script).toContain('BENCH_COLLECTION_COMMIT');
});
it("uses the verified same-spec mapping and leaves capped Superserve out", () => {
  const output = plan("same-spec-nonboat");
  expect(output).toContain("--providers e2b,daytona,upstash,boxd,freestyle,tenki");
  expect(output).toContain("--template e2b=r1h7gud12rf1f6iu29r0");
  expect(output).toContain("--template daytona=daytona-large");
  expect(output).toContain("--size upstash=medium");
  expect(output).toContain("--size boxd=4:16384");
  expect(output).toContain("--size tenki=4:8192 ");
  expect(output).not.toContain("superserve=");
  expect(script).toContain("DAYTONA_TARGET=us");
});
it("keeps Boat windows below verified quotas and documents impossible K25", () => {
  for (const track of ["default", "same-spec"]) {
    const windows = [0, 1, 2].map(i => plan(`boat-${track}-${i}`));
    expect(windows.map(w => w.split("\n").filter(l => l.startsWith("bun bench")).length)).toEqual([6, 6, 4]);
    expect(windows.join("")).not.toContain("--bursts 10,25");
    expect(windows.join("").match(/--burst-cohorts 1/g)).toHaveLength(3);
    expect(windows.join("").match(/WAIT_SECONDS 65/g)).toHaveLength(16);
  }
  const help = plan("help"); expect(help).toContain("26 hours"); expect(help).toContain("65 minutes");
  expect(collectionPolicy().notRun).toContainEqual(expect.objectContaining({provider: "boat", track: "default", scenario: "burst-25/*"}));
  expect(collectionPolicy().notRun).toContainEqual(expect.objectContaining({provider: "superserve", track: "same-spec", scenario: "cold"}));
});


it("keeps collection outputs and policy imports stable from root, bench and outside the repository", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  const expected = plan("default-nonboat", root);
  for (const cwd of [resolve(root, "bench"), tmpdir()]) {
    expect(plan("default-nonboat", cwd)).toBe(expected);
    expect(plan("same-spec-nonboat", cwd)).toBe(plan("same-spec-nonboat", root));
    expect(plan("boat-default-0", cwd)).toBe(plan("boat-default-0", root));
    expect(plan("policy", cwd)).toBe(plan("policy", root));
  }
  expect(expected).toContain(`--out ${root}/bench/results/sbx53-default-main`);
  expect(plan("help", tmpdir())).toContain("ownership.json");
});


it("omits the public CDN download in every collection invocation", () => {
  for (const track of ["default", "same-spec"]) {
    for (const mode of [`${track}-nonboat`, ...[0, 1, 2].map(i => `boat-${track}-${i}`)]) {
      const commands = plan(mode).split("\n").filter(line => line.startsWith("bun bench "));
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) expect(command).toContain("--omit-network-download true");
    }
  }
});


it("does not launch Daytona cohorts or restores above the verified account quota", () => {
  const commands = (track: string) => plan(`${track}-nonboat`).split("\n").filter(line => line.startsWith("bun bench "));
  const hasDaytona = (line: string) => /--providers [^ ]*\bdaytona\b/.test(line);
  const defaults = commands("default");
  const spec = commands("same-spec");
  expect(defaults.filter(line => hasDaytona(line) && line.includes("--scenarios burst"))).toHaveLength(1);
  expect(defaults.find(line => hasDaytona(line) && line.includes("--scenarios burst"))).toContain("--bursts 10 --burst-cohorts 3");
  expect(hasDaytona(defaults.find(line => line.includes("--scenarios snapshot")) ?? "")).toBe(true);
  expect(spec.filter(hasDaytona)).toHaveLength(1);
  expect(spec.find(hasDaytona)).toContain("--scenarios command,");
  const policy = collectionPolicy();
  const restrictions = policy.notRun.filter(r => r.provider === "daytona");
  expect(restrictions).toHaveLength(5);
  for (const rule of restrictions) expect(rule.reason).toContain("CPU 10 vCPU / memory 10 GiB / disk 30 GiB");
  expect(restrictions).toContainEqual(expect.objectContaining({track: "same-spec", suite: "snapshot", scenario: "snapshot", reason: expect.stringContaining("16 GiB")}));
  expect(restrictions).toContainEqual(expect.objectContaining({track: "same-spec", suite: "snapshot", scenario: "create-from-snapshot"}));
  for (const k of [10, 25]) expect(restrictions).toContainEqual(expect.objectContaining({track: "same-spec", suite: "burst", scenario: `burst-${k}/*`}));
  expect(restrictions).toContainEqual(expect.objectContaining({track: "default", suite: "burst", scenario: "burst-25/*"}));
  expect(restrictions.some(r => r.track === "default" && r.scenario === "burst-10/*")).toBe(false);
});
