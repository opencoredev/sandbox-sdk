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
  test("unchanged sandbox env needs no per-run upload and reattached env uploads once", async () => {
    const secret = "sbx44-stable-private-env";
    const provider = factory();
    const box = await createSandbox(provider, { secrets: { TOKEN: secret } });
    try {
      let before = mock.fileWrites.length;
      expect((await box.run("true")).ok).toBe(true);
      expect((await box.$`true`).ok).toBe(true);
      expect(mock.fileWrites.length).toBe(before);
      const attached = await connectSandbox(factory(), box.id);
      before = mock.fileWrites.length;
      expect((await attached.run("printf %s \"$TOKEN\"")).stdout).toBe("[REDACTED]");
      expect((await attached.run("true")).ok).toBe(true);
      expect(mock.fileWrites.slice(before).filter(file => file.path.endsWith("/env"))).toHaveLength(1);
      await attached.close();
    } finally { await box.destroy(); }
  });

  test("keeps secrets out of command text and argv for runs and processes", async () => {
    const secret = "private-token-9ec5e94f";
    const value = "override 'quotes' $literal\n雪";
    const before = mock.commands.length;
    const beforeWrites = mock.fileWrites.length;
    const box = await createSandbox(factory(), {
      secrets: { TOKEN: secret },
      env: { CHECK_OVERRIDE: "base" },
    });
    try {
      const command = `node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.env.TOKEN + process.env.CHECK_OVERRIDE).digest("hex"))'`;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(secret + value),
      );
      const expected = Buffer.from(digest).toString("hex");
      expect((await box.run(command, { env: { CHECK_OVERRIDE: value } })).stdout).toBe(expected);
      const process = await box.start(command, {
        name: "secret-check",
        env: { CHECK_OVERRIDE: value },
      });
      expect(await process.wait()).toMatchObject({ exitCode: 0 });
      expect((await process.logs()).text).toContain(expected);
      const envWrites = mock.fileWrites
        .slice(beforeWrites)
        .filter((file) => file.path.endsWith("/env"));
      expect(envWrites.length).toBeGreaterThan(0);
      for (const file of envWrites) {
        expect(file).toMatchObject({ mode: 0o600, directoryMode: 0o700 });
        expect(await box.files.exists(file.path)).toBe(false);
      }
      expect(mock.commands.slice(before).length).toBeGreaterThan(0);
      for (const command of mock.commands.slice(before)) {
        expect(command).not.toContain(secret);
        for (const token of command.match(/[A-Za-z0-9+/=]{16,}/g) ?? [])
          expect(Buffer.from(token, "base64").toString()).not.toContain(secret);
      }
    } finally {
      await box.destroy();
    }
  });
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
  test("native file transfers span chunks without putting contents in commands", async () => {
    const box = await createSandbox(factory());
    try {
      const bytes = new Uint8Array(4 * 1024 * 1024 + 19).fill(0xab);
      bytes[4 * 1024 * 1024] = 0xcd;
      const expected = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
      await box.files.write("multi-chunk.bin", bytes);
      expect((await box.run("sha256sum multi-chunk.bin")).stdout.trim()).toBe(
        `${expected}  multi-chunk.bin`,
      );
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
