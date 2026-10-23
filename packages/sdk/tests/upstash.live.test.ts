import { describe, expect, test, vi } from "vitest";
import { upstash } from "../src/providers/upstash/index.js";
import { createSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
describe.skipIf(!process.env.UPSTASH_BOX_API_KEY)("Upstash Box live", () => {
  runConformance(() => {
    const provider = upstash();
    const create = provider.create;
    provider.create = input => create({ ...input, labels: { ...input.labels, "sbx57-create-a-live": "1" } });
    return provider;
  }, { live: true });
  test("medium snapshots retain 4 vCPU and 8 GiB after source deletion", async () => {
    const { Box } = await import("@upstash/box");
    const medium = () => createSandbox(upstash(), { size: "medium" });
    let source: Awaited<ReturnType<typeof medium>> | undefined;
    let restored: Awaited<ReturnType<typeof medium>> | undefined;
    let snapshotId: string | undefined;
    try {
      source = await medium();
      snapshotId = (await source.snapshot()).id;
      await source.destroy();
      source = undefined;
      // A fresh adapter with no size option must recover the snapshot's size.
      restored = await createSandbox(upstash(), { from: snapshotId });
      const result = await restored.run("nproc; cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max");
      expect(result.ok).toBe(true);
      const [processors, cpu, memory] = result.stdout.trim().split("\n");
      // nproc exposes the host CPU count; the cgroup quota is authoritative.
      expect(Number(processors)).toBeGreaterThanOrEqual(4);
      expect(cpu).toBe("400000 100000");
      expect(Number(memory)).toBe(8 * 1024 ** 3);
    } finally {
      try { await restored?.destroy(); }
      finally {
        try { await source?.destroy(); }
        finally { if (snapshotId) await Box.deleteSnapshots({ snapshotIds: [snapshotId] }); }
      }
    }
  });
});
