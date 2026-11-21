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

test("detached process logs redact secrets longer than 512 bytes split across 4 KB reader chunks", async () => {
  const secret = "LONG_" + "S".repeat(590) + "MIDDLE" + "Q".repeat(590) + "_END";
  const provider = await shellProvider();

  await using box = await createSandbox(provider, { secrets: { BIG: secret } });

  const proc = await box.start(
    `node -e "process.stdout.write('x'.repeat(3500) + process.env.BIG + 'y'.repeat(200) + '\\n')"`,
    { name: "big-secret-split" },
  );

  await proc.wait();

  const full = await proc.logs();
  const paged = await proc.logs({ maxBytes: 4100 });
  const rawLog = await box.files.read("/tmp/.sandbox-sdk/procs/big-secret-split/out.log");

  expect(full.text).toContain("[REDACTED]");
  expect(full.text).not.toContain("LONG_SSSS");
  expect(full.text).not.toContain("QQQQ_END");
  expect(paged.text).not.toContain("LONG_SSSS");
  expect(paged.text).not.toContain("QQQQ_END");
  expect(rawLog).not.toContain("LONG_SSSS");
  expect(rawLog).not.toContain("QQQQ_END");
  expect(await box.files.exists("/tmp/.sandbox-sdk/procs/big-secret-split/redact.txt")).toBe(false);
});

test("detached process with >512-byte secret flushes non-secret partial lines immediately for log readiness", async () => {
  const secret = "S600_" + "Z".repeat(595);
  const provider = await shellProvider();

  await using box = await createSandbox(provider, { secrets: { BIG: secret } });

  const startedAt = Date.now();

  const proc = await box.start("printf 'Listening on :3000'; sleep 10", {
    name: "big-secret-ready",
    ready: { log: /Listening on :3000/ },
    readyTimeoutMs: 5_000,
  });

  try {
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    const logs = await proc.logs();
    expect(logs.text).toContain("Listening on :3000");
  } finally {
    await proc.stop({ graceMs: 0 }).catch(() => {});
  }

  expect(await box.files.exists("/tmp/.sandbox-sdk/procs/big-secret-ready/redact.txt")).toBe(false);
});

test("detached process redacts >512-byte secret overlapping shorter secret and left-marker secret across 4 KiB boundary", async () => {
  const shortSecret = "OVERLAP_SHORT_KEY";
  const longSecret = `${shortSecret}_${"L".repeat(1180)}_TAIL`;
  const markerSecret = "LEADX[REDACTED]TAILY";
  const provider = await shellProvider();

  await using box = await createSandbox(provider, {
    secrets: { SHORT: shortSecret, LONG: longSecret, MARKER: markerSecret },
  });

  const pad = "A".repeat(4096 - 300);

  const proc = await box.start(
    `printf '%s' "${pad}${longSecret}" && printf '\\n' && printf '%s' "${"B".repeat(4096 - 305)}LEADX${longSecret}TAILY"`,
    { name: "overlap-boundary" },
  );

  await proc.wait();

  const full = await proc.logs();
  const rawLog = await box.files.read("/tmp/.sandbox-sdk/procs/overlap-boundary/out.log");

  expect(full.text).toContain("[REDACTED]");
  expect(full.text).not.toContain("OVERLAP_SHORT_KEY");
  expect(full.text).not.toContain("LLLLLLLL");
  expect(full.text).not.toContain("_TAIL");
  expect(full.text).not.toContain("LEADX");
  expect(full.text).not.toContain("TAILY");
  expect(rawLog).not.toContain("OVERLAP_SHORT_KEY");
  expect(rawLog).not.toContain("LLLLLLLL");
  expect(rawLog).not.toContain("LEADX");
  expect(rawLog).not.toContain("TAILY");

  // Calling stop() on an already-exited process still cleans leftover redact artifacts.
  await box.files.write("/tmp/.sandbox-sdk/procs/overlap-boundary/redact.sed", "dummy");
  await box.files.write("/tmp/.sandbox-sdk/procs/overlap-boundary/redact.txt", "dummy");
  await proc.stop();
  expect(await box.files.exists("/tmp/.sandbox-sdk/procs/overlap-boundary/redact.sed")).toBe(false);
  expect(await box.files.exists("/tmp/.sandbox-sdk/procs/overlap-boundary/redact.txt")).toBe(false);
});

test("streaming redactor holds longer secret raw when an inner shorter secret appears across chunks", async () => {
  const shortSecret = "a_";
  const longSecret = "c-bXZ1-_X0-0ZYa_Z";
  const prefixShort = "PREF_SHORT";
  const prefixLong = "PREF_SHORT_EXTENDED_SECRET";
  const provider = await shellProvider();

  await using box = await createSandbox(provider, {
    secrets: {
      SHORT: shortSecret,
      LONG: longSecret,
      PSHORT: prefixShort,
      PLONG: prefixLong,
      AB: "AB",
      BA: "BA",
      MARK: "X[REDACTED]Y",
      INNER: "ab",
      OUTER: "abC",
    },
  });

  // Nested shorter secret inside a longer secret split right before the final byte.
  const nested = await box.run(`printf 'lead c-bXZ1-_X0-0ZYa_'; sleep 0.05; printf 'Z tail\\n'`);

  expect(nested.stdout).toBe("lead [REDACTED] tail\n");
  expect(nested.output).toBe("lead [REDACTED] tail\n");

  // Strict prefix secret split before the longer secret's tail.
  const strictPref = await box.run(`printf 'PREF_SHORT'; sleep 0.05; printf '_EXTENDED_SECRET\\n'`);

  expect(strictPref.stdout).toBe("[REDACTED]\n");
  expect(strictPref.output).toBe("[REDACTED]\n");

  // Complete match overlapping the start of another secret must not split or leak.
  const overlapPair = await box.run(`printf 'AB'; sleep 0.05; printf '!\\n'`);
  expect(overlapPair.stdout).toBe("[REDACTED]!\n");

  // Marker-adjacent prefix before a held raw nested secret must not emit early and leak X[REDACTED]Y.
  const markerNested = await box.run(`printf 'Xab'; sleep 0.05; printf 'Y\\n'`);
  expect(markerNested.stdout).toBe("[REDACTED]\n");
});

test("streaming redaction matches single-chunk output across overlapping marker-around secrets", async () => {
  const provider = await shellProvider();

  await using box = await createSandbox(provider, {
    secrets: { A: "[REDACTED]bab", B: "Y[REDACTED]Y" },
  });

  const one = await box.run(`printf 'Y[REDACTED]Y[REDACTED]babY'`);
  const two = await box.run(`printf 'Y[REDACTED]Y'; sleep 0.05; printf '[REDACTED]babY'`);

  expect(one.stdout).toBe("[REDACTED]");
  expect(two.stdout).toBe("[REDACTED]");
  expect(two.output).toBe("[REDACTED]");
});

test("detached process redacts >512-byte secrets wrapped across newlines", async () => {
  const longSecret = `W${"K".repeat(1198)}Z`;
  const provider = await shellProvider();

  await using box = await createSandbox(provider, {
    secrets: { LONG: longSecret },
  });

  // Single write split 600 + "\n" + 600.
  await box.files.write(
    "/workspace/wrap1.txt",
    `${longSecret.slice(0, 600)}\n${longSecret.slice(600)}\n`,
  );

  const p1 = await box.start("cat /workspace/wrap1.txt", { name: "wrap-one-write" });
  await p1.wait();
  const l1 = await p1.logs();

  expect(l1.text).toBe("[REDACTED]\n[REDACTED]\n");
  expect(l1.text).not.toContain("KKKKKK");

  // Two separate writes split across a newline.
  await box.files.write("/workspace/wrap2a.txt", `${longSecret.slice(0, 600)}\n`);
  await box.files.write("/workspace/wrap2b.txt", `${longSecret.slice(600)}\n`);

  const p2 = await box.start("cat /workspace/wrap2a.txt; sleep 0.1; cat /workspace/wrap2b.txt", {
    name: "wrap-two-writes",
  });

  await p2.wait();
  const l2 = await p2.logs();

  expect(l2.text).toBe("[REDACTED]\n[REDACTED]\n");
  expect(l2.text).not.toContain("KKKKKK");
});

test("detached process bounds repeated left-marker carry and paginates logs cleanly", async () => {
  const longSecret = `W${"k".repeat(1100)}V`;
  const provider = await shellProvider();

  await using box = await createSandbox(provider, {
    secrets: { MARKER: "LEADX[REDACTED]TAILY", LONG: longSecret },
  });

  const payload = "LEADX".repeat(20_000) + longSecret.slice(0, 500);
  await box.files.write("/workspace/a.bin", payload);
  await box.files.write("/workspace/b.bin", "!\nafter\n");

  const startedAt = Date.now();

  const proc = await box.start("cat /workspace/a.bin; sleep 0.1; cat /workspace/b.bin", {
    name: "bounded-carry",
  });

  await proc.wait();
  expect(Date.now() - startedAt).toBeLessThan(10_000);

  // Paging must always advance and terminate without stalling on an oversized record.
  let cursor: string | undefined;
  let combined = "";
  let pages = 0;

  while (pages < 50) {
    const page = await proc.logs({ after: cursor, maxBytes: 16_384 });
    pages += 1;
    combined += page.text;

    if (!page.truncated) break;
    expect(page.nextCursor).not.toBe(cursor);
    cursor = page.nextCursor;
  }

  expect(pages).toBeLessThan(50);
  expect(combined).toContain("after\n");
  expect(combined.length).toBeGreaterThan(90_000);
});

test("non-stream restart sets handle status to failed when setup exec throws", async () => {
  const base = await shellProvider();
  const originalExec = base.exec.bind(base);
  let failNextSetup = false;

  const provider = {
    ...base,
    exec: async (...args: Parameters<typeof base.exec>) => {
      if (failNextSetup && args[1].command.includes("spec.json")) {
        failNextSetup = false;
        throw new Error("setup-exec-boom");
      }

      return originalExec(...args);
    },
  };

  await using box = await createSandbox(provider);
  const proc = await box.start("echo hi", { name: "setup-throw" });
  await proc.wait();
  expect(proc.status).toBe("exited");

  failNextSetup = true;
  await expect(proc.restart()).rejects.toThrow("setup-exec-boom");
  expect(proc.ready).toBe(false);
  expect(proc.status).toBe("failed");
});

test("carry-window detached reader preserves standalone blank lines when a secret exceeds 512 bytes", async () => {
  const longSecret = `BLANK${"K".repeat(590)}TAIL`;
  const provider = await shellProvider();

  await using box = await createSandbox(provider, {
    secrets: { LONG: longSecret },
  });

  const proc = await box.start(`printf 'a\\n'; sleep 0.1; printf '\\n'; sleep 0.1; printf 'b\\n'`, {
    name: "blank-lines",
  });

  await proc.wait();
  const logs = await proc.logs();
  expect(logs.text).toBe("a\n\nb\n");
});

test("carry-window detached reader redacts repetitive >512B secrets wrapped across 3+ lines without trailing newline", async () => {
  const periodic = Array.from(
    { length: 1200 },
    (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[i % 36],
  ).join("");

  const constant = "k".repeat(1200);
  const provider = await shellProvider();

  await using box = await createSandbox(provider, {
    secrets: { PERIODIC: periodic, CONSTANT: constant },
  });

  const procPeriodic = await box.start(`printf '%s' "$PERIODIC" | fold -w 80`, {
    name: "wrap-periodic",
  });

  await procPeriodic.wait();
  const periodicLogs = await procPeriodic.logs();
  expect(periodicLogs.text).toContain("[REDACTED]");
  expect(periodicLogs.text.replaceAll("\n", "")).not.toContain(periodic.slice(0, 80));
  expect(periodicLogs.text.replaceAll("\n", "")).not.toContain(periodic.slice(400, 480));

  const procConstant = await box.start(`printf '%s' "$CONSTANT" | fold -w 80`, {
    name: "wrap-constant",
  });

  await procConstant.wait();
  const constantLogs = await procConstant.logs();
  expect(constantLogs.text).toContain("[REDACTED]");
  expect(constantLogs.text.replaceAll("\n", "")).not.toContain("k".repeat(80));
});
