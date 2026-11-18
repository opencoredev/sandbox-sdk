import { describe, expect, test, vi } from "vitest";
import { createSandbox } from "../src/index.js";
import { instabox, type InstaboxOptions } from "../src/providers/instabox/index.js";
import { runConformance } from "../src/testing.js";

const credentials = Boolean(process.env.INSTABOX_API_KEY);

if (credentials) vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `instabox-${Date.now()}`;

// Every live machine carries this run's label, and Instabox deletes it after 15 minutes regardless.
function liveProvider(options: InstaboxOptions = {}) {
  const provider = instabox(options);
  const create = provider.create;
  provider.create = (input) =>
    create({ timeoutMs: 900_000, ...input, labels: { ...input.labels, "live-run": run } });

  return provider;
}

describe.skipIf(!credentials)("Instabox live (billable)", () => {
  runConformance(() => liveProvider(), { live: true, snapshotExpiry: "refused" });
});

describe.skipIf(!credentials)("Instabox live options", { timeout: 240_000 }, () => {
  test("size small is 2 vCPU and about 4 GiB", async () => {
    const box = await createSandbox(liveProvider(), { size: "small" });

    try {
      const probe = await box.run("nproc; awk '/MemTotal/{print $2}' /proc/meminfo");
      const [cpus, memoryKb] = probe.stdout.trim().split("\n").map(Number);
      expect(cpus).toBe(2);
      expect(memoryKb).toBeGreaterThan(3.7 * 1024 * 1024);
    } finally {
      await box.destroy();
    }
  });

  test("a stdin over the 1 MiB inline limit and a large output both arrive whole", async () => {
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

  // destroy deletes the machine, so anything still listed here is a leak.
  test("no machine from this run is left", async () => {
    const live = async () => (await liveProvider().list({ "live-run": run })).map((m) => m.id);

    await expect.poll(live, { timeout: 30_000, interval: 3000 }).toEqual([]);
  });
});
