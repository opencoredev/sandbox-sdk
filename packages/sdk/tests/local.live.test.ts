import { describe, test, expect } from "vitest";
import { runConformance } from "../src/testing.js";
import { createSandbox, listSandboxes } from "../src/index.js";
import { local } from "../src/providers/local/index.js";

if (process.env.SANDBOX_LOCAL_LIVE === "1") {
  runConformance(
    () => {
      const provider = local();
      const create = provider.create;
      provider.create = (input) =>
        create({ ...input, labels: { ...input.labels, sbx57: "adapters-c-conformance" } });

      return provider;
    },
    { live: true },
  );
  describe("Docker enforcement", () => {
    test("size, isolation, exact keys across clients, pause and snapshot restore", async () => {
      const provider = local();
      const key = `sbx57-${crypto.randomUUID()}`;
      const boxes: string[] = [];
      let snapshot: string | undefined;

      try {
        const first = await createSandbox(provider, {
          key,
          size: "small",
          network: "none",
          labels: { verification: "sbx57" },
        });

        boxes.push(first.id);
        const second = await createSandbox(local(), { key });
        expect(second.id).toBe(first.id);
        expect(second.created).toBe(false);
        const inspect = await first.native.client.call("GET", `/containers/${first.id}/json`);
        expect(inspect).toMatchObject({
          HostConfig: { NanoCpus: 1e9, Memory: 1073741824, NetworkMode: "none" },
        });
        expect((await first.run("ls /sys/class/net")).stdout.trim()).toBe("lo");

        for (const mode of ["abort", "timeout"]) {
          const controller = new AbortController();
          let output = "";
          expect(
            await provider.exec(first.id, {
              command: `echo STARTED; (sleep 2; touch /tmp/${mode}-survivor) & wait`,
              cwd: "/workspace",
              env: {},
              timeoutMs: mode === "timeout" ? 500 : 5000,
              signal: controller.signal,
              onChunk(chunk) {
                output += chunk.text;

                if (mode === "abort" && output.includes("STARTED")) controller.abort();
              },
            }),
          ).toMatchObject({ timedOut: true, exitCode: null });
          expect(output).toContain("STARTED");
        }

        await new Promise((resolve) => setTimeout(resolve, 2200));
        expect(await first.files.exists("/tmp/abort-survivor")).toBe(false);
        expect(await first.files.exists("/tmp/timeout-survivor")).toBe(false);
        await first.files.write("preserved", "snapshot");
        await first.pause();
        expect((await provider.connect(first.id)).state).toBe("paused");
        await first.resume();
        snapshot = (await first.snapshot()).id;
        const restored = await createSandbox(provider, { from: snapshot });
        boxes.push(restored.id);
        expect(await restored.files.read("preserved")).toBe("snapshot");
        expect(restored.key).toBeUndefined();
      } finally {
        for (const id of boxes) await provider.destroy(id);

        if (snapshot)
          await new (
            await import("../src/providers/local/docker.js")
          ).Docker().call("DELETE", `/images/${encodeURIComponent(snapshot)}`);
      }
    }, 120_000);
  });
} else {
  test.skip("Docker live suite requires SANDBOX_LOCAL_LIVE=1", () => {});
}

if (process.env.SANDBOX_LOCAL_LIVE === "1") {
  test("local lifecycle labels survive fresh clients and reap expired idle boxes", async () => {
    const { connectSandbox, reapSandboxes } = await import("../src/index.js");
    const labels = { "review-lifecycle": crypto.randomUUID(), sbx57: "adapters-c-lifecycle" };
    const provider = local();
    const ids: string[] = [];

    try {
      const lifetime = await createSandbox(provider, {
        labels,
        timeoutMs: 60_000,
        idleTimeoutMs: 120_000,
      });

      ids.push(lifetime.id);
      // The deadline is adapter bookkeeping, kept out of the labels callers see.
      expect(lifetime.labels).toEqual({ ...labels, "sandbox-sdk": "1" });
      const deadline = (await lifetime.usage()).createdAt + 60_000;
      expect((await lifetime.run("true")).ok).toBe(true);
      await lifetime.close();
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now() + 50)));
      await expect(connectSandbox(local(), lifetime.id)).rejects.toMatchObject({
        code: "not_found",
      });

      const idle = await createSandbox(provider, {
        labels,
        timeoutMs: 120_000,
        idleTimeoutMs: 10_000,
      });

      ids.push(idle.id);
      const connected = await connectSandbox(local(), idle.id);
      expect(connected.id).toBe(idle.id);
      await connected.close();
      await idle.close();
      await new Promise((resolve) => setTimeout(resolve, 10_100));
      expect(await reapSandboxes(local(), { labels, idleOnly: true })).toBe(1);
      await expect(connectSandbox(local(), idle.id)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      for (const id of ids) await provider.destroy(id);
    }
  }, 120_000);
  describe("SBX-71 runtime behavior", () => {
    test("labels hide adapter bookkeeping; a missing cwd fails as a shell error on stderr", async () => {
      const provider = local();
      const ids: string[] = [];

      try {
        const box = await createSandbox(provider, {
          labels: { verification: "sbx71" },
          timeoutMs: 600_000,
          idleTimeoutMs: 600_000,
        });

        ids.push(box.id);
        expect(box.labels).toEqual({ verification: "sbx71", "sandbox-sdk": "1" });
        const [listed] = await listSandboxes(local(), { labels: { verification: "sbx71" } });
        expect(listed?.labels).toEqual({ verification: "sbx71", "sandbox-sdk": "1" });
        const result = await box.run("pwd", { cwd: "nope" });
        expect(result).toMatchObject({
          ok: false,
          stdout: "",
          stderr: expect.stringMatching(/cd.*\/workspace\/nope/),
        });
        expect(result.exitCode).not.toBe(127);
        const process = await box.start("sleep 30", { name: "bad-cwd", cwd: "nope" });
        expect(process.status).toBe("failed");
        expect((await process.logs()).text).toMatch(/cd.*nope/);
      } finally {
        for (const id of ids) await provider.destroy(id);
      }
    }, 120_000);
  });
}
