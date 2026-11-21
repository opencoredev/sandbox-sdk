import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { connectSandbox, createSandbox, SandboxError } from "../src/index.js";
import { memory } from "../src/memory.js";
import { redactionSedScript } from "../src/shell/process-records.js";
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

test("concurrent start() calls with one name launch only one process", async () => {
  const provider = await shellProvider();
  const exec = provider.exec.bind(provider);
  // Widen the gap between setup's running check and its record writes, so both calls
  // reach the check before either writes spec.json unless setup reserves the name.
  provider.exec = (id, input) =>
    exec(id, {
      ...input,
      command: input.command.replace("then exit 73; fi;", "then exit 73; fi; sleep 0.3;"),
    });
  const box = await createSandbox(provider);

  try {
    const results = await Promise.allSettled([
      box.start("sleep 30", { name: "twin" }),
      box.start("sleep 30", { name: "twin" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: "invalid_argument",
          message: expect.stringContaining("already running"),
        }),
      }),
    ]);
    await box.process("twin").stop({ graceMs: 100 });
  } finally {
    await box.destroy();
  }
});

test("concurrent start() calls with one name on a stream-mode provider launch only one process", async () => {
  const box = await createSandbox(memory());

  try {
    const results = await Promise.allSettled([
      box.start("sleep 5", { name: "twin" }),
      box.start("sleep 5", { name: "twin" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "invalid_argument" }),
      }),
    ]);
    await box.process("twin").stop({ graceMs: 100 });
  } finally {
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

test("wait() gives up at its deadline or on abort instead of polling forever", async () => {
  await using box = await createSandbox(memory());
  const process = await box.start("sleep 30", { name: "never-exits" });

  const started = Date.now();
  await expect(process.wait({ timeoutMs: 150 })).rejects.toMatchObject({
    code: "timeout",
    retryable: true,
    message: expect.stringContaining("still running"),
  });
  expect(Date.now() - started).toBeLessThan(2_000);

  const controller = new AbortController();
  const waiting = process.wait({ signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await expect(waiting).rejects.toMatchObject({ code: "aborted" });

  await expect(process.wait({ timeoutMs: 0 })).rejects.toMatchObject({
    code: "invalid_argument",
  });

  // Neither error stopped the process.
  expect(await box.files.exists("/tmp/.sandbox-sdk/procs/never-exits/exit")).toBe(false);
  await process.stop({ graceMs: 0 });
  expect(await process.wait({ timeoutMs: 5_000 })).toMatchObject({ exitCode: 143 });
});

test("the guest copy of the redaction program is removed when the process exits", async () => {
  await using box = await createSandbox(await shellProvider(), {
    secrets: { TOKEN: "s3cr3t-token" },
  });

  const sed = "/tmp/.sandbox-sdk/procs/print-token/redact.sed";

  const process = await box.start("echo $TOKEN", { name: "print-token" });
  await process.wait({ timeoutMs: 10_000 });

  expect((await process.logs()).text).toBe("[REDACTED]\n");
  expect(await box.files.exists(sed)).toBe(false);
});

test("wait() bounds stalled secret recovery and redacts secrets in wait errors", async () => {
  const provider = memory();

  await using box = await createSandbox(provider, { secrets: { TOKEN: "s3cr3t-wait-name" } });
  const running = await box.start("sleep 30", { name: "s3cr3t-wait-name" });

  try {
    let timedErr: unknown;

    try {
      await running.wait({ timeoutMs: 10 });
    } catch (error) {
      timedErr = error;
    }

    expect(timedErr).toMatchObject({
      code: "timeout",
      provider: provider.name,
      sandboxId: box.id,
    });
    expect(String(timedErr)).not.toContain("s3cr3t-wait-name");

    const attached = await connectSandbox(provider, box.id);
    provider.readSecretEnvironment = () => new Promise(() => {});

    try {
      const reattachedProc = attached.process("s3cr3t-wait-name");
      const started = Date.now();
      let reattachedTimed: unknown;

      try {
        await reattachedProc.wait({ timeoutMs: 25 });
      } catch (error) {
        reattachedTimed = error;
      }

      expect(reattachedTimed).toMatchObject({ code: "timeout" });
      expect(String(reattachedTimed)).not.toContain("s3cr3t-wait-name");
      expect(Date.now() - started).toBeLessThan(1_000);

      let reattachedAborted: unknown;

      try {
        await reattachedProc.wait({ signal: AbortSignal.abort() });
      } catch (error) {
        reattachedAborted = error;
      }

      expect(reattachedAborted).toMatchObject({ code: "aborted" });
      expect(String(reattachedAborted)).not.toContain("s3cr3t-wait-name");
    } finally {
      await attached.close();
    }
  } finally {
    await running.stop({ graceMs: 0 });
  }
});

test("wait() handles delays >= 2^31 ms without timer overflow and shares stream start reservations across handles", async () => {
  const provider = memory();
  await using box = await createSandbox(provider);
  const running = await box.start("sleep 30", { name: "long-wait" });

  try {
    const controller = new AbortController();
    const pending = running.wait({ timeoutMs: 2 ** 31, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });

    const secondHandle = await connectSandbox(provider, box.id);

    try {
      const results = await Promise.allSettled([
        box.start("sleep 30", { name: "shared-stream" }),
        secondHandle.start("sleep 30", { name: "shared-stream" }),
      ]);

      expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    } finally {
      await secondHandle.close();
    }
  } finally {
    await running.stop({ graceMs: 0 });
  }
});

test("Redactor blocks marker-boundary secret bypasses and redacts error metadata", async () => {
  const provider = memory();

  await using box = await createSandbox(provider, {
    secrets: {
      OVERLAP: "TED]XYZ",
      PROV: provider.name,
    },
  });

  const baseExec = provider.exec.bind(provider);

  provider.exec = async () => {
    throw new SandboxError("native failure: [REDACTED]XYZ", { code: "provider" });
  };

  let caught: unknown;

  try {
    await box.run("echo hi");
  } catch (error) {
    caught = error;
  } finally {
    provider.exec = baseExec;
  }

  if (!(caught instanceof SandboxError)) throw new Error("expected SandboxError");

  expect(caught.message).not.toContain("TED]XYZ");
  expect(caught.provider).toBe("[REDACTED]");
});

test("fresh-handle wait preserves provider timeouts, closed errors, and withholds unrecovered failures", async () => {
  const provider = memory();

  await using box = await createSandbox(provider, {
    secrets: { SECRET_WAIT: "secret-wait-value" },
  });

  const running = await box.start("sleep 30", { name: "wait-edge" });

  try {
    // 1. Provider timeout during polling is preserved instead of rewritten as wait deadline expiry.
    const connected = await connectSandbox(provider, box.id);
    const proc = connected.process("wait-edge");
    const baseStat = provider.files.stat.bind(provider.files);
    let statCalls = 0;

    provider.files.stat = async (id: string, path: string) => {
      statCalls += 1;

      if (statCalls >= 2)
        throw new SandboxError("provider stat HTTP timeout", { code: "timeout", retryable: true });

      return baseStat(id, path);
    };

    try {
      let caught: unknown;

      try {
        await proc.wait({ timeoutMs: 600_000 });
      } catch (error) {
        caught = error;
      }

      if (!(caught instanceof SandboxError)) throw new Error("expected SandboxError");

      expect(caught).toMatchObject({ code: "timeout" });
      expect(caught.message).not.toContain("did not exit within 600000 ms");
    } finally {
      provider.files.stat = baseStat;
      await connected.close();
    }

    // 2. Closed handle error before recovery is rethrown directly, not disguised as recovery failure.
    const closedHandle = await connectSandbox(provider, box.id);
    const closedProc = closedHandle.process("wait-edge");
    await closedHandle.close();

    await expect(closedProc.wait({ timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("Sandbox handle is closed"),
    });

    // 3. Unrecovered secret-recovery failure is withheld with provider "unknown" and no sandboxId.
    const failing = await connectSandbox(provider, box.id);
    const failingProc = failing.process("wait-edge");
    const baseReadSecret = provider.readSecretEnvironment?.bind(provider);

    provider.readSecretEnvironment = async () => {
      throw new SandboxError("raw failure leaking secret-wait-value", {
        code: "unavailable",
        retryable: true,
        provider: provider.name,
        sandboxId: box.id,
      });
    };

    try {
      let withheld: unknown;

      try {
        await failingProc.wait({ timeoutMs: 1_000 });
      } catch (error) {
        withheld = error;
      }

      if (!(withheld instanceof SandboxError)) throw new Error("expected SandboxError");

      expect(withheld).toMatchObject({ code: "unavailable", provider: "unknown" });
      expect(withheld.sandboxId).toBeUndefined();
      expect(withheld.message).not.toContain("secret-wait-value");
    } finally {
      provider.readSecretEnvironment = baseReadSecret;
      await failing.close();
    }
  } finally {
    await running.stop({ graceMs: 0 });
  }
});

test("restart() shares cross-handle stream reservations with concurrent start()", async () => {
  const provider = memory();
  await using box1 = await createSandbox(provider);
  const proc = await box1.start("sleep 30", { name: "restart-race" });
  const box2 = await connectSandbox(provider, box1.id);

  try {
    await proc.stop({ graceMs: 0 });

    const results = await Promise.allSettled([
      proc.restart(),
      box2.start("sleep 30", { name: "restart-race" }),
    ]);

    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1);
  } finally {
    await box1
      .process("restart-race")
      .stop({ graceMs: 0 })
      .catch(() => {});
    await box2.close();
  }
});

test("redactionSedScript redacts overlapping, marker-substring, and control-byte secrets through real sed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-sdk-sed-"));

  try {
    const runSed = (secrets: string[], input: string) => {
      const scriptPath = join(dir, "redact.sed");
      writeFileSync(scriptPath, redactionSedScript(secrets), "utf8");

      return execFileSync("sed", ["-f", scriptPath], { input, encoding: "utf8" });
    };

    expect(runSed(["D", "R", "]["], "alpha D beta R gamma ][ [REDACTED]")).toBe(
      "alpha [REDACTED] beta [REDACTED] gamma [REDACTED] [REDACTED]",
    );
    expect(runSed(["TOKEN1", "ACT"], "x TOKEN1 y ACT z [REDACTED]")).toBe(
      "x [REDACTED] y [REDACTED] z [REDACTED]",
    );
    expect(runSed(["ED]Z", "hunter2"], "a hunter2Z b [REDACTED]Z c")).toBe(
      "a [REDACTED] b [REDACTED] c",
    );
    expect(runSed(["D]x"], "[REDACTED]x")).toBe("[REDACTED]");
    expect(runSed(["]["], "[REDACTED][x")).toBe("[REDACTED]x");
    expect(runSed(["A[REDACTED]"], "A[REDACTED]")).toBe("[REDACTED]");
    expect(runSed(["short", "short\nlonger-secret"], "longer-secret")).toBe("[REDACTED]");
    expect(runSed(["R"], "keep\u001eR\u001eend")).toBe("keep\u001e[REDACTED]\u001eend");
    expect(runSed(["R", "x\u001ey"], "pre [REDACTED] x\u001ey R post")).toBe(
      "pre [REDACTED] [REDACTED] [REDACTED] post",
    );
    expect(runSed(["]["], "[REDACTED][REDACTED]")).toBe("[REDACTED]");
    expect(runSed(["A[REDACTED]B[REDACTED]C"], "x A[REDACTED]B[REDACTED]C y")).toBe(
      "x [REDACTED] y",
    );
    expect(runSed(["A[REDACTED]B[REDACTED]C"], "x A[REDACTED]B\n[REDACTED]C y")).toBe(
      "x [REDACTED]\n[REDACTED] y",
    );
    expect(runSed(["a|b"], "x a|b y")).toBe("x [REDACTED] y");
    expect(runSed(["sk-abc|def"], "token sk-abc|def end")).toBe("token [REDACTED] end");
    expect(runSed(["|"], "a|b")).toBe("a[REDACTED]b");
    expect(runSed(["A|B[REDACTED]C"], "qA|B[REDACTED]Cq")).toBe("q[REDACTED]q");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stream-mode failed start cleans up spec.json for retry and processes() ignores empty leftover dirs", async () => {
  const provider = memory();
  await using box = await createSandbox(provider);

  const originalStart = provider.startProcess?.bind(provider);
  let failOnce = true;

  provider.startProcess = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("boom");
    }

    if (!originalStart) throw new Error("missing startProcess");

    return originalStart(...args);
  };

  await expect(box.start("sleep 30", { name: "retry-stream" })).rejects.toThrow("boom");
  expect(await box.files.exists("/tmp/.sandbox-sdk/procs/retry-stream/spec.json")).toBe(false);
  expect(await box.processes()).toEqual([]);

  const proc = await box.start("sleep 30", { name: "retry-stream" });

  try {
    expect((await box.processes()).map((entry) => entry.name)).toEqual(["retry-stream"]);
  } finally {
    await proc.stop({ graceMs: 0 });
  }
});

test("non-stream startProcess stops hook, clears native entry, and marks status failed on launch failure", async () => {
  const base = await shellProvider();

  const originalWrite = base.files.write.bind(base.files);
  let stopped = 0;
  let failPidOnce = true;
  let failStartOnce = false;

  const provider = {
    ...base,
    files: { ...base.files },
    async startProcess() {
      if (failStartOnce) {
        failStartOnce = false;
        throw new Error("start-launch-failed");
      }

      let resolveWait!: (value: { exitCode: number; signal: string | null }) => void;

      const done = new Promise<{ exitCode: number; signal: string | null }>((resolve) => {
        resolveWait = resolve;
      });

      return {
        pid: process.pid,
        async stop() {
          stopped += 1;
          resolveWait({ exitCode: 0, signal: null });
        },
        wait: () => done,
      };
    },
  };

  provider.files.write = async (sandboxId, path, content, options) => {
    if (failPidOnce && path.endsWith("/pid")) {
      failPidOnce = false;
      throw new Error("pid-write-failed");
    }

    return originalWrite(sandboxId, path, content, options);
  };

  await using box = await createSandbox(provider);

  await expect(box.start("sleep 30", { name: "pid-fail" })).rejects.toThrow("pid-write-failed");
  expect(stopped).toBe(1);
  expect(await box.files.exists("/tmp/.sandbox-sdk/procs/pid-fail/spec.json")).toBe(false);

  const retry = await box.start("sleep 30", { name: "pid-fail" });

  try {
    expect((await box.processes()).map((entry) => entry.name)).toEqual(["pid-fail"]);

    failStartOnce = true;
    await expect(retry.restart()).rejects.toThrow("start-launch-failed");
    expect(retry.status).toBe("failed");
  } finally {
    await retry.stop({ graceMs: 0 }).catch(() => {});
  }
});
