import { describe, test, expect } from "vitest";
import { runConformance } from "../src/testing.js";
import { createSandbox } from "../src/index.js";
import { local } from "../src/providers/local/index.js";

if (process.env.SANDBOX_LOCAL_LIVE === "1") {
  runConformance(() => local(), { live: true });
  describe("Docker enforcement", () => {
    test("size, isolation, exact keys across clients, pause and snapshot restore", async () => {
      const provider = local(); const key = `sbx25-${crypto.randomUUID()}`;
      const boxes: string[] = []; let snapshot: string | undefined;
      try {
        const first = await createSandbox(provider, { key, size: "small", network: "none", labels: { verification: "sbx25" } }); boxes.push(first.id);
        const second = await createSandbox(local(), { key }); expect(second.id).toBe(first.id); expect(second.created).toBe(false);
        const inspect = await first.native.client.call("GET", `/containers/${first.id}/json`);
        expect(inspect).toMatchObject({ HostConfig: { NanoCpus: 1e9, Memory: 1073741824, NetworkMode: "none" } });
        expect((await first.run("ls /sys/class/net")).stdout.trim()).toBe("lo");
        for (const mode of ["abort", "timeout"]) {
          const controller = new AbortController(); let output = "";
          expect(await provider.exec(first.id, {
            command: `echo STARTED; (sleep 2; touch /tmp/${mode}-survivor) & wait`,
            cwd: "/workspace", env: {}, timeoutMs: mode === "timeout" ? 500 : 5000,
            signal: controller.signal,
            onChunk(chunk) { output += chunk.text; if (mode === "abort" && output.includes("STARTED")) controller.abort(); },
          })).toMatchObject({ timedOut: true, exitCode: null });
          expect(output).toContain("STARTED");
        }
        await new Promise(resolve => setTimeout(resolve, 2200));
        expect(await first.files.exists("/tmp/abort-survivor")).toBe(false);
        expect(await first.files.exists("/tmp/timeout-survivor")).toBe(false);
        await first.files.write("preserved", "snapshot");
        await first.pause(); expect((await provider.connect(first.id)).state).toBe("paused"); await first.resume();
        snapshot = (await first.snapshot()).id;
        const restored = await createSandbox(provider, { from: snapshot }); boxes.push(restored.id);
        expect(await restored.files.read("preserved")).toBe("snapshot"); expect(restored.key).toBeUndefined();
      } finally {
        for (const id of boxes) await provider.destroy(id);
        if (snapshot) await new (await import("../src/providers/local/docker.js")).Docker().call("DELETE", `/images/${encodeURIComponent(snapshot)}`);
      }
    }, 120_000);
  });
}

else { test.skip("Docker live suite requires SANDBOX_LOCAL_LIVE=1", () => {}); }
