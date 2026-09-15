import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { tenki } from "../../src/providers/tenki";

test.skipIf(!process.env.TENKI_API_KEY && !process.env.TENKI_AUTH_TOKEN)(
  "Tenki live conformance smoke test",
  async () => {
    const sandbox = await createSandbox({
      provider: tenki({ name: "sandbox-sdk-live", idleTimeoutMinutes: 5 }),
      timeout: 180_000,
    });
    try {
      expect((await sandbox.run("printf live-tenki")).stdout).toBe("live-tenki");
      const failed = await sandbox.run("printf err >&2; exit 3");
      expect([failed.exitCode, failed.stderr, failed.success]).toEqual([3, "err", false]);
      expect((await sandbox.run({ command: "printf", args: ["%s-%s", "a b", "c"] })).stdout).toBe(
        "a b-c",
      );
      expect((await sandbox.run("printf $LIVE_ENV", { env: { LIVE_ENV: "env-ok" } })).stdout).toBe(
        "env-ok",
      );
      await expect(sandbox.run("sleep 5", { timeout: 1_000 })).rejects.toMatchObject({
        code: "timeout",
        provider: "tenki",
      });

      await sandbox.files.write("live.txt", "tenki-live-file");
      expect(await sandbox.files.text("live.txt")).toBe("tenki-live-file");
      expect((await sandbox.run("cat /workspace/live.txt && pwd")).stdout).toBe(
        "tenki-live-file/workspace\n",
      );
      await sandbox.files.mkdir("nested");
      await sandbox.files.write("nested/item.bin", new Uint8Array([0, 1, 2, 255]));
      expect([...(await sandbox.files.read("nested/item.bin"))]).toEqual([0, 1, 2, 255]);
      expect(await sandbox.files.exists("nested/item.bin")).toBe(true);
      expect(await sandbox.files.list("nested")).toEqual([
        { name: "item.bin", path: "/workspace/nested/item.bin", type: "file", size: 4 },
      ]);
      await sandbox.run("echo via-shell > nested/shell.txt");
      expect(await sandbox.files.text("nested/shell.txt")).toBe("via-shell\n");
      await sandbox.files.remove("nested");
      expect(await sandbox.files.exists("nested")).toBe(false);
      await expect(sandbox.files.read("missing.txt")).rejects.toMatchObject({
        code: "not_found",
        provider: "tenki",
      });

      const cat = await sandbox.processes.start("cat");
      await cat.write("hello stdin\n");
      const iterator = cat.output()[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.data).toBe("hello stdin\n");
      await cat.kill();
      expect(await cat.status()).toBe("killed");
      await cat.wait();
      const server = await sandbox.processes.start("python3 -m http.server 3111 --bind 0.0.0.0");
      const ready = await sandbox.run(
        "for i in $(seq 1 20); do curl -sf -o /dev/null http://127.0.0.1:3111/live.txt && exit 0; sleep 0.5; done; exit 1",
      );
      expect(ready.success).toBe(true);

      const preview = await sandbox.ports.expose(3111);
      expect([preview.public, preview.authenticated]).toEqual([true, false]);
      const response = await fetch(new URL("/live.txt", preview.url));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("tenki-live-file");
      await server.kill();

      const snapshot = await sandbox.snapshots.create({ name: "sandbox-sdk-live" });
      expect(snapshot.mode).toBe("memory");
      expect((await sandbox.run("printf after-snapshot")).stdout).toBe("after-snapshot");
      await sandbox.snapshots.delete(snapshot);
    } finally {
      await sandbox.stop();
      await sandbox.stop();
    }
    expect(["TERMINATING", "TERMINATED"]).toContain(sandbox.raw.state);
  },
  420_000,
);
