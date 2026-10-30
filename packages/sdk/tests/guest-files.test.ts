import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { connectSandbox, createSandbox } from "../src/index.js";
import type { Provider } from "../src/provider.js";
import { shellProvider } from "./shell-provider.js";

/** The shell test transport with every primitive call recorded. `python: false` makes the guest lack python3. */
function recorded(native: Provider, python = true) {
  const calls: string[] = []; const commands: { command: string; stdin?: string; env: Record<string, string> }[] = [];
  const root = native.native("shell") as string;
  const provider: Provider = {
    ...native,
    async exec(id, input) {
      calls.push("exec"); commands.push({ command: input.command, stdin: input.stdin, env: input.env });
      if (!python && input.command.startsWith("python3 ")) return { exitCode: 127, timedOut: false };
      // Guest scripts print host paths after the test transport's rewrite; map them back.
      return native.exec(id, { ...input, onChunk: chunk => input.onChunk({ ...chunk, text: chunk.text.replaceAll(root, "") }) });
    },
    files: {
      ...native.files, editInGuest: true,
      read(id, path) { calls.push("read"); return native.files.read(id, path); },
      write(id, path, data, options) { calls.push("write"); return native.files.write(id, path, data, options); },
      list(id, path) { calls.push("list"); return native.files.list(id, path); },
      mkdir(id, path) { calls.push("mkdir"); return native.files.mkdir(id, path); },
    },
  };
  return { provider, calls, commands, host: (path: string) => join(root, path) };
}

describe("files.edit in one guest call", () => {
  test("one exec, no file RPCs, user text only on stdin, mode kept", async () => {
    const { provider, calls, commands, host } = recorded(await shellProvider());
    const box = await createSandbox(provider);
    try {
      await box.files.write("a.txt", "one\nsecret-before\nthree\n", { mode: 0o640 });
      calls.length = 0; commands.length = 0;
      await box.files.edit("a.txt", { find: "secret-before", replace: "secret-after" });
      expect(calls).toEqual(["exec"]);
      expect(commands[0]?.command).not.toContain("secret");
      expect(commands[0]?.env.SANDBOX_SDK_INPUT).toContain("secret-before");
      expect(commands[0]?.stdin).toBeUndefined();
      expect(await box.files.read("a.txt")).toBe("one\nsecret-after\nthree\n");
      expect((await fs.stat(host("/workspace/a.txt"))).mode & 0o7777).toBe(0o640);
      expect((await fs.readdir(host("/workspace"))).filter(name => name.includes("sdk-edit"))).toEqual([]);
    } finally { await box.destroy(); }
  });

  test("text over 32 KiB goes on stdin instead of the environment", async () => {
    const { provider, calls, commands } = recorded(await shellProvider());
    const box = await createSandbox(provider);
    try {
      const big = "b".repeat(40_000);
      await box.files.write("a.txt", "head\nmarker\ntail\n");
      calls.length = 0; commands.length = 0;
      await box.files.edit("a.txt", { find: "marker", replace: big });
      expect(calls).toEqual(["exec"]);
      expect(commands[0]?.env.SANDBOX_SDK_INPUT).toBe("");
      expect(commands[0]?.stdin).toContain(big);
      expect(await box.files.read("a.txt")).toBe(`head\n${big}\ntail\n`);
    } finally { await box.destroy(); }
  });

  test("errors match the RPC path exactly", async () => {
    const native = await shellProvider();
    const guest = recorded(native); const rpc = recorded(native, false);
    const box = await createSandbox(guest.provider); const legacy = await connectSandbox(rpc.provider, box.id);
    try {
      await box.files.write({ "same.txt": "x\ny x\nz\nx", "one.txt": "abc" });
      for (const [path, edit] of [["same.txt", { find: "x", replace: "z" }], ["one.txt", { find: "missing", replace: "z" }], ["missing.txt", { find: "a", replace: "b" }], ["/workspace", { find: "a", replace: "b" }]] as const) {
        const [ours, theirs] = await Promise.all([box.files.edit(path, edit).catch((error: unknown) => error), legacy.files.edit(path, edit).catch((error: unknown) => error)]);
        expect(ours).toBeInstanceOf(Error);
        expect(ours).toMatchObject({ code: (theirs as { code: string }).code, message: (theirs as Error).message });
      }
      await expect(box.files.edit("same.txt", { find: "x", replace: "z" })).rejects.toMatchObject({ code: "edit_not_unique", message: expect.stringContaining("Matches on lines 1, 2, 4") });
      expect(await box.files.read("same.txt")).toBe("x\ny x\nz\nx");
    } finally { await box.destroy(); }
  });

  test("bytes outside the match survive, including invalid UTF-8 and NUL", async () => {
    const { provider } = recorded(await shellProvider());
    const box = await createSandbox(provider);
    try {
      const before = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x00, 0x41, 0x0a, ...Buffer.from("needle"), 0xc3, 0x0a]);
      await box.files.write("bin", before);
      await box.files.edit("bin", { find: "needle", replace: "pin✓" });
      expect(Buffer.from(await box.files.read("bin", { as: "bytes" }))).toEqual(Buffer.concat([before.subarray(0, 7), Buffer.from("pin✓"), before.subarray(13)]));
    } finally { await box.destroy(); }
  });

  test("a symlink edits its target and stays a link; a hard link is edited in place", async () => {
    const { provider, host } = recorded(await shellProvider());
    const box = await createSandbox(provider);
    try {
      await box.files.write({ "target.txt": "abc", "hard.txt": "hard" });
      await fs.symlink("target.txt", host("/workspace/link.txt"));
      await fs.link(host("/workspace/hard.txt"), host("/workspace/hard-2.txt"));
      await box.files.edit("link.txt", { find: "abc", replace: "ABC" });
      expect((await fs.lstat(host("/workspace/link.txt"))).isSymbolicLink()).toBe(true);
      expect(await box.files.read("target.txt")).toBe("ABC");
      await box.files.edit("hard.txt", { find: "hard", replace: "HARD" });
      expect(await box.files.read("hard-2.txt")).toBe("HARD");
    } finally { await box.destroy(); }
  });

  test("a guest without python3 falls back once, then uses the RPC path directly", async () => {
    const { provider, calls } = recorded(await shellProvider(), false);
    const box = await createSandbox(provider);
    try {
      await box.files.write("a.txt", "one");
      calls.length = 0;
      await box.files.edit("a.txt", { find: "one", replace: "two" });
      await box.files.edit("a.txt", { find: "two", replace: "three" });
      expect(calls).toEqual(["exec", "read", "write", "read", "write"]);
      expect(await box.files.read("a.txt")).toBe("three");
    } finally { await box.destroy(); }
  });
});

test("adapters that stage extra env keep edit on the RPC path", async () => {
  const { provider, calls } = recorded(await shellProvider());
  const box = await createSandbox({ ...provider, files: { ...provider.files, editInGuest: false } });
  try {
    await box.files.write("a.txt", "one");
    calls.length = 0;
    await box.files.edit("a.txt", { find: "one", replace: "two" });
    expect(calls).toEqual(["read", "write"]);
  } finally { await box.destroy(); }
});

describe("files.search in one guest call", () => {
  test("returns what the RPC walk returns, in the same order", async () => {
    const native = await shellProvider();
    const guest = recorded(native); const rpc = recorded(native, false);
    const box = await createSandbox(guest.provider); const legacy = await connectSandbox(rpc.provider, box.id);
    try {
      await box.files.write({
        "src/a.ts": "const hit = 1;\nno\r\nhit again\r\n", "src/b.js": "hit\n", "src/deep/c.ts": "x hit y", "src/ünï.ts": "hit ünï\n",
        "src/😀.ts": "hit emoji", "top.ts": "﻿hit with bom\nhit", "notes/space name.md": "hit", "bin.dat": Buffer.from([0xff, 0x68, 0x69, 0x74, 0x0a, 0xc3, 0x0a]),
      });
      await fs.symlink("src/a.ts", guest.host("/workspace/link.ts"));
      const cases: [string, Parameters<typeof box.files.search>[1]][] = [
        ["hit", {}], ["hit", { glob: "*.ts" }], ["hit", { glob: "src/**/*.ts" }], ["hit", { glob: "src/?.ts" }], ["hit", { glob: "src/?.ts".replace("?", "??") }],
        ["hit", { maxMatches: 3 }], ["hit", { path: "src", glob: "**/c.ts" }], ["ünï", {}], ["nothing", {}], ["again\r", {}],
      ];
      for (const [query, options] of cases) {
        guest.calls.length = 0;
        const ours = await box.files.search(query, options);
        expect(guest.calls).toEqual(["exec"]);
        expect(ours).toEqual(await legacy.files.search(query, options));
      }
      expect((await box.files.search("hit")).length).toBeGreaterThan(5);
      const missing = await legacy.files.search("hit", { path: "missing" }).then(() => undefined, (error: { code: string }) => error.code);
      expect(missing).toBeDefined();
      await expect(box.files.search("hit", { path: "missing" })).rejects.toMatchObject({ code: missing });
    } finally { await box.destroy(); }
  });
});
