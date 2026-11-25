/**
 * Every fairness check end to end on this machine with the real sbx-native binary, short plans.
 * Linux x86_64 only (the binary's platform).
 */
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerSetup } from "../../src/realistic/setup.js";
import { cpuBurstCheck, type BurstResult } from "../../src/fairness/cpu-burst.js";
import { cpuNativeCheck, type CpuNativeResult } from "../../src/fairness/cpu-native.js";
import { diskRealCheck, type DiskResult } from "../../src/fairness/disk-real.js";
import {
  parseLog,
  reportSchema,
  runCheck,
  type Box,
  type Check,
  type OpenSession,
} from "../../src/fairness/framework.js";
import { memoryHonestyCheck, type MemoryResult } from "../../src/fairness/memory-honesty.js";
import { securityProbe, type SecurityResult } from "../../src/fairness/security-probe.js";
import { hostBox, hostSession } from "./host-box.js";

const supported = platform() === "linux" && arch() === "x64";
const setup = providerSetup("e2b");

async function runOnHost<R>(check: Check<R>, open: OpenSession) {
  const out = await mkdtemp(join(tmpdir(), `fairness-${check.id}-`));

  const outcome = await runCheck(
    check,
    [setup],
    { runId: "host-test", out, concurrency: 1 },
    {
      open,
      signal: new AbortController().signal,
      progress: () => {},
      retryDelayMs: 0,
      lateSweepDelayMs: 0,
    },
  );

  const report = reportSchema.parse(
    JSON.parse(await readFile(join(out, `${check.id}.json`), "utf8")),
  );

  const log = parseLog(await readFile(join(out, "logs", "e2b.jsonl"), "utf8"));
  const entry = report.providers[0];

  if (!entry) throw new Error("no entry");

  return { outcome, report, entry, log, out };
}

describe.runIf(supported)("fairness checks on this machine", () => {
  it("cpu-native verifies every segment and summarizes the phases", async () => {
    const host = hostSession();

    const check = cpuNativeCheck(
      {
        single: { segments: 2, seconds: 0.5, workers: 1 },
        allCore: { segments: 1, seconds: 0.5, workers: 4 },
        sustained: { segments: 3, seconds: 0.5, workers: 4 },
      },
      200,
    );

    const { entry, log, outcome } = await runOnHost(check, host.open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result) satisfies CpuNativeResult;
    expect(result.single.segments).toHaveLength(2);
    expect(result.single.medianOps).toBeGreaterThan(1e7);
    expect(result.allCore.segments[0]?.perWorker).toHaveLength(4);
    expect(result.scaling).toBeGreaterThan(0.2);
    expect(result.sustained.segments).toHaveLength(3);
    expect(result.sustained.retention).not.toBeNull();
    expect(result.binarySha256Verified).toBe(true);
    expect(log.filter((l) => l.kind === "event" && l.name === "sustained-segment")).toHaveLength(3);
    expect(host.boxes.every((box) => box.destroyed())).toBe(true);
    expect(outcome.cleanupProblems).toEqual([]);
  }, 60_000);

  it("cpu-native stops when a box reports work it did not do", async () => {
    const real = hostBox();

    // Doubles every worker's steps: the checksum no longer matches.
    const lying: Box = {
      ...real,
      run: async (command, options) => {
        const result = await real.run(command, options);

        return {
          ...result,
          stdout: result.stdout.replaceAll(
            /"steps":(\d+)/g,
            (_, n: string) => `"steps":${Number(n) * 2}`,
          ),
        };
      },
    };

    const open: OpenSession = async () => ({
      kind: "ready",
      session: {
        create: async () => lying,
        leftovers: async () => [],
        destroyById: async () => {},
      },
    });

    const check = cpuNativeCheck(
      {
        single: { segments: 1, seconds: 0.3, workers: 1 },
        allCore: { segments: 1, seconds: 0.3, workers: 4 },
        sustained: { segments: 1, seconds: 0.3, workers: 4 },
      },
      200,
    );

    const { entry } = await runOnHost(check, open);
    expect(entry.status).toBe("failed");
    expect(entry.reason).toMatch(/totalSteps|checksum/);
    expect(entry.result).toBeNull();
  }, 30_000);

  it("disk-real writes, reads back and checks a file", async () => {
    const home = await mkdtemp(join(tmpdir(), "fairness-home-"));
    const host = hostSession({ env: { HOME: home } });
    const check = diskRealCheck({ randomSeconds: 0.3, sizeMiB: 64 });
    const { entry } = await runOnHost(check, host.open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result) satisfies DiskResult;
    expect(result.sizeMiB).toBe(64);
    expect(result.seqWriteMiBps).toBeGreaterThan(0);
    expect(result.randReadIops).toBeGreaterThan(0);
    expect(result.raw.seqRead.badPages).toBe(0);
    expect(result.fsType).not.toBe("");
    // The file is gone afterwards.
    expect(await readdir(result.directory)).not.toContain("sbx-native-disk.bin");
  }, 60_000);

  it("memory-honesty dirties, writes and verifies", async () => {
    const home = await mkdtemp(join(tmpdir(), "fairness-home-"));
    const host = hostSession({ env: { HOME: home } });
    const check = memoryHonestyCheck({ memoryMiB: 64, fileMiB: 16 });
    const { entry } = await runOnHost(check, host.open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result) satisfies MemoryResult;
    expect(result.outcome.kind).toBe("completed");
    expect(result.limits.nproc).toBeGreaterThan(0);
    expect(result.visibleCpus).toBeGreaterThan(0);

    if (result.outcome.kind === "completed") {
      expect(result.outcome.raw.badWords).toBe(0);
      expect(result.outcome.raw.fileWrittenMiB).toBe(16);
    }
  }, 60_000);

  it("memory-honesty records a kill instead of failing the check", async () => {
    const real = hostBox();

    // The mem run dies after filling, as an out-of-memory kill would leave it.
    const killed: Box = {
      ...real,
      run: async (command, options) =>
        / mem /.test(command)
          ? {
              ok: false,
              exitCode: 137,
              stdout: "#phase start 0\n#phase filled 1.2\n",
              stderr: "",
              timedOut: false,
            }
          : real.run(command, options),
    };

    const open: OpenSession = async () => ({
      kind: "ready",
      session: {
        create: async () => killed,
        leftovers: async () => [],
        destroyById: async () => {},
      },
    });

    const check = memoryHonestyCheck({ memoryMiB: 64, fileMiB: 16 });
    const { entry } = await runOnHost(check, open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result);
    expect(result.outcome).toMatchObject({
      kind: "killed",
      exitCode: 137,
      lastPhase: "filled",
    });
  }, 30_000);

  it("memory-honesty fails, not finds, on a timeout, a short file or a gateway error", async () => {
    const outputs = [
      // Timed out: never a finding.
      { ok: false, exitCode: null, stdout: "#phase start 0\n", stderr: "", timedOut: true },
      // A 503 from the provider's gateway with the sandbox still up: no kill evidence.
      { ok: false, exitCode: 1, stdout: "", stderr: "503 Service Unavailable", timedOut: false },
    ];

    for (const fake of outputs) {
      const real = hostBox();

      const box: Box = {
        ...real,
        run: async (command, options) =>
          / mem /.test(command) ? fake : real.run(command, options),
      };

      const open: OpenSession = async () => ({
        kind: "ready",
        session: {
          create: async () => box,
          leftovers: async () => [],
          destroyById: async () => {},
        },
      });

      const { entry } = await runOnHost(memoryHonestyCheck({ memoryMiB: 64, fileMiB: 16 }), open);
      expect(entry.status).toBe("failed");
    }

    // A run that wrote half the file it was asked for.
    const real = hostBox();

    const halved: Box = {
      ...real,
      run: async (command, options) => {
        const result = await real.run(command.replace(/ 16$/, " 8"), options);

        return result;
      },
    };

    const open: OpenSession = async () => ({
      kind: "ready",
      session: {
        create: async () => halved,
        leftovers: async () => [],
        destroyById: async () => {},
      },
    });

    const { entry } = await runOnHost(memoryHonestyCheck({ memoryMiB: 64, fileMiB: 16 }), open);
    expect(entry.status).toBe("failed");
    expect(entry.reason).toMatch(/8 MiB file, asked 64 and 16/);
  }, 60_000);

  it("cleans up a sandbox whose create returned after its deadline", async () => {
    // The framework's deadline is minutes; a check with a short one is not configurable, so a
    // create that resolves only after the attempt has given up is simulated by a failing first
    // create whose sandbox appears in the provider's listing afterwards.
    const late = hostBox({ id: "late-box" });
    let listed = false;
    const destroyed: string[] = [];

    const open: OpenSession = async () => ({
      kind: "ready",
      session: {
        create: async () => {
          listed = true;
          throw new Error("create timed out at the gateway");
        },
        leftovers: async () => (listed && !destroyed.includes(late.id) ? [late.id] : []),
        destroyById: async (id) => {
          destroyed.push(id);
        },
      },
    });

    const { entry } = await runOnHost(securityProbe, open);
    expect(entry.status).toBe("failed");
    expect(destroyed).toEqual(["late-box"]);
    expect(entry.destroyed).toBe(true);
  }, 30_000);

  it("security-probe reads the guest without changing it", async () => {
    const host = hostSession();
    const { entry } = await runOnHost(securityProbe, host.open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = securityProbe.resultSchema.parse(entry.result) satisfies SecurityResult;
    expect(result.uptimeAtFirstCommandS).toBeGreaterThan(0);
    // This machine booted long before the "create".
    expect(result.bootedBeforeCreateS).toBeGreaterThan(0);
    expect(result.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.kernel).toMatch(/Linux/);
    expect(result.cpu.vendor).not.toBeNull();
    expect(result.vulnerabilities.length).toBeGreaterThan(0);
    expect(result.vulnerableCount).not.toBeNull();
  }, 30_000);

  it("cpu-burst-10 runs a solo baseline and an overlapping cohort", async () => {
    const host = hostSession();
    const check = cpuBurstCheck({ cohortSize: 3, cohortSeconds: 1 });
    const { entry } = await runOnHost(check, host.open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result) satisfies BurstResult;
    expect(result.created).toBe(3);
    expect(result.verified).toBe(3);
    expect(result.guaranteedOverlapS).toBeGreaterThan(0);
    expect(result.relativeToSolo).toBeGreaterThan(0);
    expect(result.spread).toBeGreaterThanOrEqual(1);
    // Three "sandboxes" on one machine share its boot ID: what a clone looks like.
    expect(result.distinctBootIds).toBe(1);
    expect(result.boxes.filter((b) => b.solo)).toHaveLength(1);
    expect(result.comparable).toBe(result.notComparableWhy === null);
    expect(entry.sandboxes).toHaveLength(3);
    expect(host.boxes.every((box) => box.destroyed())).toBe(true);
  }, 60_000);

  it("cpu-burst-10 records refused creates and runs with the rest", async () => {
    let made = 0;

    const open: OpenSession = async () => ({
      kind: "ready",
      session: {
        create: async () => {
          made++;

          if (made > 2) throw new Error("Total CPU limit exceeded. Maximum allowed: 10");

          return hostBox();
        },
        leftovers: async () => [],
        destroyById: async () => {},
      },
    });

    const check = cpuBurstCheck({ cohortSize: 4, cohortSeconds: 0.5 });
    const { entry } = await runOnHost(check, open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result);
    expect(result.created).toBe(2);
    expect(result.createErrors).toEqual([
      { error: "Total CPU limit exceeded. Maximum allowed: 10", count: 2 },
    ]);
    expect(entry.createFailures).toHaveLength(2);
  }, 30_000);
});
