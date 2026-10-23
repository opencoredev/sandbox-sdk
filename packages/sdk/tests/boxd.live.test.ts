import { describe, expect, test } from "vitest";
import { boxd } from "../src/providers/boxd/index.js";
import { createSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";
function liveProvider(options: Parameters<typeof boxd>[0] = {}) {
  const provider = boxd(options);
  const create = provider.create;
  provider.create = (input) => create({ ...input, labels: { ...input.labels, "live-run": process.env.SANDBOX_TEST_RUN_ID ?? "boxd-conformance" } });
  return provider;
}
describe.skipIf(process.env.SANDBOX_BOXD_LIVE !== "1" || !process.env.BOXD_API_KEY)(
  "boxd live",
  () => {
    runConformance(() => liveProvider(), { live: true });
    test("coupled sizes and snapshot restore preserve captured files", async () => {
      const provider = liveProvider({ requestTimeoutMs: 120000 });
      await expect(provider.create({ labels: {}, size: { cpu: 4, memoryMb: 8192, diskGb: 100 } })).rejects.toMatchObject({ code: "unsupported" });
      const source = await createSandbox(provider, { size: { cpu: 4, memoryMb: 16384, diskGb: 100 } });
      const native = source.native.client;
      let snapshotId: string | undefined;
      let restored: typeof source | undefined;
      try {
        expect(source.native.machine.resources).toMatchObject({ vcpu: 4, memoryBytes: 16 * 1024 ** 3 });
        expect((await source.run("getconf _NPROCESSORS_ONLN")).stdout.trim()).toBe("4");
        await source.files.write("captured", "original bytes");
        const saved = await source.snapshot();
        snapshotId = saved.id;
        await source.files.write("captured", "changed after capture");
        restored = await createSandbox(provider, { from: saved.id, labels: { restored: "yes" } });
        expect(await restored.files.read("captured")).toBe("original bytes");
        expect((await restored.run("printf restored")).stdout).toBe("restored");
        expect(restored.native.machine.resources).toMatchObject({ vcpu: 4, memoryBytes: 16 * 1024 ** 3 });
        expect(await provider.connect(restored.id)).toMatchObject({ labels: { restored: "yes" } });
      } finally {
        try { if (restored) await restored.destroy(); }
        finally {
          try { if (snapshotId) await native.snapshots.delete(snapshotId); }
          finally { await source.destroy(); }
        }
      }
      expect((await native.machines.list()).filter(m => m.id === source.id || m.id === restored?.id)).toEqual([]);
      expect((await native.snapshots.list()).filter(s => s.name === snapshotId)).toEqual([]);
    }, 180000);
  },
);
