import { describe, test, expect } from "vitest";
import { createSandbox, connectSandbox, reapSandboxes, SandboxError } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { Provider } from "../src/provider.js";
import type { Files } from "../src/files.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Activity markers left in the guest; none when nothing has made the runs directory yet. */
async function activeRuns(box: { files: Files }) {
  if (!(await box.files.exists("/tmp/.sandbox-sdk/runs"))) return [];

  return box.files.list("/tmp/.sandbox-sdk/runs");
}

describe("core safety guarantees", () => {
  test("secrets stay redacted across chunks, streams, causes and reconnects", async () => {
    const token = "secret-value";

    const provider = memory({
      handlers: {
        chunks({ stdout, stderr }) {
          stdout("sec");
          stderr("ERROR ");
          stdout("ret-value sec");
          stdout("ret-value");

          return 0;
        },
        fail() {
          throw new Error(`failure ${token}`, { cause: { nested: token } });
        },
      },
    });

    const box = await createSandbox(provider, { secrets: { TOKEN: token } });

    try {
      const result = await box.run("chunks");
      expect(result.stdout).toBe("[REDACTED] [REDACTED]");
      expect(result.output).not.toContain(token);
      const chunks: string[] = [];

      for await (const chunk of box.run("chunks")) chunks.push(chunk.text);
      expect(chunks.join("")).not.toContain(token);
      const connected = await connectSandbox(provider, box.id);
      expect((await connected.run("printenv TOKEN")).stdout).toBe("[REDACTED]\n");
      await expect(box.run("fail")).rejects.toMatchObject({
        message:
          "failure [REDACTED]. Provider request failed. Check the provider settings and retry.",
        code: "provider",
      });
    } finally {
      await box.destroy();
    }
  });
  test("background logs redact secrets split across native chunks", async () => {
    const provider = memory({
      handlers: {
        split({ stdout }) {
          stdout("abc");
          stdout("def\n");

          return 0;
        },
      },
    });

    const box = await createSandbox(provider, { secrets: { TOKEN: "abcdef" } });

    try {
      const process = await box.start("split", { name: "split" });
      await process.wait();
      expect((await process.logs()).text).toBe("[REDACTED]\n");
    } finally {
      await box.destroy();
    }
  });
  test("locator stale IDs recreate and concurrent keyed callers share a sandbox", async () => {
    const provider = memory();
    const entries = new Map([["key", "stale-id"]]);

    const locator = {
      get: async (key: string) => entries.get(key),
      set: async (key: string, id: string) => {
        entries.set(key, id);
      },
      delete: async (key: string) => {
        entries.delete(key);
      },
    };

    const boxes = await Promise.all(
      Array.from({ length: 10 }, () => createSandbox(provider, { key: "key", locator })),
    );

    expect(new Set(boxes.map((box) => box.id)).size).toBe(1);
    expect(boxes.filter((box) => box.created).length).toBe(1);
    await boxes[0]?.destroy();
    expect(entries.size).toBe(0);
  });
  test("best-effort exact keys require an explicit locator", async () => {
    const provider: Provider = { ...memory(), keyMode: "best-effort" };
    await expect(createSandbox(provider, { key: "x", keyMode: "exact" })).rejects.toMatchObject({
      code: "unsupported",
    });
  });
  test("late-arriving creations are destroyed after cancellation", async () => {
    const base = memory();
    const controller = new AbortController();
    let lateId = "";

    const provider: Provider = {
      ...base,
      async create(input) {
        await pause(40);
        const info = await base.create(input);
        lateId = info.id;

        return info;
      },
    };

    const pending = createSandbox(provider, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    await pause(60);
    await expect(base.connect(lateId)).rejects.toMatchObject({ code: "not_found" });
  });
  test("invalid options throw SandboxError and failed streams reject", async () => {
    const provider = memory({
      handlers: {
        broken() {
          throw new Error("broken provider");
        },
      },
    });

    const box = await createSandbox(provider);

    try {
      await expect(box.run("true", { timeoutMs: 0 })).rejects.toBeInstanceOf(SandboxError);
      await expect(
        (async () => {
          for await (const chunk of box.run("broken")) void chunk;
        })(),
      ).rejects.toBeInstanceOf(SandboxError);
      const abort = new AbortController();
      abort.abort();
      expect(await box.run("echo never", { signal: abort.signal })).toMatchObject({
        timedOut: true,
        output: "",
      });
    } finally {
      await box.destroy();
    }
  });
  test("interpolated shell operators remain data", async () => {
    const box = await createSandbox(memory());

    try {
      for (const value of [
        "x > /tmp/injected",
        "a && false",
        "$(false)",
        "a'b",
        "a\nb",
        "",
        '"quotes"',
        "a\\b",
      ])
        expect((await box.$`printf '%s' ${value}`).stdout).toBe(value);
    } finally {
      await box.destroy();
    }
  });
  test("idleOnly preserves a running process and reaps it after stop", async () => {
    const provider = memory();
    const box = await createSandbox(provider);
    await box.start("sleep 5", { name: "busy" });
    expect(await reapSandboxes(provider, { idleOnly: true })).toBe(0);
    await box.process("busy").stop();
    expect(await reapSandboxes(provider, { idleOnly: true })).toBe(1);
  });
  test("logs rotate at 10 MB with a resumable stale cursor", async () => {
    const provider = memory({
      handlers: {
        noisy({ stdout }) {
          stdout("a".repeat(6_000_000));
          stdout("b".repeat(6_000_000));

          return 0;
        },
      },
    });

    const box = await createSandbox(provider);

    try {
      const process = await box.start("noisy", { name: "noisy" });
      await process.wait();
      expect(
        (await box.files.stat("/tmp/.sandbox-sdk/procs/noisy/out.log")).size,
      ).toBeLessThanOrEqual(10_485_760);
      expect(await process.logs({ after: "0", maxBytes: 16 })).toMatchObject({
        truncated: true,
        text: "b".repeat(16),
      });
    } finally {
      await box.destroy();
    }
  });
  test("process lines preserve stderr and cursors resume each line", async () => {
    const provider = memory({
      handlers: {
        streams({ stdout, stderr }) {
          stdout("first\nsecond\n");
          stderr("error\n");

          return 0;
        },
      },
    });

    const box = await createSandbox(provider);

    try {
      const process = await box.start("streams", { name: "streams" });
      await process.wait();
      const lines = [];

      for await (const line of process.lines()) lines.push(line);
      expect(lines.map(({ text, stream }) => ({ text, stream }))).toEqual([
        { text: "first", stream: "stdout" },
        { text: "second", stream: "stdout" },
        { text: "error", stream: "stderr" },
      ]);
      const resumed = [];

      for await (const line of process.lines({ after: lines[0]?.cursor })) resumed.push(line.text);
      expect(resumed).toEqual(["second", "error"]);
    } finally {
      await box.destroy();
    }
  });
  test("fresh-client restart preserves cwd, env and readiness", async () => {
    const provider = memory({
      handlers: {
        inspect({ cwd, env, stdout }) {
          stdout(`${cwd}:${env.CUSTOM}\n`);

          return 0;
        },
      },
    });

    const box = await createSandbox(provider);

    try {
      await box.files.write("app/file", "");

      const first = await box.start("inspect", {
        name: "restart",
        cwd: "app",
        env: { CUSTOM: "value" },
      });

      await first.wait();
      const second = (await connectSandbox(provider, box.id)).process("restart");
      await second.restart();
      await second.wait();
      expect((await second.logs()).text).toBe("/workspace/app:value\n");
    } finally {
      await box.destroy();
    }
  });
  test("idle reaping leaves an in-flight command alone", async () => {
    const provider = memory();
    const box = await createSandbox(provider);
    const running = Promise.resolve(box.run("sleep 0.1"));
    await pause(20);
    expect(await reapSandboxes(provider, { idleOnly: true })).toBe(0);
    await running;
    expect(await reapSandboxes(provider, { idleOnly: true })).toBe(1);
  });

  test("compound secret restart inputs survive reattachment", async () => {
    const provider = memory({
      handlers: {
        compound({ env, stdout }) {
          stdout(env.CUSTOM ?? "missing");

          return 0;
        },
      },
    });

    const box = await createSandbox(provider, { secrets: { TOKEN: "secret-value" } });

    try {
      const first = await box.start("compound", {
        name: "compound",
        env: { CUSTOM: "prefix-secret-value-suffix" },
      });

      await first.wait();
      const second = (await connectSandbox(provider, box.id)).process("compound");
      await second.restart();
      await second.wait();
      expect((await second.logs()).text).toBe("prefix-[REDACTED]-suffix");
    } finally {
      await box.destroy();
    }
  });
  test("unfinished process lines retain at most 1 MB", async () => {
    const provider = memory({
      handlers: {
        async long({ stdout }) {
          for (let i = 0; i < 40; i++) {
            stdout("x".repeat(65536));
            await pause(1);
          }

          return 0;
        },
      },
    });

    const box = await createSandbox(provider);

    try {
      const process = await box.start("long", { name: "long" });
      const lines = [];

      for await (const line of process.lines()) lines.push(line);
      expect(Buffer.byteLength(lines[0]?.text ?? "")).toBeLessThanOrEqual(1_048_576);
      expect(lines[0]?.text).toContain("line truncated");
    } finally {
      await box.destroy();
    }
  });
  test("native exact-name races preserve created flags across adapter clients", async () => {
    const base = memory();

    const [first, second] = await Promise.all([
      createSandbox({ ...base }, { key: "race" }),
      createSandbox({ ...base }, { key: "race" }),
    ]);

    expect(first.id).toBe(second.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    await first.destroy();
  });
  test("memory honors hard lifetime", async () => {
    const provider = memory();
    const box = await createSandbox(provider, { timeoutMs: 20 });
    await pause(40);
    await expect(provider.connect(box.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

test("reaping tolerates deletion after listing and still surfaces auth failures", async () => {
  const backing = memory();
  await createSandbox(backing, { labels: { run: "race" } });

  const provider: Provider = {
    ...backing,
    destroy: async () => {
      throw new SandboxError("Already gone", { code: "not_found", provider: "memory" });
    },
  };

  expect(await reapSandboxes(provider, { labels: { run: "race" } })).toBe(1);
  await expect(
    reapSandboxes({
      ...provider,
      destroy: async () => {
        throw new SandboxError("Denied", { code: "auth", provider: "memory" });
      },
    }),
  ).rejects.toMatchObject({ code: "auth" });
});

describe("core hot paths", () => {
  for (const transport of ["memory", "shell"]) {
    test(`${transport} reconnect recovers many secrets lazily in one exec and no file RPCs`, async () => {
      const provider =
        transport === "memory"
          ? memory()
          : await (await import("./shell-provider.js")).shellProvider();

      const box = await createSandbox(provider, {
        secrets: { FIRST: "one=value\nsecond line\n", SECOND: "another-value", EMPTY: "" },
        env: { PUBLIC: "public-value" },
      });

      const calls: string[] = [];
      const exec = provider.exec;
      const read = provider.files.read;
      const stat = provider.files.stat;
      provider.exec = (id, input) => {
        calls.push("exec");

        return exec(id, input);
      };

      provider.files.read = (id, path) => {
        calls.push("read");

        return read(id, path);
      };

      provider.files.stat = (id, path) => {
        calls.push("stat");

        return stat(id, path);
      };

      try {
        const connected = await connectSandbox(provider, box.id);
        expect(calls).toEqual([]);
        expect((await connected.run("printf '%s' \"$FIRST\"")).stdout).toBe("[REDACTED]");
        expect(calls).toEqual(["exec", "exec"]);
        expect((await connected.run("printf '%s' \"$SECOND\"")).stdout).toBe("[REDACTED]");
        expect((await connected.run("printf '%s' \"$PUBLIC\"")).stdout).toBe("public-value");
        expect((await connected.run("printf '%s' \"$EMPTY\"")).stdout).toBe("");
      } finally {
        await box.destroy();
      }
    });
    test(`${transport} empty reconnect uses one exec without reading files`, async () => {
      const provider =
        transport === "memory"
          ? memory()
          : await (await import("./shell-provider.js")).shellProvider();

      const box = await createSandbox(provider);
      const calls: string[] = [];
      const exec = provider.exec;
      const read = provider.files.read;
      provider.exec = (id, input) => {
        calls.push("exec");

        return exec(id, input);
      };

      provider.files.read = (id, path) => {
        calls.push("read");

        return read(id, path);
      };

      try {
        const connected = await connectSandbox(provider, box.id);
        expect(calls).toEqual([]);
        await connected.files.exists("anything");
        await connected.run("true");
        expect(calls).toEqual(["exec", "exec"]);
      } finally {
        await box.destroy();
      }
    });
  }

  test("recovery rejects malformed records without exposing their content", async () => {
    const provider = memory();
    const box = await createSandbox(provider);

    try {
      for (const record of ["invalid-secret-record", '["TOKEN; echo injected"]', "{}"]) {
        await box.files.write("/tmp/.sandbox-sdk/secret-names.json", record);
        const connected = await connectSandbox(provider, box.id);
        await expect(connected.run("true")).rejects.toMatchObject({
          code: record === "invalid-secret-record" ? "provider" : "invalid_argument",
          message: expect.not.stringContaining(record),
        });
      }
    } finally {
      await box.destroy();
    }
  });
  test("native parent-creating writes and edits never mkdir", async () => {
    const provider = memory();
    const box = await createSandbox(provider);
    provider.files.mkdir = async () => {
      throw new Error("Unnecessary mkdir");
    };

    try {
      await box.files.write({ "nested/a": "before", "nested/b": "other" });
      await box.files.edit("nested/a", { find: "before", replace: "after" });
      expect(await box.files.read("nested/a")).toBe("after");
    } finally {
      await box.destroy();
    }
  });
  test("shell logs obtain status and a page in one exec without file RPCs", async () => {
    const provider = await (await import("./shell-provider.js")).shellProvider();
    const box = await createSandbox(provider);

    try {
      const process = await box.start("echo READY", { name: "page" });
      await process.wait();
      const calls: string[] = [];
      const exec = provider.exec;
      const read = provider.files.read;
      const stat = provider.files.stat;
      provider.exec = (id, input) => {
        calls.push("exec");

        return exec(id, input);
      };

      provider.files.read = (id, path) => {
        calls.push("read");

        return read(id, path);
      };

      provider.files.stat = (id, path) => {
        calls.push("stat");

        return stat(id, path);
      };

      expect((await process.logs()).text).toBe("READY\n");
      expect(process.status).toBe("exited");
      expect(calls).toEqual(["exec"]);
    } finally {
      await box.destroy();
    }
  });
  test("reaping never recovers secrets and avoids existence checks for present records", async () => {
    const provider = memory();
    const box = await createSandbox(provider, { secrets: { TOKEN: "secret-value" } });
    const process = await box.start("true", { name: "finished" });
    await process.wait();
    await box.run("true");
    const calls: string[] = [];
    const exec = provider.exec;
    const stat = provider.files.stat;
    provider.exec = (id, input) => {
      calls.push("exec");

      return exec(id, input);
    };

    provider.files.stat = (id, path) => {
      calls.push(`stat:${path}`);

      return stat(id, path);
    };

    expect(await reapSandboxes(provider, { idleOnly: true })).toBe(1);
    expect(calls).not.toContain("exec");
    expect(calls).not.toContain("stat:/tmp/.sandbox-sdk/procs");
    expect(calls).not.toContain("stat:/tmp/.sandbox-sdk/runs");
  });
});

describe("anonymous-pipe activity wrapper", () => {
  test("preserves stdin, exit, exec, traps, streams and the guest umask", async () => {
    const provider = await (await import("./shell-provider.js")).shellProvider();
    const box = await createSandbox(provider);

    try {
      let rawMask = "";
      await provider.exec(box.id, {
        command: "umask",
        cwd: "/workspace",
        env: {},
        timeoutMs: 1000,
        onChunk(chunk) {
          rawMask += chunk.text;
        },
      });
      expect((await box.run("umask")).stdout).toBe(rawMask);
      expect(await box.run("cat; printf err >&2; exit 7", { stdin: "input\n" })).toMatchObject({
        stdout: "input\n",
        stderr: "err",
        exitCode: 7,
      });
      expect(await box.run("exec sh -c 'printf replaced; exit 9'")).toMatchObject({
        stdout: "replaced",
        exitCode: 9,
      });
      expect(await box.run("trap 'printf trapped' EXIT; exit 3 # comment")).toMatchObject({
        stdout: "trapped",
        exitCode: 3,
      });
      expect(await box.files.list("/tmp/.sandbox-sdk/runs")).toEqual([]);
    } finally {
      await box.destroy();
    }
  });

  for (const stream of ["stdout", "stderr"]) {
    test(`keeps the guest marker until a background child's ${stream} closes`, async () => {
      const provider = await (await import("./shell-provider.js")).shellProvider();
      const box = await createSandbox(provider);

      try {
        const redirect = stream === "stderr" ? ">&2" : "";
        // The child outlives the poll below by far, so a slow shell cannot finish first.
        const running = Promise.resolve(box.run(`(sleep 1; printf LATE ${redirect}) & exit 7`));
        await expect.poll(async () => (await activeRuns(box)).length, { timeout: 900 }).toBe(1);
        // Different provider name bypasses this realm's run registry, like a second client.
        expect(
          await reapSandboxes({ ...provider, name: "independent-client" }, { idleOnly: true }),
        ).toBe(0);
        expect(await running).toMatchObject({ [stream]: "LATE", exitCode: 7 });
        expect(await box.files.list("/tmp/.sandbox-sdk/runs")).toEqual([]);
      } finally {
        await box.destroy();
      }
    });
  }

  for (const cancel of ["timeout", "abort"]) {
    test(`${cancel} kills descendants and clears activity`, async () => {
      const provider = await (await import("./shell-provider.js")).shellProvider();
      const box = await createSandbox(provider);

      try {
        const controller = new AbortController();

        const running = Promise.resolve(
          box.run("(sleep 0.2; echo escaped > escaped) & wait", {
            timeoutMs: cancel === "timeout" ? 40 : 1000,
            signal: controller.signal,
          }),
        );

        if (cancel === "abort") setTimeout(() => controller.abort(), 40);
        expect(await running).toMatchObject({ timedOut: true, exitCode: null });
        await pause(240);
        expect(await box.files.exists("escaped")).toBe(false);
        // A kill can land before the wrapper made the runs directory at all.
        expect(await activeRuns(box)).toEqual([]);
      } finally {
        await box.destroy();
      }
    });
  }
});

test("authenticated git setup uses one exec and always removes both private files", async () => {
  const provider = await (await import("./shell-provider.js")).shellProvider();
  const box = await createSandbox(provider);

  try {
    await box.run("git init --bare /tmp/sdk-bare");
    const calls: string[] = [];
    const exec = provider.exec;
    const write = provider.files.write;
    const mkdir = provider.files.mkdir;
    const remove = provider.files.remove;
    provider.exec = (id, input) => {
      calls.push(`exec:${input.command}`);

      return exec(id, input);
    };

    provider.files.write = (id, path, data) => {
      calls.push("write");

      return write(id, path, data);
    };

    provider.files.mkdir = (id, path) => {
      calls.push("mkdir");

      return mkdir(id, path);
    };

    provider.files.remove = (id, path, options) => {
      calls.push("remove");

      return remove(id, path, options);
    };

    expect((await box.git.clone("/tmp/sdk-bare", { token: "private-token" })).ok).toBe(true);
    expect(calls.filter((call) => call.startsWith("exec:")).length).toBe(2);
    expect(calls.filter((call) => call === "remove").length).toBe(2);
    expect(calls).not.toContain("write");
    expect(calls).not.toContain("mkdir");
    expect(calls.join("")).not.toContain("private-token");
    expect(
      (await box.files.list("/tmp/.sandbox-sdk")).some((entry) =>
        entry.path.includes("credential-"),
      ),
    ).toBe(false);
  } finally {
    await box.destroy();
  }
});

test("missing process logs and lines fail promptly and malformed records still fail", async () => {
  const provider = await (await import("./shell-provider.js")).shellProvider();
  const box = await createSandbox(provider);

  try {
    const started = Date.now();
    await expect(box.process("missing").logs()).rejects.toMatchObject({ code: "file_not_found" });
    await expect(
      (async () => {
        for await (const line of box.process("missing").lines()) void line;
      })(),
    ).rejects.toMatchObject({ code: "file_not_found" });
    expect(Date.now() - started).toBeLessThan(2000);
    const process = await box.start("true", { name: "invalid" });
    await process.wait();
    await box.files.write("/tmp/.sandbox-sdk/procs/invalid/spec.json", "{}");
    await expect(process.logs()).rejects.toMatchObject({ code: "invalid_argument" });
  } finally {
    await box.destroy();
  }
});

test("shell process setup uses two execs and one upload, preserving UTF-8 and duplicate restart inputs", async () => {
  const provider = await (await import("./shell-provider.js")).shellProvider();
  const box = await createSandbox(provider, { secrets: { TOKEN: "private-token" } });

  try {
    const calls: string[] = [];
    const exec = provider.exec;
    provider.exec = (id, input) => {
      calls.push(input.command);

      return exec(id, input);
    };

    const { read, write, mkdir, stat, remove } = provider.files;
    provider.files.read = (id, path) => {
      calls.push("file:read");

      return read(id, path);
    };

    provider.files.write = (id, path, data) => {
      calls.push("file:write");

      return write(id, path, data);
    };

    provider.files.mkdir = (id, path) => {
      calls.push("file:mkdir");

      return mkdir(id, path);
    };

    provider.files.stat = (id, path) => {
      calls.push("file:stat");

      return stat(id, path);
    };

    provider.files.remove = (id, path, options) => {
      calls.push("file:remove");

      return remove(id, path, options);
    };

    const process = await box.start("printf '%s' \"$CUSTOM\"", {
      name: "utf8-start",
      env: { CUSTOM: "héllo😀\nlast-private-token" },
    });

    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call === "file:write")).toHaveLength(1);
    expect(calls.join("")).not.toContain("private-token");
    await process.wait();
    expect((await process.logs()).text).toBe("héllo😀\nlast-[REDACTED]");
    const cursor = (await process.logs()).nextCursor;
    await process.restart();
    await process.wait();
    expect((await process.logs({ after: cursor })).text).toBe("héllo😀\nlast-[REDACTED]");
    // It must still be running for the duplicate start below, even on a loaded host.
    const running = await box.start("echo ORIGINAL; sleep 2", { name: "duplicate" });
    await expect(box.start("true", { name: "duplicate" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(running.status).toBe("running");
    await running.restart();
    await running.wait();
    expect((await running.logs()).text).toBe("ORIGINAL\n");
  } finally {
    await box.destroy();
  }
}, 30_000);
