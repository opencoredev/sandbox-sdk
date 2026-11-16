import { describe, expect, test, vi } from "vitest";
import { SandboxClient } from "@basetenlabs/sandbox";
import { createSandbox } from "../src/index.js";
import { baseten } from "../src/providers/baseten/index.js";

const credentials = Boolean(process.env.BASETEN_API_KEY);

if (credentials) vi.setConfig({ testTimeout: 120_000 });

// Baseten keeps a preview, and its quota slot, after its sandbox is deleted.
describe.skipIf(!credentials)("Baseten live lifecycle (billable)", () => {
  test("destroy removes a preview another client made", async () => {
    const creator = baseten();
    const { id } = await creator.create({ labels: { "sandbox-sdk": "1" }, timeoutMs: 600_000 });
    const client = new SandboxClient({ apiKey: process.env.BASETEN_API_KEY ?? "" });
    let previews: Awaited<ReturnType<SandboxClient["get"]>>["previews"] | undefined;

    try {
      // Taken before destroy, so the check below never depends on the sandbox record surviving.
      previews = (await client.get({ name: id })).previews;

      const other = baseten();
      await other.connect(id);
      await other.previewUrl(id, 3000);

      const before: string[] = [];

      for await (const preview of previews.list()) before.push(preview.name);
      expect(before).toHaveLength(1);
    } finally {
      await creator.destroy(id);
    }

    const left: string[] = [];

    if (!previews) throw new Error("Preview handle was never taken");

    for await (const preview of previews.list())
      if (!["DELETING", "TERMINATED"].includes(preview.status)) left.push(preview.name);

    expect(left).toEqual([]);
  });

  test("4 vCPU / 8 GiB shows 4 CPUs; 8 vCPU / 16 GiB is refused, since Baseten gives 6", async () => {
    const box = await createSandbox(baseten(), {
      size: { cpu: 4, memoryMb: 8192 },
      timeoutMs: 600_000,
    });

    try {
      const probe = await box.run("nproc; awk '/MemTotal/{print $2}' /proc/meminfo");
      const [cpus, memoryKb] = probe.stdout.trim().split("\n").map(Number);
      expect(cpus).toBe(4);
      expect(memoryKb).toBeGreaterThan(7.5 * 1024 * 1024);
    } finally {
      await box.destroy();
    }

    await expect(
      createSandbox(baseten(), { size: { cpu: 8, memoryMb: 16384 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});
