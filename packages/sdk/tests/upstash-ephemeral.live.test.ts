import { describe, expect, test, vi } from "vitest";
import { upstash } from "../src/providers/upstash/index.js";
import { createSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Short TTL: a crashed run leaves boxes Upstash reaps on its own.
const ephemeral = () => upstash({ ephemeral: true, ttlSeconds: 900 });
const create = (input: Parameters<typeof createSandbox>[1]) => createSandbox(ephemeral(), input);

describe.skipIf(!process.env.UPSTASH_BOX_API_KEY)("Upstash Ephemeral Box live", () => {
  runConformance(ephemeral, { live: true });
  test("medium is 4 vCPU and 8 GiB, cannot pause, and clones keep size and discovery", async () => {
    const { Box } = await import("@upstash/box");
    const quota = "cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max";
    let source: Awaited<ReturnType<typeof create>> | undefined;
    let restored: Awaited<ReturnType<typeof create>> | undefined;
    let snapshotId: string | undefined;
    const key = `ephemeral-live-${crypto.randomUUID()}`;

    try {
      source = await create({ size: "medium", env: { PROBE: "ok" } });
      expect(source.native.size).toBe("medium");
      await expect(source.native.pause()).rejects.toThrow();
      const before = await source.run(`${quota}; printf %s "$PROBE"`);
      // nproc exposes the host CPU count; the cgroup quota is authoritative.
      expect(before.stdout.trim().split("\n")).toEqual([
        "400000 100000",
        String(8 * 1024 ** 3),
        "ok",
      ]);
      snapshotId = (await source.snapshot()).id;
      await source.destroy();
      source = undefined;
      restored = await create({ from: snapshotId, key });
      expect((await restored.run(quota)).stdout.trim().split("\n")).toEqual([
        "400000 100000",
        String(8 * 1024 ** 3),
      ]);
      expect(await ephemeral().find(key)).toMatchObject({ id: restored.id });
    } finally {
      try {
        await restored?.destroy();
      } finally {
        try {
          await source?.destroy();
        } finally {
          if (snapshotId) await Box.deleteSnapshots({ snapshotIds: [snapshotId] });
        }
      }
    }
  });
});
