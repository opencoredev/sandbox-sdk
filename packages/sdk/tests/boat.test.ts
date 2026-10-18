import { afterAll, describe, expect, test, vi } from "vitest";
import type { CreateOptions } from "../src/index.js";
import { createSandbox, connectSandbox, listSandboxes } from "../src/index.js";
import { boat } from "../src/providers/boat/index.js";
import { runConformance } from "../src/testing.js";
import { boatMock } from "./boat-mock.js";
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const mock = await boatMock();
const factory = () => boat({ apiKey: "test-key", apiUrl: mock.apiUrl });
afterAll(() => mock.dispose());
runConformance(factory, { live: true });

describe("Boat official SDK transport", () => {
  test("maps sizes and isolates account secrets with noEnv", async () => {
    for (const [size, type] of [
      ["small", "small"],
      ["medium", "default"],
      ["large", "large"],
    ] as const) {
      const box = await createSandbox(factory(), { size, env: { TEST: "hello" } });
      try {
        expect(mock.creates.at(-1)).toMatchObject({ type, noEnv: true, env: { TEST: "hello" } });
        expect((await box.run('printf %s "$TEST"')).stdout).toBe("hello");
      } finally {
        await box.destroy();
      }
    }
  });
  test("fresh clients find metadata across pages and exclude unrelated VMs", async () => {
    const boxes = await Promise.all([
      createSandbox(factory(), { key: "first" }),
      createSandbox(factory(), { key: "second", labels: { app: "boat" } }),
    ]);
    try {
      const fresh = factory();
      expect((await fresh.find("second"))?.id).toBe(boxes[1]?.id);
      expect((await listSandboxes(fresh, { labels: { app: "boat" } })).map((b) => b.id)).toEqual([
        boxes[1]?.id,
      ]);
      const box = boxes[0];
      if (!box) throw new Error("No box");
      const entry = mock.boxes.get(box.id);
      if (!entry) throw new Error("No native box");
      entry.name = "unrelated";
      expect((await fresh.list({})).map((b) => b.id)).not.toContain(box.id);
      await expect(connectSandbox(fresh, box.id)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await Promise.all(boxes.map((box) => box.destroy()));
    }
  });
  test("recovers a lost create response without duplicating or orphaning the VM", async () => {
    const before = mock.creates.length;
    const count = mock.boxes.size;
    mock.loseCreate = true;
    const box = await createSandbox(factory(), { key: "recovered-create" });
    try {
      expect(mock.creates.length).toBe(before + 1);
      expect(mock.boxes.size).toBe(count + 1);
      expect((await factory().find("recovered-create"))?.id).toBe(box.id);
    } finally {
      await box.destroy();
    }
  });
  test("truncated file responses fail instead of returning corrupt bytes", async () => {
    const box = await createSandbox(factory());
    try {
      await box.files.write("truncated", new Uint8Array(20_000));
      mock.truncate = true;
      await expect(box.files.read("truncated", { as: "bytes" })).rejects.toMatchObject({
        code: "provider",
      });
    } finally {
      mock.truncate = false;
      await box.destroy();
    }
  });
  test("reads and edits the complete target through a symlink", async () => {
    const box = await createSandbox(factory());
    try {
      await box.files.write("target.txt", "abcdefghijklmnopqrstuvwxyz");
      await box.run("ln -s target.txt link.txt");
      expect(await box.files.read("link.txt")).toBe("abcdefghijklmnopqrstuvwxyz");
      await box.files.edit("link.txt", { find: "abc", replace: "ABC" });
      expect(await box.files.read("target.txt")).toBe("ABCdefghijklmnopqrstuvwxyz");
    } finally {
      await box.destroy();
    }
  });
  test("large stdin is delivered with EOF beyond shell argument limits", async () => {
    const box = await createSandbox(factory());
    try {
      expect((await box.run("wc -c", { stdin: "x".repeat(256 * 1024) })).stdout.trim()).toBe(
        "262144",
      );
    } finally {
      await box.destroy();
    }
  });
  test("large binary writes cross shell argument limits without corruption", async () => {
    const box = await createSandbox(factory());
    try {
      const bytes = new Uint8Array(256 * 1024);
      crypto.getRandomValues(bytes.subarray(0, 65536));
      await box.files.write("large.bin", bytes);
      expect(await box.files.read("large.bin", { as: "bytes" })).toEqual(bytes);
    } finally {
      await box.destroy();
    }
  });
  test("rejects unsupported options and metadata overflow before creating", async () => {
    const count = mock.creates.length;
    for (const opts of [
      { size: { cpu: 1, memoryMb: 1024, diskGb: 10 } },
      { network: "none" },
      { network: { allow: ["example.com"] } },
      { timeoutMs: 60_000 },
      { idleTimeoutMs: 1000 },
      { from: "snapshot" },
      { labels: { long: Array.from({ length: 50 }, () => crypto.randomUUID()).join("") } },
    ] satisfies CreateOptions[]) {
      await expect(createSandbox(factory(), opts)).rejects.toMatchObject({
        code: "unsupported",
        provider: "boat",
      });
    }
    expect(mock.creates.length).toBe(count);
  });
  test("late launches and aborts kill descendants before returning", async () => {
    const box = await createSandbox(factory());
    try {
      mock.launchDelayMs = 80;
      expect(
        await box.run("(sleep .3; echo leaked > leaked) & wait", { timeoutMs: 20 }),
      ).toMatchObject({ timedOut: true, exitCode: null });
      mock.launchDelayMs = 0;
      const abort = new AbortController();
      const pending = Promise.resolve(
        box.run("(sleep .3; echo leaked > aborted) & wait", { signal: abort.signal }),
      );
      setTimeout(() => abort.abort(), 30);
      expect(await pending).toMatchObject({ timedOut: true, exitCode: null });
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(await box.files.exists("leaked")).toBe(false);
      expect(await box.files.exists("aborted")).toBe(false);
    } finally {
      mock.launchDelayMs = 0;
      await box.destroy();
    }
  });
  test("stream failure stops remote work and redacts native error bodies", async () => {
    const box = await createSandbox(factory());
    try {
      mock.failStream = true;
      await expect(box.run("sleep .3; echo leaked > stream-leak")).rejects.toMatchObject({
        code: "unavailable",
        provider: "boat",
      });
      mock.failStream = false;
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(await box.files.exists("stream-leak")).toBe(false);
      for (const [status, code] of [
        [401, "auth"],
        [404, "not_found"],
        [429, "quota"],
        [503, "unavailable"],
      ] as const) {
        mock.status = status;
        await expect(factory().connect(box.id)).rejects.toMatchObject({ code, provider: "boat" });
        try {
          await factory().connect(box.id);
        } catch (error) {
          expect(String(error)).not.toContain("secret-value");
        }
      }
    } finally {
      mock.status = 0;
      mock.failStream = false;
      await box.destroy();
    }
  });
});
