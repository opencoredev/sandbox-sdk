// Billable checks against Microsandbox Cloud. Opt in with SANDBOX_MICROSANDBOX_LIVE=1 and MSB_API_KEY;
// MSB_COMPUTE_TYPE picks the tier (default standard). Every sandbox carries this run's label and a
// 15-minute lifetime, and the run checks at the end that it left no sandbox, Service or snapshot behind.
import { describe, expect, test, vi } from "vitest";
import { createSandbox, deleteSnapshot } from "../src/index.js";
import { microsandbox, type MicrosandboxOptions } from "../src/providers/microsandbox/index.js";
import { runConformance } from "../src/testing.js";

const live = process.env.SANDBOX_MICROSANDBOX_LIVE === "1" && Boolean(process.env.MSB_API_KEY);

if (live) vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `microsandbox-${Date.now()}`;
const computeType = process.env.MSB_COMPUTE_TYPE === "shared" ? "shared" : "standard";

/** Snapshot IDs this run made, checked gone at the end. */
const snapshots = new Set<string>();

function liveProvider(options: MicrosandboxOptions = {}) {
  const provider = microsandbox({ computeType, ...options });
  const create = provider.create;
  const snapshot = provider.snapshot;

  if (!snapshot) throw new Error("the Microsandbox adapter has snapshots");

  provider.create = (input) =>
    create({ timeoutMs: 900_000, ...input, labels: { ...input.labels, "live-run": run } });

  provider.snapshot = async (id, snapshotOptions) => {
    const made = await snapshot(id, snapshotOptions);

    snapshots.add(made.id);

    return made;
  };

  return provider;
}

describe.skipIf(!live)("Microsandbox live (billable)", () => {
  runConformance(() => liveProvider(), {
    live: true,
    snapshotExpiry: "refused",
    timeoutMs: 600_000,
  });
});

describe.skipIf(!live)("Microsandbox live options", { timeout: 900_000 }, () => {
  test("the tier, an exact size and /workspace are what was asked", async () => {
    const provider = liveProvider();
    const box = await createSandbox(provider, { size: { cpu: 2, memoryMb: 4096, diskGb: 16 } });

    try {
      const probe = await box.run(
        "nproc; awk '/MemTotal/{print $2}' /proc/meminfo; df -BG --output=size / | tail -1; pwd",
      );

      const [cpus, memoryKb, disk, cwd] = probe.stdout.trim().split("\n");

      expect(Number(cpus)).toBe(2);
      expect(Number(memoryKb)).toBeGreaterThan(3.5 * 1024 * 1024);
      expect(Number(disk?.trim().replace("G", ""))).toBeGreaterThanOrEqual(15);
      expect(cwd).toBe("/workspace");
      expect((await provider.list({ "live-run": run })).some((s) => s.id === box.id)).toBe(true);
    } finally {
      await box.destroy();
    }
  });

  test("a timeout kills the whole process group, background children included", async () => {
    const box = await createSandbox(liveProvider());

    try {
      const result = await box.run("(sleep 5; touch /workspace/late) & sleep 120", {
        timeoutMs: 2000,
      });

      expect(result.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 7000));
      expect((await box.run("test -e /workspace/late && echo yes || echo no")).stdout).toBe("no\n");
    } finally {
      await box.destroy();
    }
  });

  test("a snapshot stops and restarts its source, restores, and deletes", async () => {
    const provider = liveProvider();
    const box = await createSandbox(provider);

    try {
      await box.files.write("marker.txt", "kept");
      const { id } = await box.snapshot();

      expect((await box.run("cat marker.txt")).stdout).toBe("kept");

      const restored = await createSandbox(provider, {
        from: id,
        size: { cpu: 1, memoryMb: 1024 },
      });

      try {
        expect((await restored.run("cat /workspace/marker.txt")).stdout).toBe("kept");
      } finally {
        await restored.destroy();
      }

      expect(await deleteSnapshot(provider, id)).toBe(true);
      snapshots.delete(id);
    } finally {
      await box.destroy();
    }
  });

  test("a preview is a Service the adapter deletes with the sandbox", async () => {
    const provider = liveProvider();
    const box = await createSandbox(provider);
    let slug = "";

    try {
      const { url } = await box.preview(3000);

      slug = new URL(url).hostname.split(".")[0] ?? "";
      expect(slug).toMatch(/^sbx-[0-9a-f]{16}-p3000$/);
      expect((await provider.api.request("GET", `/services/${slug}`)) ?? {}).toMatchObject({
        status: "enabled",
      });
    } finally {
      await box.destroy();
    }

    await expect(provider.api.request("GET", `/services/${slug}`)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("the run left nothing behind", async () => {
    const provider = liveProvider();

    expect(await provider.list({ "live-run": run })).toEqual([]);

    for (const id of snapshots) expect(await deleteSnapshot(provider, id)).toBe(false);
  });
});
