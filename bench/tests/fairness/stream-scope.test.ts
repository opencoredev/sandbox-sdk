/**
 * The continuous burn's start, poll and stop commands on this machine with the real binary: each
 * attempt sees and stops only its own processes, with or without setsid.
 */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  streamPollCommand,
  streamStartCommand,
  streamStopCommand,
  type StreamAttempt,
} from "../../src/fairness/cpu-native.js";
import { nativeBytes } from "../../src/fairness/native.js";
import { hostBox } from "./host-box.js";

const supported = platform() === "linux" && arch() === "x64";
const options = { timeoutMs: 30_000, signal: new AbortController().signal };
const longPhase = { segments: 60, seconds: 1, workers: 2 };

async function installedBinary() {
  const dir = await mkdtemp(join(tmpdir(), "sbx-stream-"));
  const path = join(dir, ".sbx-native");
  await writeFile(path, nativeBytes("x86_64"));
  await chmod(path, 0o755);

  return path;
}

/** PIDs whose stdout is the attempt's output file, deleted or not. */
async function processesOf(tag: string) {
  const out = `/tmp/.sbx-cpu-stream-${tag}.out`;
  const pids: string[] = [];

  for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    const target = await readlink(`/proc/${pid}/fd/1`).catch(() => "");

    if (target.startsWith(out)) pids.push(pid);
  }

  return pids;
}

/** Another run's burn: the same binary and mode, not started through these commands. */
function decoy(path: string) {
  const child = spawn(path, ["cpu-stream", "7", "1", "1000", "60", "4194304"], {
    stdio: "ignore",
  });

  return {
    alive: () => child.exitCode === null && child.signalCode === null,
    kill: () => child.kill("SIGKILL"),
  };
}

const settle = () => new Promise((done) => setTimeout(done, 300));

describe.runIf(supported)("continuous burn scoping", () => {
  it("stops only its own attempt", async () => {
    const path = await installedBinary();
    const box = hostBox();
    const other = decoy(path);

    const a: StreamAttempt = { path, seed: 11, phase: longPhase, tag: "test-a" };
    const b: StreamAttempt = { path, seed: 11, phase: longPhase, tag: "test-b" };

    try {
      expect((await box.run(streamStartCommand(a), options)).stdout).toMatch(/^\d+$/m);
      expect((await box.run(streamStartCommand(b), options)).stdout).toMatch(/^\d+$/m);
      await settle();
      expect(await processesOf("test-a")).toHaveLength(3);
      expect((await box.run(streamPollCommand("test-a"), options)).stdout).toMatch(/^alive=1$/m);

      expect((await box.run(streamStopCommand("test-a"), options)).stdout).toMatch(/^stopped=1$/m);
      expect(await processesOf("test-a")).toEqual([]);
      expect((await box.run(streamPollCommand("test-a"), options)).stdout).toMatch(/^alive=0$/m);
      expect((await box.run(streamPollCommand("test-b"), options)).stdout).toMatch(/^alive=1$/m);
      expect(await processesOf("test-b")).toHaveLength(3);
      expect(other.alive()).toBe(true);

      expect((await box.run(streamStopCommand("test-b"), options)).stdout).toMatch(/^stopped=1$/m);
      expect(await processesOf("test-b")).toEqual([]);
      expect(other.alive()).toBe(true);
    } finally {
      other.kill();
      await box.run(streamStopCommand("test-a"), options);
      await box.run(streamStopCommand("test-b"), options);
    }
  }, 30_000);

  it("stops its burn without setsid and keeps the rest", async () => {
    const path = await installedBinary();
    const bin = await mkdtemp(join(tmpdir(), "sbx-no-setsid-"));

    for (const tool of ["bash", "cat", "nohup", "rm", "sleep"])
      await symlink(`/usr/bin/${tool}`, join(bin, tool));
    const box = hostBox({ env: { PATH: bin } });
    const other = decoy(path);
    const attempt: StreamAttempt = { path, seed: 5, phase: longPhase, tag: "test-plain" };

    try {
      expect((await box.run(streamStartCommand(attempt), options)).stdout).toMatch(/^\d+$/m);
      await settle();
      expect(await processesOf("test-plain")).toHaveLength(3);
      expect((await box.run(streamPollCommand("test-plain"), options)).stdout).toMatch(
        /^alive=1$/m,
      );
      expect((await box.run(streamStopCommand("test-plain"), options)).stdout).toMatch(
        /^stopped=1$/m,
      );
      expect(await processesOf("test-plain")).toEqual([]);
      expect(other.alive()).toBe(true);
    } finally {
      other.kill();
      await hostBox().run(streamStopCommand("test-plain"), options);
    }
  }, 30_000);

  it("does not take a reused PID for its burn", async () => {
    const path = await installedBinary();
    const box = hostBox();
    const other = decoy(path);

    try {
      await settle();
      const pid = (await box.run("pgrep -n -x .sbx-native", options)).stdout.trim();
      expect(pid).toMatch(/^\d+$/);
      await writeFile("/tmp/.sbx-cpu-stream-test-reused.pid", `${pid}\n`);
      expect((await box.run(streamPollCommand("test-reused"), options)).stdout).toMatch(
        /^alive=0$/m,
      );
      expect((await box.run(streamStopCommand("test-reused"), options)).stdout).toMatch(
        /^stopped=1$/m,
      );
      expect(other.alive()).toBe(true);
    } finally {
      other.kill();
    }
  }, 30_000);
});
