import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createSandbox } from "../src/index.js";
import { beam, type BeamOptions } from "../src/providers/beam/index.js";
import { runConformance } from "../src/testing.js";

const credentials = Boolean(process.env.BEAM_TOKEN && process.env.BEAM_WORKSPACE_ID);

if (credentials) vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `beam-${Date.now()}`;

// Every live sandbox carries this run's label, and Beam stops it after 15 minutes regardless.
function liveProvider(options: BeamOptions = {}) {
  const provider = beam(options);
  const create = provider.create;

  provider.create = (input) =>
    create({ timeoutMs: 900_000, ...input, labels: { ...input.labels, "live-run": run } });

  return provider;
}

describe.skipIf(!credentials)("Beam live (billable)", () => {
  runConformance(() => liveProvider(), { live: true });
});

describe.skipIf(!credentials)("Beam live options", { timeout: 180_000 }, () => {
  test("size 2 vCPU / 4 GiB shows 2 CPUs and a 4 GiB memory limit", async () => {
    const box = await createSandbox(liveProvider(), { size: { cpu: 2, memoryMb: 4096 } });

    try {
      const probe = await box.run(
        "nproc; cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes",
      );

      const [cpus, memory] = probe.stdout.trim().split("\n").map(Number);

      expect(cpus).toBe(2);
      expect(memory).toBe(4096 * 1024 * 1024);
    } finally {
      await box.destroy();
    }
  });

  test("a large stdin and a large output both arrive whole", async () => {
    const box = await createSandbox(liveProvider());

    try {
      const input = "x".repeat(300_000);

      expect((await box.run("wc -c", { stdin: input })).stdout.trim()).toBe("300000");

      // Over the gateway's upload limit once hex-encoded: the staged input goes up in pieces.
      const huge = "y".repeat(6 * 1024 * 1024);

      expect((await box.run("wc -c", { stdin: huge })).stdout.trim()).toBe(String(huge.length));

      const big = await box.run("head -c 2000000 /dev/zero | tr '\\0' y", {
        maxOutputBytes: 4_000_000,
      });

      expect(big.stdout.length).toBe(2_000_000);
    } finally {
      await box.destroy();
    }
  });

  // Beam's gateway refuses a body of about 10 MB, so files that size move in pieces.
  test("a 10 MiB file goes up and comes back whole", async () => {
    const box = await createSandbox(liveProvider(), { size: { cpu: 1, memoryMb: 2048 } });

    try {
      const bytes = new Uint8Array(10 * 1024 * 1024).map((_, i) => (i * 31) % 251);

      await box.files.write("/workspace/big.bin", bytes);
      expect((await box.run("sha256sum /workspace/big.bin")).stdout.split(" ")[0]).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(
        Buffer.from(await box.files.read("/workspace/big.bin", { as: "bytes" })).equals(
          Buffer.from(bytes),
        ),
      ).toBe(true);
    } finally {
      await box.destroy();
    }
  });

  // destroy stops the sandbox, so anything from this run still listed is a leak.
  test("no sandbox from this run is left running", async () => {
    const live = async () => (await beam().list({ "live-run": run })).map((info) => info.id);

    await expect.poll(live, { timeout: 30_000, interval: 3000 }).toEqual([]);
  });
});
