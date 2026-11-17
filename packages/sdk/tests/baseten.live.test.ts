import { describe, expect, test, vi } from "vitest";
import { SandboxClient } from "@basetenlabs/sandbox";
import { createSandbox } from "../src/index.js";
import { baseten, type BasetenOptions } from "../src/providers/baseten/index.js";
import { runConformance } from "../src/testing.js";

const credentials = Boolean(process.env.BASETEN_API_KEY);

if (credentials) vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `baseten-${Date.now()}`;

// Every live sandbox carries this run's label, and Baseten deletes it after 15 minutes regardless.
function liveProvider(options: BasetenOptions = {}) {
  const provider = baseten(options);
  const create = provider.create;
  provider.create = (input) =>
    create({ timeoutMs: 900_000, ...input, labels: { ...input.labels, "live-run": run } });

  return provider;
}

describe.skipIf(!credentials)("Baseten live (billable)", () => {
  runConformance(() => liveProvider(), { live: true });
});

describe.skipIf(!credentials)("Baseten live options", { timeout: 180_000 }, () => {
  // The account caps one sandbox at 4096 MB (2 vCPU), so check the size mapping one step down.
  test("size 1 vCPU / 2 GiB shows 1 CPU and about 2 GiB", async () => {
    const box = await createSandbox(liveProvider(), { size: { cpu: 1, memoryMb: 2048 } });

    try {
      const probe = await box.run("nproc; awk '/MemTotal/{print $2}' /proc/meminfo");
      const [cpus, memoryKb] = probe.stdout.trim().split("\n").map(Number);
      expect(cpus).toBe(1);
      expect(memoryKb).toBeGreaterThan(1.9 * 1024 * 1024);
    } finally {
      await box.destroy();
    }
  });

  test("a large stdin and a large output both arrive whole", async () => {
    const box = await createSandbox(liveProvider());

    try {
      const input = "x".repeat(300_000);
      expect((await box.run("wc -c", { stdin: input })).stdout.trim()).toBe("300000");

      const big = await box.run("head -c 2000000 /dev/zero | tr '\\0' y", {
        maxOutputBytes: 4_000_000,
      });

      expect(big.stdout.length).toBe(2_000_000);
    } finally {
      await box.destroy();
    }
  });

  // destroy deletes the sandbox, so anything still live here is a leak.
  test("no sandbox from this run is left running", async () => {
    const client = new SandboxClient({ apiKey: process.env.BASETEN_API_KEY ?? "" });

    const live = async () => {
      const left: string[] = [];

      for await (const box of client.list({}))
        if (box.labels["live-run"] === run && !["DELETING", "TERMINATED"].includes(box.status))
          left.push(box.name);

      return left;
    };

    await expect.poll(live, { timeout: 30_000, interval: 3000 }).toEqual([]);
  });
});
