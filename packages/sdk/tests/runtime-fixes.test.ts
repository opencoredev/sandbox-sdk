/** SBX-71 runtime fixes in the shared core: process start failures and RunHandle as a Promise. */
import { expect, test } from "vitest";
import { createSandbox, SandboxError } from "../src/index.js";
import type { RunResult } from "../src/types.js";
import { shellProvider } from "./shell-provider.js";

test("start() with a missing cwd reports failed and logs the shell's cd error", async () => {
  const box = await createSandbox(await shellProvider());

  try {
    const process = await box.start("sleep 30", { name: "bad-cwd", cwd: "nope" });
    expect(process.status).toBe("failed");
    expect(process.ready).toBe(false);
    expect((await process.logs()).text).toMatch(/cd.*nope/);
    const lines = [];

    for await (const line of process.lines()) lines.push(line);
    expect(lines).toEqual([
      expect.objectContaining({ stream: "stderr", text: expect.stringMatching(/cd.*nope/) }),
    ]);
    expect((await process.wait()).exitCode).not.toBe(0);
    expect(await box.processes()).toEqual([
      expect.objectContaining({ name: "bad-cwd", status: "failed" }),
    ]);
    // The failed record does not block a corrected start under the same name.
    await box.run("mkdir nope");
    const fixed = await box.start("sleep 30", { name: "bad-cwd", cwd: "nope" });
    expect(fixed.status).toBe("running");
    await fixed.stop({ graceMs: 100 });
  } finally {
    await box.destroy();
  }
});

test("start() with a missing cwd and ready fails fast with the cd error in the log tail", async () => {
  const box = await createSandbox(await shellProvider());

  try {
    const started = Date.now();

    const error = await box
      .start("sleep 30", {
        name: "bad-ready",
        cwd: "nope",
        ready: { port: 5173 },
        readyTimeoutMs: 20_000,
      })
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({
      code: "process_exited",
      message: expect.stringMatching(/Exit [1-9]\d*\. Check the last logs: .*cd.*nope/),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    await box.destroy();
  }
});

test("start() reports a command that already exited as failed or exited, not running", async () => {
  const provider = await shellProvider();
  // Run quick launches in the foreground: the exit record then exists before the
  // launcher's own check, which keeps this test independent of host speed.
  const exec = provider.exec.bind(provider);
  provider.exec = (id, input) =>
    exec(
      id,
      input.command.startsWith("nohup setsid") && !input.command.includes("sleep 30")
        ? {
            ...input,
            command: input.command.replace(" < /dev/null & echo $!", " < /dev/null; echo $!"),
          }
        : input,
    );
  const box = await createSandbox(provider);

  try {
    const failing = await box.start("exit 3", { name: "quick" });
    expect(failing.status).toBe("failed");
    expect(failing.ready).toBe(false);
    const ok = await box.start("true", { name: "quick-ok" });
    expect(ok.status).toBe("exited");
    const running = await box.start("sleep 30", { name: "slow" });
    expect(running.status).toBe("running");
    await running.stop({ graceMs: 100 });
  } finally {
    await box.destroy();
  }
});

test("a RunHandle is a lazy Promise: then, catch and finally work and streaming still does", async () => {
  const box = await createSandbox(await shellProvider());

  try {
    const handle = box.run("echo hi");
    expect(String(handle)).toBe("[object RunHandle]");
    const promise: Promise<RunResult> = handle;
    let finished = false;
    expect(
      await promise.finally(() => {
        finished = true;
      }),
    ).toMatchObject({ ok: true, stdout: "hi\n" });
    expect(finished).toBe(true);
    // .catch runs the command and receives its rejection.
    const error = await box.run("true", { timeoutMs: -1 }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_argument" });
    expect(await box.run("echo caught").catch(() => undefined)).toMatchObject({
      stdout: "caught\n",
    });
    expect(await Promise.all([box.run("echo a"), box.run("echo b")])).toEqual([
      expect.objectContaining({ stdout: "a\n" }),
      expect.objectContaining({ stdout: "b\n" }),
    ]);
    // Nothing runs until the handle is awaited or iterated, so chaining still works.
    const lazy = box.run("pwd");
    lazy.cwd("/tmp");
    expect((await lazy).cwd).toBe("/tmp");
    const chunks = [];

    for await (const chunk of box.run("echo streamed")) chunks.push(chunk.text);
    expect(chunks.join("")).toBe("streamed\n");
  } finally {
    await box.destroy();
  }
});

test("start() on a provider with native process hooks reports a command that exits at once", async () => {
  const { memory } = await import("../src/memory.js");
  const box = await createSandbox(memory());

  try {
    expect((await box.start("true", { name: "ok" })).status).toBe("exited");
    const failed = await box.start("exit 3", { name: "bad" });
    expect(failed.status).toBe("failed");
    expect(failed.ready).toBe(false);
    expect((await box.start("sleep 5", { name: "long" })).status).toBe("running");
  } finally {
    await box.destroy();
  }
});
