import { describe, test, expect } from "vitest";
import { createSandbox } from "../src/index.js";
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
  test("log readiness observes output without a newline", async () => {
    const box = await createSandbox(await shellProvider());
    try { const process = await box.start("printf READY; sleep 2", { name: "partial", ready: { log: /READY/ }, readyTimeoutMs: 800 }); expect(process.ready).toBe(true); await process.stop({ graceMs: 10 }); }
    finally { await box.destroy(); }
  });

});
