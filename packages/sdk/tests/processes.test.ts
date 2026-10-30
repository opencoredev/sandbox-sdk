import { expect, test, vi } from "vitest";
import { createSandbox, SandboxError } from "../src/index.js";
import { memory } from "../src/memory.js";
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

    const pending = box.start("sleep 30", {
      name: "bad-ready",
      cwd: "nope",
      ready: { port: 5173 },
      readyTimeoutMs: 20_000,
    });

    await expect(pending).rejects.toBeInstanceOf(SandboxError);
    await expect(pending).rejects.toMatchObject({
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

test("start() on a stream-mode provider reports a command that exits at once", async () => {
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

test("line cursors preserve other-stream fragments across serialized resume", async () => {
  const provider = memory({
    handlers: {
      fragments({ stdout, stderr }) {
        stdout("hel");
        stderr("error\n");
        stdout("lo\n");

        return 0;
      },
    },
  });

  const box = await createSandbox(provider);

  try {
    const proc = await box.start("fragments", { name: "fragments" });
    await proc.wait();
    const iterator = proc.lines()[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();
    expect(first.value?.text).toBe("error");
    const resumed = [];

    for await (const line of proc.lines({ after: JSON.parse(JSON.stringify(first.value?.cursor)) }))
      resumed.push(line.text);
    expect(resumed).toEqual(["hello"]);

    for (const after of [
      '{"v":1,"offset":"0","pending":{"stdout":1,"stderr":""}}',
      '{"v":2}',
      "NaN",
    ]) {
      await expect(proc.lines({ after })[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: "invalid_argument",
      });
    }
  } finally {
    await box.destroy();
  }
});

test("line cursors remain resumable for large escaped pending fragments", async () => {
  const provider = memory({
    handlers: {
      large({ stdout, stderr }) {
        stdout("\u0001".repeat(190_000));
        stderr("checkpoint\n");
        stdout("tail\n");

        return 0;
      },
    },
  });

  const box = await createSandbox(provider);

  try {
    const proc = await box.start("large", { name: "large" });
    await proc.wait();
    const iterator = proc.lines()[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();
    expect(Buffer.byteLength(first.value?.cursor ?? "")).toBeLessThanOrEqual(1_048_576);
    const resumed = [];

    for await (const line of proc.lines({ after: first.value?.cursor })) resumed.push(line.text);
    expect(resumed[0]).toContain("tail");
  } finally {
    await box.destroy();
  }
});

test.each(["exit", "timeout"])(
  "readiness %s errors retain the last 50 lines across empty pages",
  async (mode) => {
    const provider = memory({
      handlers: {
        async early({ stdout }) {
          stdout(Array.from({ length: 70 }, (_, n) => `diagnostic-${n + 1}\n`).join(""));
          await new Promise((resolve) => setTimeout(resolve, mode === "exit" ? 120 : 400));

          return 7;
        },
      },
    });

    const box = await createSandbox(provider);

    try {
      let failure: unknown;

      try {
        await box.start("early", { name: "early", ready: { log: /NEVER/ }, readyTimeoutMs: 220 });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(SandboxError);

      if (!(failure instanceof SandboxError)) throw new Error("Expected readiness failure");
      expect(failure.code).toBe(mode === "exit" ? "process_exited" : "timeout");
      expect(failure.message).toContain("diagnostic-21\n");
      expect(failure.message).toContain("diagnostic-70");
      expect(failure.message).not.toContain("diagnostic-20\n");
    } finally {
      await box.destroy();
    }
  },
);

test("exit-before-ready diagnostics drain remaining bounded pages", async () => {
  const box = await createSandbox(
    memory({
      handlers: {
        pages({ stdout }) {
          stdout("x".repeat(100_000) + "\nlast-diagnostic\n");

          return 7;
        },
      },
    }),
  );

  try {
    await expect(
      box.start("pages", { name: "pages", ready: { log: /NEVER/ }, readyTimeoutMs: 1000 }),
    ).rejects.toMatchObject({
      code: "process_exited",
      message: expect.stringContaining("last-diagnostic"),
    });
  } finally {
    await box.destroy();
  }
});

test("HTTP readiness allows a cloud handshake longer than 100ms", async () => {
  const box = await createSandbox(await shellProvider());

  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 150);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

    return new Response("ok");
  });

  try {
    const process = await box.start("sleep 5", {
      name: "http",
      ready: { http: { port: 3000 } },
      readyTimeoutMs: 600,
    });

    expect(process.ready).toBe(true);
    await process.stop();
  } finally {
    fetcher.mockRestore();
    await box.destroy();
  }
});

/** Poll a process's log until it contains `text`. */
async function waitForLog(process: { logs(): Promise<{ text: string }> }, text: string) {
  const end = Date.now() + 10_000;

  while (!(await process.logs()).text.includes(text)) {
    if (Date.now() > end) throw new Error(`Log never showed ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const { spawn } = await import("node:child_process");
  const child = spawn("true");
  await new Promise((resolve) => child.on("exit", resolve));

  if (child.pid === undefined) throw new Error("Missing child pid");

  return child.pid;
}

test("logs() recovers a record lock abandoned by a killed writer", async () => {
  const box = await createSandbox(await shellProvider());

  try {
    const process = await box.start("echo first; sleep 30", { name: "wedged" });
    await waitForLog(process, "first");

    // An owner killed between its mkdir and its owner entry leaves an empty lock.
    await box.run("mkdir /tmp/.sandbox-sdk/procs/wedged/lock");
    expect((await process.logs()).text).toContain("first");

    // A writer killed inside its critical section leaves its own pid as the owner.
    await box.run(`mkdir /tmp/.sandbox-sdk/procs/wedged/lock`);
    await box.run(`touch /tmp/.sandbox-sdk/procs/wedged/lock/${await deadPid()}`);
    expect((await process.logs()).text).toContain("first");

    // The next run under the name can take the lock and append.
    await process.stop({ graceMs: 100 });
    await box.run(`mkdir /tmp/.sandbox-sdk/procs/wedged/lock`);
    await box.run(`touch /tmp/.sandbox-sdk/procs/wedged/lock/${await deadPid()}`);
    const next = await box.start("echo second; sleep 30", { name: "wedged" });
    await waitForLog(next, "second");
    await next.stop({ graceMs: 100 });
  } finally {
    await box.destroy();
  }
}, 30_000);

test("logs() waits for a record lock whose owner is alive", async () => {
  const provider = await shellProvider();
  const box = await createSandbox(provider);

  try {
    const process = await box.start("echo first; sleep 30", { name: "held" });
    await waitForLog(process, "first");
    // This test runner stands in for a live writer that holds the lock for a moment.
    await box.run(`mkdir /tmp/.sandbox-sdk/procs/held/lock`);
    await box.run(`touch /tmp/.sandbox-sdk/procs/held/lock/${globalThis.process.pid}`);
    const released = Date.now() + 500;

    // Straight to the transport: the handle may queue this behind the waiting log read.
    setTimeout(() => {
      void provider.files.remove(box.id, "/tmp/.sandbox-sdk/procs/held/lock", {
        recursive: true,
      });
    }, 500);

    expect((await process.logs()).text).toContain("first");
    expect(Date.now()).toBeGreaterThanOrEqual(released);
    await process.stop({ graceMs: 100 });
  } finally {
    await box.destroy();
  }
});
