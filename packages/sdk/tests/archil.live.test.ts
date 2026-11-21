import { describe, expect, test, vi } from "vitest";
import { Archil } from "disk";
import { createSandbox } from "../src/index.js";
import { archil, type ArchilOptions } from "../src/providers/archil/index.js";
import { runConformance } from "../src/testing.js";

const credentials = Boolean(process.env.ARCHIL_API_KEY);

if (credentials) vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `archil-${Date.now()}`;

// Every live sandbox carries this run's label and pauses after 15 minutes regardless.
function liveProvider(options: ArchilOptions = {}) {
  const provider = archil(options);
  const create = provider.create;
  provider.create = (input) =>
    create({ timeoutMs: 900_000, ...input, labels: { ...input.labels, "live-run": run } });

  return provider;
}

describe.skipIf(!credentials)("Archil live (billable)", () => {
  runConformance(() => liveProvider(), { live: true });
});

describe.skipIf(!credentials)("Archil live options", { timeout: 180_000 }, () => {
  test("size 2 vCPU / 4 GiB shows 2 CPUs and about 4 GiB", async () => {
    const box = await createSandbox(liveProvider(), { size: "medium" });

    try {
      const probe = await box.run("nproc; awk '/MemTotal/{print $2}' /proc/meminfo");
      const [cpus, memoryKb] = probe.stdout.trim().split("\n").map(Number);
      expect(cpus).toBe(2);
      expect(memoryKb).toBeGreaterThan(3.8 * 1024 * 1024);
    } finally {
      await box.destroy();
    }
  });

  test("large stdin, large output and a 10 MiB file all arrive whole", async () => {
    const box = await createSandbox(liveProvider());

    try {
      const input = "x".repeat(3_000_000);
      expect((await box.run("wc -c", { stdin: input })).stdout.trim()).toBe("3000000");

      const big = await box.run("head -c 2000000 /dev/zero | tr '\\0' y", {
        maxOutputBytes: 4_000_000,
      });

      expect(big.stdout.length).toBe(2_000_000);

      const bytes = new Uint8Array(10 * 1024 * 1024).map((_, i) => (i * 31) % 251);
      await box.files.write("big.bin", bytes);
      expect(await box.files.read("big.bin", { as: "bytes" })).toEqual(bytes);
    } finally {
      await box.destroy();
    }
  });

  test("pause and resume keep processes and files", async () => {
    const box = await createSandbox(liveProvider());

    try {
      if (!("pause" in box)) throw new Error("pause capability missing");
      await box.files.write("kept", "yes");
      await box.pause();
      await box.resume();
      expect(await box.files.read("kept")).toBe("yes");
    } finally {
      await box.destroy();
    }
  });

  test("terminal runs a shell", async () => {
    const box = await createSandbox(liveProvider());

    try {
      if (!("terminal" in box)) throw new Error("terminal capability missing");
      const terminal = await box.terminal({ cols: 80, rows: 24 });
      let seen = "";
      terminal.onData((data) => (seen += data));
      await terminal.write("echo term-$((40+2))\nexit\n");
      await expect.poll(() => seen, { timeout: 15_000 }).toContain("term-42");
      await terminal.close();
    } finally {
      await box.destroy();
    }
  });

  // destroy deletes the sandbox, so anything left from this run is a leak.
  test("no sandbox from this run is left", async () => {
    const client = new Archil({
      apiKey: process.env.ARCHIL_API_KEY,
      region: process.env.ARCHIL_REGION ?? "aws-us-east-1",
    });

    const left = async () =>
      (await client.sandboxes.list())
        .filter(
          (box) => box.name.startsWith("sbxsdk-") && !["deleting", "deleted"].includes(box.status),
        )
        .map((box) => box.name);

    await expect.poll(left, { timeout: 30_000, interval: 3000 }).toEqual([]);
  });
});
