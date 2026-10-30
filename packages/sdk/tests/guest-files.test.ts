import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { connectSandbox, createSandbox, SandboxError } from "../src/index.js";
import type { Provider } from "../src/provider.js";
import { isString } from "../src/shared/narrow.js";
import { shellProvider } from "./shell-provider.js";

const hostExec = promisify(execFile);

/** The code and message an SDK call rejects with; anything else fails the comparison. */
const failure = (call: Promise<void>) =>
  call.then(
    () => "resolved",
    (error) =>
      error instanceof SandboxError ? { code: error.code, message: error.message } : error,
  );

/** The shell test transport with every primitive call recorded. `python: false` makes the guest lack python3.
 * Its write truncates in place, as `write: "in-place"` says. Its list sorts by name, as Node's fs does;
 * `list: "directory"` lists in the directory's own order instead, as `os.listdir` does. */
function recorded(
  native: Provider,
  {
    python = true,
    write = "in-place",
    list = "name",
  }: { python?: boolean; write?: "in-place" | "replace"; list?: "name" | "directory" } = {},
) {
  const calls: string[] = [];
  const commands: { command: string; stdin?: string; env: Record<string, string> }[] = [];
  // SAFETY: the shell test provider's native handle is its sandbox root directory.
  const root = native.native("shell") as string;

  const provider: Provider = {
    ...native,
    async exec(id, input) {
      calls.push("exec");
      commands.push({ command: input.command, stdin: input.stdin, env: input.env });

      if (!python && input.command.startsWith("python3 "))
        return { exitCode: 127, timedOut: false };

      // Guest scripts print host paths after the test transport's rewrite; map them back.
      return native.exec(id, {
        ...input,
        onChunk: (chunk) => input.onChunk({ ...chunk, text: chunk.text.replaceAll(root, "") }),
      });
    },
    files: {
      ...native.files,
      editInGuest: write,
      listOrder: list,
      read(id, path) {
        calls.push("read");

        return native.files.read(id, path);
      },
      write(id, path, data, options) {
        calls.push("write");

        return native.files.write(id, path, data, options);
      },
      async list(id, path) {
        calls.push("list");

        if (list === "name") return native.files.list(id, path);

        const { stdout } = await hostExec("python3", [
          "-c",
          "import json,os,sys;print(json.dumps(os.listdir(sys.argv[1])))",
          join(root, path),
        ]);

        const names: unknown = JSON.parse(stdout);

        if (!Array.isArray(names) || !names.every(isString)) throw new Error("bad listing");

        return Promise.all(names.map((name) => native.files.stat(id, posix.join(path, name))));
      },
      mkdir(id, path) {
        calls.push("mkdir");

        return native.files.mkdir(id, path);
      },
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
      calls.length = 0;
      commands.length = 0;
      await box.files.edit("a.txt", { find: "secret-before", replace: "secret-after" });
      expect(calls).toEqual(["exec"]);
      expect(commands[0]?.command).not.toContain("secret");
      expect(commands[0]?.env.SANDBOX_SDK_INPUT).toContain("secret-before");
      expect(commands[0]?.stdin).toBeUndefined();
      expect(await box.files.read("a.txt")).toBe("one\nsecret-after\nthree\n");
      expect((await fs.stat(host("/workspace/a.txt"))).mode & 0o7777).toBe(0o640);
      expect(
        (await fs.readdir(host("/workspace"))).filter((name) => name.includes("sdk-edit")),
      ).toEqual([]);
    } finally {
      await box.destroy();
    }
  });

  test("text over 32 KiB goes on stdin instead of the environment", async () => {
    const { provider, calls, commands } = recorded(await shellProvider());
    const box = await createSandbox(provider);

    try {
      const big = "b".repeat(40_000);
      await box.files.write("a.txt", "head\nmarker\ntail\n");
      calls.length = 0;
      commands.length = 0;
      await box.files.edit("a.txt", { find: "marker", replace: big });
      expect(calls).toEqual(["exec"]);
      expect(commands[0]?.env.SANDBOX_SDK_INPUT).toBe("");
      expect(commands[0]?.stdin).toContain(big);
      expect(await box.files.read("a.txt")).toBe(`head\n${big}\ntail\n`);
    } finally {
      await box.destroy();
    }
  });

  test("errors match the RPC path exactly", async () => {
    const native = await shellProvider();
    const guest = recorded(native);
    const rpc = recorded(native, { python: false });
    const box = await createSandbox(guest.provider);
    const legacy = await connectSandbox(rpc.provider, box.id);

    try {
      await box.files.write({ "same.txt": "x\ny x\nz\nx", "one.txt": "abc" });

      for (const [path, edit] of [
        ["same.txt", { find: "x", replace: "z" }],
        ["one.txt", { find: "missing", replace: "z" }],
        ["missing.txt", { find: "a", replace: "b" }],
        ["/workspace", { find: "a", replace: "b" }],
      ] as const) {
        const [ours, theirs] = await Promise.all([
          failure(box.files.edit(path, edit)),
          failure(legacy.files.edit(path, edit)),
        ]);

        expect(ours).toMatchObject({ code: expect.any(String), message: expect.any(String) });
        expect(ours).toEqual(theirs);
      }

      await expect(box.files.edit("same.txt", { find: "x", replace: "z" })).rejects.toMatchObject({
        code: "edit_not_unique",
        message: expect.stringContaining("Matches on lines 1, 2, 4"),
      });
      expect(await box.files.read("same.txt")).toBe("x\ny x\nz\nx");
    } finally {
      await box.destroy();
    }
  });

  test("bytes outside the match survive, including invalid UTF-8 and NUL", async () => {
    const { provider } = recorded(await shellProvider());
    const box = await createSandbox(provider);

    try {
      const before = Buffer.from([
        0xef,
        0xbb,
        0xbf,
        0xff,
        0x00,
        0x41,
        0x0a,
        ...Buffer.from("needle"),
        0xc3,
        0x0a,
      ]);

      await box.files.write("bin", before);
      await box.files.edit("bin", { find: "needle", replace: "pin✓" });
      expect(Buffer.from(await box.files.read("bin", { as: "bytes" }))).toEqual(
        Buffer.concat([before.subarray(0, 7), Buffer.from("pin✓"), before.subarray(13)]),
      );
    } finally {
      await box.destroy();
    }
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
    } finally {
      await box.destroy();
    }
  });

  test("a guest without python3 falls back once, then uses the RPC path directly", async () => {
    const { provider, calls } = recorded(await shellProvider(), { python: false });
    const box = await createSandbox(provider);

    try {
      await box.files.write("a.txt", "one");
      calls.length = 0;
      await box.files.edit("a.txt", { find: "one", replace: "two" });
      await box.files.edit("a.txt", { find: "two", replace: "three" });
      expect(calls).toEqual(["exec", "read", "write", "read", "write"]);
      expect(await box.files.read("a.txt")).toBe("three");
    } finally {
      await box.destroy();
    }
  });
});

test("adapters that stage extra env keep edit on the RPC path", async () => {
  const { provider, calls } = recorded(await shellProvider());

  const box = await createSandbox({
    ...provider,
    files: { ...provider.files, editInGuest: undefined },
  });

  try {
    await box.files.write("a.txt", "one");
    calls.length = 0;
    await box.files.edit("a.txt", { find: "one", replace: "two" });
    expect(calls).toEqual(["read", "write"]);
  } finally {
    await box.destroy();
  }
});

describe("files.search in one guest call", () => {
  test("returns what the RPC walk returns, in the same order", async () => {
    const native = await shellProvider();
    const guest = recorded(native);
    const rpc = recorded(native, { python: false });
    const box = await createSandbox(guest.provider);
    const legacy = await connectSandbox(rpc.provider, box.id);

    try {
      await box.files.write({
        "src/a.ts": "const hit = 1;\nno\r\nhit again\r\n",
        "src/b.js": "hit\n",
        "src/deep/c.ts": "x hit y",
        "src/ünï.ts": "hit ünï\n",
        "src/😀.ts": "hit emoji",
        "top.ts": "﻿hit with bom\nhit",
        "notes/space name.md": "hit",
        "bin.dat": Buffer.from([0xff, 0x68, 0x69, 0x74, 0x0a, 0xc3, 0x0a]),
      });
      await fs.symlink("src/a.ts", guest.host("/workspace/link.ts"));

      const cases: [string, Parameters<typeof box.files.search>[1]][] = [
        ["hit", {}],
        ["hit", { glob: "*.ts" }],
        ["hit", { glob: "src/**/*.ts" }],
        ["hit", { glob: "src/?.ts" }],
        ["hit", { glob: "src/?.ts".replace("?", "??") }],
        ["hit", { maxMatches: 3 }],
        ["hit", { path: "src", glob: "**/c.ts" }],
        ["ünï", {}],
        ["nothing", {}],
        ["again\r", {}],
      ];

      for (const [query, options] of cases) {
        guest.calls.length = 0;
        const ours = await box.files.search(query, options);
        expect(guest.calls).toEqual(["exec"]);
        expect(ours).toEqual(await legacy.files.search(query, options));
      }

      expect((await box.files.search("hit")).length).toBeGreaterThan(5);

      const missing = await legacy.files.search("hit", { path: "missing" }).then(
        () => undefined,
        (error: { code: string }) => error.code,
      );

      expect(missing).toBeDefined();
      await expect(box.files.search("hit", { path: "missing" })).rejects.toMatchObject({
        code: missing,
      });
    } finally {
      await box.destroy();
    }
  });
});

describe("guest scripts hold no caller value", () => {
  test("a hostile glob, query, path or edit text runs nothing and never reaches the command", async () => {
    const native = await shellProvider();
    const guest = recorded(native);
    const rpc = recorded(native, { python: false });
    const box = await createSandbox(guest.provider);
    const legacy = await connectSandbox(rpc.provider, box.id);
    const tag = crypto.randomUUID();

    // Each would create /tmp/pwned-<tag>-<name> if it ever ran as Python or shell.
    const payload = (name: string) =>
      `'"); import os; os.system("touch /tmp/pwned-${tag}-${name}") #`;

    const dir = `x'$(touch pwned-${tag}-path)'"$(touch pwned-${tag}-path)"`;

    try {
      await box.files.write({ "src/a.ts": "hit\n", [`${dir}/b.ts`]: `hit ${payload("text")}\n` });
      guest.commands.length = 0;

      const cases: [string, Parameters<typeof box.files.search>[1]][] = [
        ["hit", { glob: payload("glob") }],
        ["hit", { glob: `**/*${payload("glob-star")}*` }],
        [payload("query"), {}],
        ["hit", { path: dir }],
        ["hit", { path: dir, glob: "*.ts", maxMatches: 1 }],
      ];

      for (const [query, options] of cases)
        expect(await box.files.search(query, options)).toEqual(
          await legacy.files.search(query, options),
        );

      expect(await box.files.search(payload("text"))).toEqual([
        { path: `/workspace/${dir}/b.ts`, line: 1, text: `hit ${payload("text")}` },
      ]);
      await box.files.edit(`${dir}/b.ts`, { find: payload("text"), replace: payload("replace") });
      expect(await box.files.read(`${dir}/b.ts`)).toBe(`hit ${payload("replace")}\n`);

      const scripts = guest.commands.filter(({ command }) => command.startsWith("python3 "));
      expect(scripts).toHaveLength(cases.length + 2);
      // One fixed command per script: every caller value travels in the JSON input.
      expect(new Set(scripts.map(({ command }) => command)).size).toBe(2);

      for (const { command, env } of scripts) {
        expect(command).not.toMatch(/pwned|hit|workspace/);
        expect(JSON.parse(env.SANDBOX_SDK_INPUT ?? "")).toBeTypeOf("object");
      }

      for (const name of ["glob", "glob-star", "query", "text", "replace"])
        expect(existsSync(`/tmp/pwned-${tag}-${name}`)).toBe(false);
      expect(existsSync(guest.host(`/pwned-${tag}-path`))).toBe(false);
      expect(existsSync(guest.host(`/workspace/pwned-${tag}-path`))).toBe(false);
    } finally {
      await box.destroy();
    }
  });
});

describe("guest edit keeps the file identity the adapter's write gives", () => {
  test("in place: the same inode, so hard links and open descriptors see the edit", async () => {
    const { provider, calls, host } = recorded(await shellProvider());
    const box = await createSandbox(provider);

    try {
      await box.files.write("a.txt", "one\ntwo-long-line\n", { mode: 0o640 });
      await fs.link(host("/workspace/a.txt"), host("/workspace/a-link.txt"));
      const before = await fs.stat(host("/workspace/a.txt"));
      const open = await fs.open(host("/workspace/a.txt"), "r");

      try {
        calls.length = 0;
        await box.files.edit("a.txt", { find: "two-long-line", replace: "2" });
        expect(calls).toEqual(["exec"]);
        const after = await fs.stat(host("/workspace/a.txt"));
        expect(after.ino).toBe(before.ino);
        expect(after.mode & 0o7777).toBe(0o640);
        expect((await open.read(Buffer.alloc(64), 0, 64, 0)).buffer.toString("utf8", 0, 6)).toBe(
          "one\n2\n",
        );
        expect(after.size).toBe(6);
        expect(await box.files.read("a-link.txt")).toBe("one\n2\n");
      } finally {
        await open.close();
      }
    } finally {
      await box.destroy();
    }
  });

  test("replace: a new inode with the original mode, as a replacing write gives", async () => {
    const { provider, calls, host } = recorded(await shellProvider(), { write: "replace" });
    const box = await createSandbox(provider);

    try {
      await box.files.write("a.txt", "one\ntwo\n", { mode: 0o640 });
      const before = await fs.stat(host("/workspace/a.txt"));
      calls.length = 0;
      await box.files.edit("a.txt", { find: "two", replace: "2" });
      expect(calls).toEqual(["exec"]);
      const after = await fs.stat(host("/workspace/a.txt"));
      expect(after.ino).not.toBe(before.ino);
      expect(after.mode & 0o7777).toBe(0o640);
      expect(await box.files.read("a.txt")).toBe("one\n2\n");
    } finally {
      await box.destroy();
    }
  });

  test("an in-place edit of a file it cannot write falls back before any change", async () => {
    const { provider, calls, host } = recorded(await shellProvider());
    const box = await createSandbox(provider);

    try {
      await box.files.write("a.txt", "one");
      await fs.chmod(host("/workspace/a.txt"), 0o444);
      calls.length = 0;
      const ours = await failure(box.files.edit("a.txt", { find: "one", replace: "two" }));

      // Root writes regardless of mode, so only a non-root host sees the refusal.
      if (process.getuid?.() !== 0) {
        expect(calls).toEqual(["exec", "read", "write"]);
        expect(ours).not.toBe("resolved");
        expect(await box.files.read("a.txt")).toBe("one");
      }
    } finally {
      await fs.chmod(host("/workspace/a.txt"), 0o644).catch(() => {});
      await box.destroy();
    }
  });
});

describe("guest search walks in the adapter's list order", () => {
  test("maxMatches stops at the same files when the list keeps directory order", async () => {
    const native = await shellProvider();
    const guest = recorded(native, { list: "directory" });
    const rpc = recorded(native, { python: false, list: "directory" });
    const box = await createSandbox(guest.provider);
    const legacy = await connectSandbox(rpc.provider, box.id);

    try {
      const names = ["z", "a", "q", "c", "x", "b", "m", "d"].map((name) => `${name}.ts`);

      for (const name of names) await box.files.write(`src/${name}`, "hit\n");
      await box.files.write("src/sub/inner.ts", "hit\n");

      const order = (await legacy.files.list("src")).map((entry) => posix.basename(entry.path));
      // The test means something only where the directory's order is not name order.
      expect(order).not.toEqual([...order].sort());

      for (const maxMatches of [1, 3, 20]) {
        guest.calls.length = 0;
        const ours = await box.files.search("hit", { maxMatches });
        expect(guest.calls).toEqual(["exec"]);
        expect(ours).toEqual(await legacy.files.search("hit", { maxMatches }));
      }
    } finally {
      await box.destroy();
    }
  });

  test("an adapter that declares no list order searches through list and read", async () => {
    const { provider, calls } = recorded(await shellProvider());

    const box = await createSandbox({
      ...provider,
      files: { ...provider.files, listOrder: undefined },
    });

    try {
      await box.files.write("a.ts", "hit\n");
      calls.length = 0;
      expect(await box.files.search("hit")).toEqual([
        { path: "/workspace/a.ts", line: 1, text: "hit" },
      ]);
      expect(calls).not.toContain("exec");
      expect(calls).toContain("read");
    } finally {
      await box.destroy();
    }
  });
});
