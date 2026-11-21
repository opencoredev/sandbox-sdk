import { describe, expect, test, vi } from "vitest";
import { connectSandbox, createSandbox } from "../src/index.js";
import { groundbox, type GroundboxOptions } from "../src/providers/groundbox/index.js";
import { runConformance } from "../src/testing.js";

const credentials = Boolean(process.env.GROUNDBOX_API_KEY);

if (credentials) vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `groundbox-${Date.now()}`;

// Every live sandbox carries this run's label, and Groundbox deletes it after 15 minutes regardless.
function liveProvider(options: GroundboxOptions = {}) {
  const provider = groundbox(options);
  const create = provider.create;
  provider.create = (input) =>
    create({ timeoutMs: 900_000, ...input, labels: { ...input.labels, "live-run": run } });

  return provider;
}

describe.skipIf(!credentials)("Groundbox live (billable)", () => {
  runConformance(() => liveProvider(), { live: true, snapshotExpiry: "refused" });
});

describe.skipIf(!credentials)("Groundbox live options", { timeout: 240_000 }, () => {
  test("size medium is 4 vCPU and about 8 GiB", async () => {
    const box = await createSandbox(liveProvider(), { size: "medium" });

    try {
      const probe = await box.run("nproc; awk '/MemTotal/{print $2}' /proc/meminfo");
      const [cpus, memoryKb] = probe.stdout.trim().split("\n").map(Number);
      expect(cpus).toBe(4);
      expect(memoryKb).toBeGreaterThan(7.5 * 1024 * 1024);
    } finally {
      await box.destroy();
    }
  });

  test("a stdin over the 512 KiB inline limit and a large output both arrive whole", async () => {
    const box = await createSandbox(liveProvider());

    try {
      const input = "x".repeat(1_500_000);
      expect((await box.run("wc -c", { stdin: input })).stdout.trim()).toBe("1500000");

      const big = await box.run("head -c 2000000 /dev/zero | tr '\\0' y", {
        maxOutputBytes: 4_000_000,
      });

      expect(big.stdout.length).toBe(2_000_000);
    } finally {
      await box.destroy();
    }
  });

  test("network none reaches nothing; a terminal runs in /workspace; fork copies files", async () => {
    const box = await createSandbox(liveProvider(), { network: "none" });

    try {
      const probe = await box.run("curl -sS -m 5 -o /dev/null https://github.com && echo reached");
      expect(probe.stdout).not.toContain("reached");

      // Groundbox declares every capability, so the handle types its optional methods as possibly missing.
      const terminal = await box.terminal!({ cols: 80, rows: 24 });
      let seen = "";
      terminal.onData((data) => (seen += data));
      await terminal.write("pwd; exit\n");
      expect((await terminal.wait!()).exitCode).toBe(0);
      expect(seen).toContain("/workspace");

      await box.files.write("kept.txt", "before the fork");
      const { id } = await box.ext.groundbox.fork();
      const copy = await connectSandbox(liveProvider(), id);

      try {
        expect(await copy.files.read("kept.txt")).toBe("before the fork");
      } finally {
        await copy.destroy();
      }
    } finally {
      await box.destroy();
    }
  });

  // destroy deletes the sandbox, so anything still listed here is a leak.
  test("no sandbox from this run is left", async () => {
    const live = async () => (await liveProvider().list({ "live-run": run })).map((s) => s.id);

    await expect.poll(live, { timeout: 30_000, interval: 3000 }).toEqual([]);
  });
});
