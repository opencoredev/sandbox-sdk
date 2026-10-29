import { describe, expect, test } from "vitest";
import type { Provider } from "../src/provider.js";
import { createSandbox } from "../src/index.js";
import type { MockGuest } from "./cloud-guest-mock.js";

export function cloudRegressions(
  factory: () => Provider,
  guest: (id: string) => MockGuest | undefined,
  wholeReadViaExec = false,
) {
  describe("native round-trip and execution regressions", () => {
    test("invalid cwd fails normally without deleting the VM", async () => {
      const box = await createSandbox(factory());
      try {
        const result = await box.run("pwd", { cwd: "/workspace/does-not-exist", timeoutMs: 300 });
        expect(result).toMatchObject({ ok: false, timedOut: false, exitCode: 2, stdout: "", stderr: expect.stringMatching(/cd.*does-not-exist/) });
        const started = await box.start("sleep 30", { name: "bad-cwd", cwd: "/workspace/does-not-exist" });
        await expect(started.wait()).resolves.toMatchObject({ exitCode: 2 });
        expect((await started.logs()).text).toMatch(/cd.*does-not-exist/);
        expect(guest(box.id)).toBeDefined();
        expect((await box.run("echo alive")).stdout).toBe("alive\n");
      } finally {
        await box.destroy();
      }
    });
    test('public run("true") uses exactly one native exec and no transfers, including a repeat', async () => {
      const box = await createSandbox(factory());
      const native = guest(box.id);
      if (!native) throw new Error("Missing mock guest");
      try {
        for (let repeat = 0; repeat < 2; repeat++) {
          const before = {
            exec: native.commands.length,
            upload: native.uploads.length,
            read: native.reads.length,
          };
          expect(await box.run("true")).toMatchObject({ exitCode: 0, timedOut: false });
          expect({
            exec: native.commands.length - before.exec,
            upload: native.uploads.length - before.upload,
            read: native.reads.length - before.read,
          }).toEqual({ exec: 1, upload: 0, read: 0 });
        }
      } finally {
        await box.destroy();
      }
    });
    test("1 MiB whole-file read is one native call", async () => {
      const box = await createSandbox(factory());
      const native = guest(box.id);
      if (!native) throw new Error("Missing mock guest");
      const data = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 251);
      const calls = () => ({
        exec: native.commands.length,
        upload: native.uploads.length,
        read: native.reads.length,
      });
      try {
        await box.files.write("large.bin", data);
        const before = calls();
        expect(
          Buffer.from(await box.files.read("large.bin", { as: "bytes" })).equals(Buffer.from(data)),
        ).toBe(true);
        const after = calls();
        expect({
          exec: after.exec - before.exec,
          upload: after.upload - before.upload,
          read: after.read - before.read,
        }).toEqual({ exec: wholeReadViaExec ? 1 : 0, upload: 0, read: wholeReadViaExec ? 0 : 1 });
      } finally {
        await box.destroy();
      }
    });
    test("small public write is exactly one native upload", async () => {
      const box = await createSandbox(factory());
      const native = guest(box.id);
      if (!native) throw new Error("Missing guest");
      const before = {
        exec: native.commands.length,
        upload: native.uploads.length,
        read: native.reads.length,
      };
      try {
        await box.files.write("small.txt", "hi");
        expect({
          exec: native.commands.length - before.exec,
          upload: native.uploads.length - before.upload,
          read: native.reads.length - before.read,
        }).toEqual({ exec: 0, upload: 1, read: 0 });
      } finally {
        await box.destroy();
      }
    });
    test("ranges larger than 32 KiB return every requested byte and stop at EOF", async () => {
      const provider = factory();
      const box = await createSandbox(provider);
      const data = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 251);
      try {
        await box.files.write("range.bin", data);
        if (!provider.files.readRange) throw new Error("Expected range transport");
        for (const range of [
          { offset: 12345, length: 100000 },
          { offset: data.length - 50000, length: 100000 },
        ]) {
          const native = guest(box.id);
          if (!native) throw new Error("Missing guest");
          const before = native.commands.length + native.reads.length;
          expect(
            Buffer.from(
              await provider.files.readRange(box.id, "/workspace/range.bin", range),
            ).equals(Buffer.from(data.subarray(range.offset, range.offset + range.length))),
          ).toBe(true);
          expect(native.commands.length + native.reads.length - before).toBe(1);
        }
      } finally {
        await box.destroy();
      }
    });
    test("inline execution keeps the core activity record until completion", async () => {
      const box = await createSandbox(factory());
      try {
        const result = await box.run("find /tmp/.sandbox-sdk/runs -type f | wc -l");
        expect(Number(result.stdout.trim())).toBeGreaterThan(0);
        expect((await box.files.list("/tmp/.sandbox-sdk/runs")).length).toBe(0);
      } finally {
        await box.destroy();
      }
    });
    test("final stdout and stderr are drained on normal completion", async () => {
      const box = await createSandbox(factory());
      try {
        expect(await box.run("printf 'FINAL OUTPUT'; printf 'FINAL ERROR' >&2")).toMatchObject({
          stdout: "FINAL OUTPUT",
          stderr: "FINAL ERROR",
          exitCode: 0,
        });
      } finally {
        await box.destroy();
      }
    });
  });
}
