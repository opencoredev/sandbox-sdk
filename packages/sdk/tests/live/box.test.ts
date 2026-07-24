import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { box } from "../../src/providers/box";

test.skipIf(!process.env.BOX_API_KEY)(
  "Ascii Box live conformance smoke test",
  async () => {
    const sandbox = await createSandbox({
      provider: box({ ttlSeconds: 900, readyTimeout: 180_000 }),
      timeout: 180_000,
    });
    try {
      expect((await sandbox.run("printf live-box")).stdout).toContain("live-box");
      await sandbox.files.write("live.txt", "box-live-file");
      expect(await sandbox.files.text("live.txt")).toBe("box-live-file");
      await sandbox.files.mkdir("nested");
      await sandbox.files.write("nested/item.txt", "nested");
      expect(await sandbox.files.exists("nested/item.txt")).toBe(true);
      expect(await sandbox.files.list("nested")).toContainEqual({
        name: "item.txt",
        path: "/workspace/nested/item.txt",
        type: "file",
        size: 6,
      });
      await sandbox.files.remove("nested");
      expect(await sandbox.files.exists("nested")).toBe(false);
      expect(
        (
          await sandbox.run(
            "nohup python3 -m http.server 3111 --bind 0.0.0.0 >/tmp/sandbox-sdk-http.log 2>&1 &",
          )
        ).success,
      ).toBe(true);
      expect(
        (
          await sandbox.run(
            "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3111/live.txt",
          )
        ).stdout,
      ).toBe("200");
      const preview = await sandbox.ports.expose(3111);
      expect(preview).toMatchObject({ public: true, authenticated: false });
      const response = await fetch(new URL("/live.txt", preview.url));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("box-live-file");
    } finally {
      await sandbox.stop();
    }
  },
  210_000,
);
