import { describe, test, expect } from "vitest";
import { createSandbox, connectSandbox } from "../src/index.js";
import { shellProvider } from "./shell-provider.js";
describe("real Linux primitive transport", () => {
  test("hidden git index yields applicable diffs, git helpers clone/commit/push", async () => {
    const box = await createSandbox(await shellProvider());
    try {
      await box.files.write("a", "one\n"); const mark = await box.files.mark("before"); await box.files.write("a", "two\n");
      const changes = await box.files.changes({ since: mark }); expect(changes.modified).toEqual(["/workspace/a"]); expect(changes.patch).toContain("@@ -1 +1 @@");
      await box.files.write("patch", changes.patch); expect((await box.run("git apply --reverse --check patch")).ok).toBe(true);
      expect((await box.run("git init --bare /tmp/sdk-bare")).ok).toBe(true);
      expect((await box.git.clone("/tmp/sdk-bare", { dir: "repo" })).ok).toBe(true);
      await box.run("git config user.name Test; git config user.email test@example.com", { cwd: "repo" });
      await box.files.write("repo/readme", "hello"); expect((await box.git.commit("repo", { all: true, message: "test" })).ok).toBe(true);
      expect((await box.git.push("repo", { branch: "HEAD" })).ok).toBe(true); expect((await box.git.status("repo")).stdout).toBe("");
    } finally { await box.destroy(); }
  });
  test("fallback exit trap and per-process environment", async () => {
    const box = await createSandbox(await shellProvider());
    try {
      const proc = await box.start("printf '%s\\n' \"$CUSTOM\"; sleep 2", { name: "env", env: { CUSTOM: "ready" }, ready: { log: /ready/ }, readyTimeoutMs: 1000 });
      expect(proc.ready).toBe(true); await proc.stop({ graceMs: 10 });
      await expect(box.start("exit 3", { name: "exit", ready: { log: /never/ }, readyTimeoutMs: 1000 })).rejects.toMatchObject({ code: "process_exited" });
    } finally { await box.destroy(); }
  });
  test("timeout kills descendants, not only the shell", async () => {
    const box = await createSandbox(await shellProvider());
    try {
      expect(await box.run("(sleep 0.2; echo survived > child) & wait", { timeoutMs: 30 })).toMatchObject({ timedOut: true });
      await new Promise(resolve => setTimeout(resolve, 250)); expect(await box.files.exists("child")).toBe(false);
    } finally { await box.destroy(); }
  });
  test("fresh clients stop descendants with portable POSIX kill syntax", async () => {
    const provider = await shellProvider(); const box = await createSandbox(provider);
    try {
      await box.start("(sleep 0.3; echo survived > stopped-child) & wait", { name: "tree" });
      const client = await connectSandbox(provider, box.id); await client.process("tree").stop({ graceMs: 10 });
      await new Promise(resolve => setTimeout(resolve, 350)); expect(await box.files.exists("stopped-child")).toBe(false);
    } finally { await box.destroy(); }
  });
  test("fallback durable logs retain stream identity and redact at rest", async () => {
    const box = await createSandbox(await shellProvider(), { secrets: { TOKEN: "secret-value" } });
    try {
      const process = await box.start("echo hello; echo secret-value >&2", { name: "streams" }); await process.wait();
      const lines = []; for await (const line of process.lines()) lines.push(line);
      expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ text: "hello", stream: "stdout" }), expect.objectContaining({ text: "[REDACTED]", stream: "stderr" })]));
      expect(await box.files.read("/tmp/.sandbox-sdk/procs/streams/out.log")).not.toContain("secret-value");
    } finally { await box.destroy(); }
  });

  test("checkpoints include edits inside nested Git repositories", async () => {
    const box = await createSandbox(await shellProvider());
    try {
      await box.files.write("app/a", "before\n"); await box.run("git init; git config user.name Test; git config user.email test@example.com; git add a; git commit -m initial", { cwd: "app" });
      const mark = await box.files.mark(); await box.files.write("app/a", "after\n");
      const changes = await box.files.changes({ since: mark }); expect(changes.modified).toEqual(["/workspace/app/a"]); expect(changes.patch).toContain("+after");
    } finally { await box.destroy(); }
  });
  test("default create makes no sandbox calls; trackChanges baselines in one exec", async () => {
    const counted = async () => {
      const provider = await shellProvider(); const calls: string[] = [];
      const exec = provider.exec.bind(provider); provider.exec = (id, input) => { calls.push("exec"); return exec(id, input); };
      for (const name of ["read", "write", "list", "stat", "mkdir", "remove"] as const) { const original = provider.files[name].bind(provider.files) as (...args: unknown[]) => Promise<never>; Object.assign(provider.files, { [name]: (...args: unknown[]) => { calls.push(name); return original(...args); } }); }
      const create = provider.create.bind(provider); provider.create = async input => { const info = await create(input); calls.length = 0; return info; };
      return { provider, calls };
    };
    const plain = await counted(); const box = await createSandbox(plain.provider);
    try {
      expect(plain.calls).toEqual([]);
      await expect(box.files.changes()).rejects.toMatchObject({ code: "invalid_argument", message: expect.stringContaining("trackChanges: true") });
      await expect(box.files.changes({ since: "start" })).rejects.toMatchObject({ code: "invalid_argument" });
    } finally { await box.destroy(); }
    const tracked = await counted(); const second = await createSandbox(tracked.provider, { trackChanges: true });
    try {
      expect(tracked.calls).toEqual(["exec"]);
      await second.files.write("x", "1"); expect((await second.files.changes()).added).toEqual(["/workspace/x"]);
    } finally { await second.destroy(); }
  });
  test("secret names are recorded only when present and still recover on connect", async () => {
    const provider = await shellProvider();
    const box = await createSandbox(provider, { secrets: { TOKEN: "secret-value" } });
    try {
      expect(JSON.parse(await box.files.read("/tmp/.sandbox-sdk/secret-names.json"))).toEqual(["TOKEN"]);
      const again = await connectSandbox(provider, box.id); expect((await again.run("echo $TOKEN")).stdout).toBe("[REDACTED]\n");
    } finally { await box.destroy(); }
    const empty = await shellProvider(); const plain = await createSandbox(empty);
    try { expect(await plain.files.exists("/tmp/.sandbox-sdk/secret-names.json")).toBe(false); } finally { await plain.destroy(); }
  });
  test("start checkpoint keeps nested repositories as files, untracked files included", async () => {
    const provider = await shellProvider(); const box = await createSandbox(provider);
    try {
      await box.files.write({ "app/a": "before\n", "top": "t\n" }); await box.run("git init -q; git config user.name Test; git config user.email test@example.com; git add a; git commit -qm initial", { cwd: "app" });
      await box.files.mark("start");
      await box.files.write({ "app/a": "after\n", "app/new": "n\n", "app/.git/ignored-by-checkpoint": "x" }); await box.files.remove("top");
      const changes = await box.files.changes();
      expect(changes).toMatchObject({ added: ["/workspace/app/new"], modified: ["/workspace/app/a"], removed: ["/workspace/top"] }); expect(changes.patch).toContain("+after");
      expect((await box.run("git --git-dir=/tmp/.sandbox-sdk/changes.git ls-tree -r --name-only $(cat /tmp/.sandbox-sdk/marks/start.json)")).stdout).toBe("app/a\ntop\n");
    } finally { await box.destroy(); }
  });
  test("checkpoints fall back to file RPCs when the guest lacks find", async () => {
    const provider = await shellProvider(); const exec = provider.exec.bind(provider);
    provider.exec = (id, input) => input.command.includes("command -v find") ? Promise.resolve({ exitCode: 78, timedOut: false }) : exec(id, input);
    const box = await createSandbox(provider, { trackChanges: true });
    try { await box.files.write("app/x", "1"); expect((await box.files.changes()).added).toEqual(["/workspace/app/x"]); }
    finally { await box.destroy(); }
  });
  test("log readiness observes output without a newline", async () => {
    const box = await createSandbox(await shellProvider());
    try { const process = await box.start("printf READY; sleep 2", { name: "partial", ready: { log: /READY/ }, readyTimeoutMs: 800 }); expect(process.ready).toBe(true); await process.stop({ graceMs: 10 }); }
    finally { await box.destroy(); }
  });

});

test("fallback logs preserve UTF-8 split at a 4096-byte reader boundary", async () => {
  const box = await createSandbox(await shellProvider());
  try {
    const proc = await box.start(`node -e 'process.stdout.write("a".repeat(4095)+"😀\\n")'`, { name: "utf8" }); await proc.wait();
    const lines = []; for await (const line of proc.lines()) lines.push(line.text);
    expect(lines).toEqual(["a".repeat(4095) + "😀"]);
  } finally { await box.destroy(); }
});

test("log pages use bounded remote reads without downloading out.log", async () => {
  const provider = await shellProvider(); const box = await createSandbox(provider);
  try {
    const proc = await box.start("true", { name: "bounded" }); await proc.wait();
    await box.files.write("/tmp/.sandbox-sdk/procs/bounded/out.log", ("O" + "a".repeat(8000) + "\n").repeat(1200));
    const original = provider.files.read;
    provider.files.read = async (id, path) => { if (path.endsWith("out.log")) throw new Error("Whole log downloaded"); return original(id, path); };
    let cursor: string | undefined;
    for (let n = 0; n < 3; n++) {
      const page = await proc.logs({ after: cursor, maxBytes: 16 });
      expect(page.text).toBe("a".repeat(16)); expect(page.truncated).toBe(true); cursor = page.nextCursor;
    }
    await box.files.write("/tmp/.sandbox-sdk/procs/bounded/base", "10000000");
    expect(await proc.logs({ after: "0", maxBytes: 16 })).toMatchObject({ text: "a".repeat(16), truncated: true });
  } finally { await box.destroy(); }
});
