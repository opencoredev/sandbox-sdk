import { vi, test, expect, afterAll } from "vitest";

import * as mock from "./e2b-sdk-mock.js";
import { e2b } from "./e2b-sdk-mock.js";
import { createSandbox, connectSandbox, listSandboxes, reapSandboxes } from "../src/index.js";
import { runConformance } from "../src/testing.js";

const {
  calls,
  cleanupMock,
  mockFetch,
  listQueries,
  delayCreation,
  MockSandbox,
  reconnects,
  delayCommandStart,
} = mock;

const originalFetch = globalThis.fetch;

vi.stubGlobal("fetch", mockFetch(originalFetch));

afterAll(async () => {
  await cleanupMock();
  vi.unstubAllGlobals();
});

// live:true enables the Linux/git/HTTP tests. The fixture confines all E2B I/O to
// the local fixture; this suite never contacts E2B, even if keys are present.
runConformance(() => e2b({ apiKey: "mock" }), { live: true });

test("metadata lookup paginates, labels survive and native is the sandbox", async () => {
  const provider = e2b({ apiKey: "mock", template: "custom", domain: "example.test" });

  const box = await createSandbox(provider, {
    key: "key",
    labels: { app: "test" },
    env: { HELLO: "world" },
  });

  try {
    expect(box.native).toBeInstanceOf(MockSandbox);
    expect(calls.at(-1)).toMatchObject({
      template: "custom",
      options: {
        apiKey: "mock",
        domain: "example.test",
        envs: { HELLO: "world" },
        metadata: { "sandbox-sdk": "1", "sandbox-sdk-key": "key", app: "test" },
      },
    });
    const fresh = e2b({ apiKey: "mock" });
    expect((await createSandbox(fresh, { key: "key" })).id).toBe(box.id);
    expect(listQueries.at(-1)).toMatchObject({
      query: { metadata: { "sandbox-sdk": "1", "sandbox-sdk-key": "key" } },
    });
    expect((await listSandboxes(fresh, { labels: { app: "test" } }))[0]?.labels).toEqual({
      "sandbox-sdk": "1",
      app: "test",
    });
  } finally {
    await box.destroy();
  }
});

test("network rules are enforced at creation and sizes/idle fail closed", async () => {
  for (const network of ["none", { allow: ["registry.npmjs.org"] }] as const) {
    const box = await createSandbox(e2b({ apiKey: "mock" }), {
      network: network === "none" ? network : { allow: [...network.allow] },
    });

    expect(calls.at(-1)?.options).toMatchObject(
      network === "none"
        ? { allowInternetAccess: false }
        : { network: { denyOut: ["0.0.0.0/0"], allowOut: ["registry.npmjs.org"] } },
    );
    await box.destroy();
  }

  for (const size of ["small", "medium", "large", { cpu: 2, memoryMb: 512, diskGb: 1 }] as const)
    await expect(createSandbox(e2b({ apiKey: "mock" }), { size })).rejects.toMatchObject({
      code: "unsupported",
    });
  await expect(
    createSandbox(e2b({ apiKey: "mock" }), { idleTimeoutMs: 1000 }),
  ).rejects.toMatchObject({ code: "unsupported" });
});

test("pause/resume and snapshot restore files through a new adapter", async () => {
  const provider = e2b({ apiKey: "mock" });
  const box = await createSandbox(provider);

  try {
    await box.files.write("state", "saved");
    const snapshot = await box.snapshot();
    await box.pause();
    expect((await provider.list({})).find((item) => item.id === box.id)?.state).toBe("paused");
    await box.resume();
    expect(await box.files.read("state")).toBe("saved");
    const restored = await createSandbox(e2b({ apiKey: "mock" }), { from: snapshot.id });

    try {
      expect(await restored.files.read("state")).toBe("saved");
    } finally {
      await restored.destroy();
    }
  } finally {
    await box.destroy();
  }
});

test("timeout and abort kill descendants before delayed writes", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));

  try {
    expect(
      await box.run("(sleep .25; echo survived > child) & wait", { timeoutMs: 30 }),
    ).toMatchObject({ timedOut: true });
    const controller = new AbortController();

    const run = Promise.resolve(
      box.run("(sleep .25; echo survived > aborted-child) & wait", { signal: controller.signal }),
    );

    setTimeout(() => controller.abort(), 30);
    expect(await run).toMatchObject({ timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await box.files.exists("child")).toBe(false);
    expect(await box.files.exists("aborted-child")).toBe(false);
  } finally {
    await box.destroy();
  }
});

test("native failures become safe structured errors", async () => {
  await expect(createSandbox(e2b({ apiKey: "invalid" }))).rejects.toMatchObject({
    code: "auth",
    provider: "e2b",
  });
  await expect(createSandbox(e2b({ apiKey: "invalid" }))).rejects.not.toThrow(
    "secret-key-do-not-leak",
  );
  await expect(connectSandbox(e2b({ apiKey: "mock" }), "missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("late creation after abort is destroyed", async () => {
  delayCreation(60);
  const controller = new AbortController();

  const promise = createSandbox(e2b({ apiKey: "mock" }), {
    labels: { late: "yes" },
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 10);
  await expect(promise).rejects.toMatchObject({ code: "aborted" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  delayCreation(0);
  expect(await e2b({ apiKey: "mock" }).list({ late: "yes" })).toEqual([]);
});

test("native process wait reconnects after the local stream closes", async () => {
  const provider = e2b({ apiKey: "mock" });
  const info = await provider.create({ labels: {} });

  try {
    const process = await provider.startProcess?.(info.id, {
      command: "sleep .2; exit 7",
      cwd: "/workspace",
      env: {},
      onChunk() {},
    });

    expect(process).toBeDefined();
    await provider.close?.(info.id);
    await provider.connect(info.id);
    expect(await process?.wait()).toMatchObject({ exitCode: 7 });
    expect(reconnects.length).toBeGreaterThan(0);
  } finally {
    await provider.destroy(info.id);
  }
});

test("hard lifetime is retained across pause and fresh-client resume", async () => {
  const provider = e2b({ apiKey: "mock" });
  const info = await provider.create({ labels: {}, timeoutMs: 200 });
  await provider.pause?.(info.id);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await expect(e2b({ apiKey: "mock" }).connect(info.id)).rejects.toMatchObject({
    code: "not_found",
  });
  await provider.destroy(info.id);
});

test("unconfirmed network policy destroys the sandbox and fails closed", async () => {
  const original = MockSandbox.prototype.getInfo;

  const spy = vi
    .spyOn(MockSandbox.prototype, "getInfo")
    .mockImplementationOnce(async function (this: Awaited<ReturnType<typeof MockSandbox.lookup>>) {
      const info = await original.call(this);

      return { ...info, allowInternetAccess: undefined, network: undefined };
    });

  try {
    await expect(
      e2b({ apiKey: "mock" }).create({ labels: { unconfirmed: "yes" }, network: "none" }),
    ).rejects.toMatchObject({ code: "unsupported" });
  } finally {
    spy.mockRestore();
  }

  expect(await e2b({ apiKey: "mock" }).list({ unconfirmed: "yes" })).toEqual([]);
});

test("cancellation wins when a completed command handle arrives late", async () => {
  const provider = e2b({ apiKey: "mock" });
  const info = await provider.create({ labels: {} });
  delayCommandStart(60);

  try {
    expect(
      await provider.exec(info.id, {
        command: "true",
        cwd: "/workspace",
        env: {},
        timeoutMs: 10,
        onChunk() {},
      }),
    ).toEqual({ exitCode: null, timedOut: true });
  } finally {
    delayCommandStart(0);
    await provider.destroy(info.id);
  }
});

test("launch preserves fragmented stdout and uses no marker file requests", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));
  const run = box.native.commands.run.bind(box.native.commands);

  const command = vi.spyOn(box.native.commands, "run").mockImplementation((text, options) => {
    const stdout = options?.onStdout;

    return run(text, {
      ...options,
      onStdout: async (chunk) => {
        // Force a boundary in user stdout.
        await stdout?.(chunk.slice(0, 3));
        await stdout?.(chunk.slice(3));
      },
    });
  });

  const read = vi.spyOn(box.native.files, "read");
  const remove = vi.spyOn(box.native.files, "remove");

  try {
    const result = await box.run("printf 'hello\\n'; printf error >&2; exit 7");
    expect(result).toMatchObject({ stdout: "hello\n", stderr: "error", exitCode: 7 });
    expect(command).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  } finally {
    command.mockRestore();
    read.mockRestore();
    remove.mockRestore();
    await box.destroy();
  }
});

test("file writes create missing parents without mkdir requests", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));
  const mkdir = vi.spyOn(box.native.files, "makeDir");
  const write = vi.spyOn(box.native.files, "write");

  try {
    await box.files.write("new/nested/file", "saved");
    expect(await box.files.read("new/nested/file")).toBe("saved");
    expect(mkdir).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    mkdir.mockRestore();
    write.mockRestore();
    await box.destroy();
  }
});

test("custom hardware templates accept both names and IDs", async () => {
  for (const template of [
    "sandbox-bench-same-spec",
    "r1h7gud12rf1f6iu29r0",
    "sandbox-bench-advertised-default",
    "jwj8b58bmst9azjl2iim",
  ]) {
    const box = await createSandbox(e2b({ apiKey: "mock", template }));

    try {
      expect(calls.at(-1)?.template).toBe(template);
    } finally {
      await box.destroy();
    }
  }
});

test("shell startup stdout before the control frame is preserved", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));

  try {
    for (const script of ["echo banner", "printf banner"]) {
      await box.files.write("banner.sh", script);
      const result = await box.run("printf hello", { env: { BASH_ENV: "/workspace/banner.sh" } });
      expect(result).toMatchObject({
        stdout: script === "echo banner" ? "banner\nhello" : "bannerhello",
        exitCode: 0,
      });
    }
  } finally {
    await box.destroy();
  }
});

test("startup command disclosure cannot poison launch confirmation", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));

  try {
    await box.files.write("disclose.sh", 'printf "%s\\n" "$BASH_EXECUTION_STRING"');
    const nativeRun = box.native.commands.run.bind(box.native.commands);

    const run = vi.spyOn(box.native.commands, "run").mockImplementation((command, options) =>
      nativeRun(command, {
        ...options,
        onStdout: async (text) => {
          for (const character of text) await options?.onStdout?.(character);
        },
      }),
    );

    try {
      const result = await box.run("printf done", { env: { BASH_ENV: "/workspace/disclose.sh" } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${run.mock.calls[0]?.[0]}\ndone`);
    } finally {
      run.mockRestore();
    }

    expect((await box.run("true")).ok).toBe(true);
  } finally {
    await box.destroy();
  }
});

test("startup output cannot forge the cancellation process group", async () => {
  const provider = e2b({ apiKey: "mock" });
  const box = await createSandbox(provider);

  try {
    await box.files.write(
      "forge.sh",
      'if [[ "$BASH_EXECUTION_STRING" =~ (sandbox-sdk-pgid-[^:]+:) ]]; then printf "%s424242\\n" "${BASH_REMATCH[1]}"; fi; printf "hook\\n"',
    );
    let stdout = "";

    const process = await provider.startProcess?.(box.id, {
      command: "printf done",
      cwd: "/workspace",
      env: { BASH_ENV: "/workspace/forge.sh" },
      onChunk: (chunk) => {
        stdout += chunk.text;
      },
    });

    expect(process?.pid).not.toBe(424242);
    expect(await process?.wait()).toMatchObject({ exitCode: 0 });
    expect(stdout).toBe("hook\ndone");
  } finally {
    await box.destroy();
  }
});

test("frame-like user output survives every chunk boundary unchanged", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));
  const run = box.native.commands.run.bind(box.native.commands);

  const spy = vi.spyOn(box.native.commands, "run").mockImplementation((command, options) =>
    run(command, {
      ...options,
      onStdout: async (text) => {
        for (const character of text) await options?.onStdout?.(character);
      },
    }),
  );

  try {
    const output = "sandbox-sdk-pgid-user:bad\nsandbox-sdk-pgid-user:424242\nend";
    await box.files.write("output", output);
    expect((await box.run("cat output")).stdout).toBe(output);
  } finally {
    spy.mockRestore();
    await box.destroy();
  }
});

test("trusted native PID remains the group leader with and without an existing group", async () => {
  for (const existing of [false, true]) {
    mock.makeLaunchGroupLeader(existing);
    const provider = e2b({ apiKey: "mock" });
    const box = await createSandbox(provider);

    try {
      let stdout = "";

      const process = await provider.startProcess?.(box.id, {
        command: "printf '%s' $$",
        cwd: "/workspace",
        env: {},
        onChunk: (chunk) => {
          stdout += chunk.text;
        },
      });

      expect(await process?.wait()).toMatchObject({ exitCode: 0 });
      expect(Number(stdout)).toBe(process?.pid);
      const result = await box.run("(sleep .3; echo survived > escaped) & wait", { timeoutMs: 30 });
      expect(result.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await box.files.exists("escaped")).toBe(false);
    } finally {
      await box.destroy();
      mock.makeLaunchGroupLeader(false);
    }
  }
});

test("launch bookkeeping preserves caller environment variables", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));

  try {
    const result = await box.run('printf \'%s:%s\' "$stat" "$pgid"', {
      env: { stat: "original-stat", pgid: "original-pgid" },
    });

    expect(result.stdout).toBe("original-stat:original-pgid");
  } finally {
    await box.destroy();
  }
});

test.each(["timeout", "stop"] as const)(
  "%s before bootstrap cannot launch descendants between kill requests",
  async (mode) => {
    const provider = e2b({ apiKey: "mock" });
    const box = await createSandbox(provider);
    const run = box.native.commands.run.bind(box.native.commands);
    let leaderKilled = false;

    const spy = vi
      .spyOn(box.native.commands, "run")
      .mockImplementation(async (command, options) => {
        if (command.startsWith("set --")) {
          const handle = await run(
            `while [ ! -f /workspace/launch-gate ]; do sleep .005; done; ${command}`,
            options,
          );

          if ("kill" in handle) {
            const kill = handle.kill.bind(handle);
            vi.spyOn(handle, "kill").mockImplementation(async () => {
              const result = await kill();
              leaderKilled = true;

              return result;
            });
          }

          return handle;
        }

        if (command.startsWith("kill -KILL")) {
          // Model the adverse schedule: an early group signal sees ESRCH, then
          // bootstrap runs before the separate native-PID kill can arrive.
          const early = leaderKilled ? undefined : await run(command, options);
          await box.native.files.write("/workspace/launch-gate", "open");

          if (!leaderKilled)
            await expect
              .poll(async () => box.files.exists("child-started"), { timeout: 1000, interval: 5 })
              .toBe(true);

          return early ?? run(command, options);
        }

        return run(command, options);
      });

    try {
      const command =
        "(echo started > child-started; sleep .25; echo survived > escaped-bootstrap) & wait";

      if (mode === "timeout")
        expect((await box.run(command, { timeoutMs: 30 })).timedOut).toBe(true);
      else {
        const process = await provider.startProcess?.(box.id, {
          command,
          cwd: "/workspace",
          env: {},
          onChunk() {},
        });

        expect(process).toBeDefined();
        await process?.stop({ graceMs: 0 });
      }

      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(await box.files.exists("escaped-bootstrap")).toBe(false);
    } finally {
      spy.mockRestore();
      await box.destroy();
    }
  },
);

test("create uses one native acquisition and operations reuse its connection", async () => {
  const create = vi.spyOn(MockSandbox, "create");
  const connect = vi.spyOn(MockSandbox, "connect");
  const provider = e2b({ apiKey: "mock" });
  const box = await createSandbox(provider, { labels: { verification: "sbx57" } });

  try {
    const native = box.native;
    await box.run("printf reused");
    await box.files.write("nested/reused", "bytes");
    expect(await box.files.read("nested/reused")).toBe("bytes");
    expect(box.native).toBe(native);
    expect(create).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
  } finally {
    await box.destroy();
    create.mockRestore();
    connect.mockRestore();
  }
});

test("plain create makes no metadata, deadline or workspace request after acquisition", async () => {
  const getInfo = vi.spyOn(MockSandbox.prototype, "getInfo");
  const setTimeout = vi.spyOn(MockSandbox.prototype, "setTimeout");
  const provider = e2b({ apiKey: "mock" });
  const box = await createSandbox(provider, { timeoutMs: 60_000 });

  try {
    expect(getInfo).not.toHaveBeenCalled();
    // The fixture's native create applies its timeout once.
    expect(setTimeout).toHaveBeenCalledTimes(1);
    expect(await box.files.list("/workspace")).toEqual([]);
    expect(await box.files.stat("/workspace")).toMatchObject({ type: "directory" });
    expect((await box.run("pwd")).stdout.trim()).toBe("/workspace");
  } finally {
    await box.destroy();
    getInfo.mockRestore();
    setTimeout.mockRestore();
  }
});

test.each(["write", "mkdir", "remove", "connect", "snapshot"] as const)(
  "fresh workspace supports first %s without eager setup",
  async (operation) => {
    const provider = e2b({ apiKey: "mock" });
    const box = await createSandbox(provider);

    try {
      if (operation === "write") {
        await box.files.write("nested/first", "ok");
        expect(await box.files.read("nested/first")).toBe("ok");
      }

      if (operation === "mkdir") {
        await provider.files.mkdir(box.id, "/workspace/nested");
        expect(await box.files.list("/workspace")).toHaveLength(1);
      }

      if (operation === "remove") {
        await box.files.remove("/workspace");
        expect(await box.files.exists("/workspace")).toBe(false);

        return;
      }

      if (operation === "connect") {
        const fresh = await connectSandbox(e2b({ apiKey: "mock" }), box.id);
        expect((await fresh.run("pwd")).stdout.trim()).toBe("/workspace");
      }

      if (operation === "snapshot") {
        const saved = await box.snapshot();
        const restored = await createSandbox(e2b({ apiKey: "mock" }), { from: saved.id });

        try {
          expect(await restored.files.list("/workspace")).toEqual([]);
        } finally {
          await restored.destroy();
        }
      }

      expect((await box.run("pwd")).stdout.trim()).toBe("/workspace");
      await box.run("rmdir /workspace/nested 2>/dev/null; rm -rf /workspace");
      expect(await box.files.exists("/workspace")).toBe(false);
    } finally {
      await box.destroy();
    }
  },
);

test("fresh root lists the workspace and cannot replace it with a file", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));

  try {
    expect((await box.files.list("/")).filter((file) => file.path === "/workspace")).toHaveLength(
      1,
    );
    await expect(box.files.write("/workspace", "bad")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect((await box.run("pwd")).stdout.trim()).toBe("/workspace");
  } finally {
    await box.destroy();
  }
});

test("fresh overlapping launches keep setup until completion, including cancelled bootstrap", async () => {
  const provider = e2b({ apiKey: "mock" });
  const box = await createSandbox(provider);
  const original = box.native.commands.run.bind(box.native.commands);

  const spy = vi
    .spyOn(box.native.commands, "run")
    .mockImplementation((command, options) =>
      original(command.startsWith("set --") ? `sleep .05; ${command}` : command, options),
    );

  try {
    const first = Promise.resolve(box.run("echo first", { timeoutMs: 10 }));
    const second = Promise.resolve(box.run("pwd"));
    expect(await first).toMatchObject({ timedOut: true });
    expect((await second).stdout.trim()).toBe("/workspace");
    expect((await box.run("pwd")).stdout.trim()).toBe("/workspace");
  } finally {
    spy.mockRestore();
    await box.destroy();
  }
});

test.each(["exec", "write", "remove"] as const)(
  "reconnect preserves workspace removal after first %s",
  async (first) => {
    const box = await createSandbox(e2b({ apiKey: "mock" }));

    try {
      if (first === "exec") await box.run("rm -rf /workspace");
      else {
        if (first === "write") await box.files.write("file", "ok");
        await box.files.remove("/workspace", { recursive: true });
      }

      const fresh = e2b({ apiKey: "mock" });
      await fresh.connect(box.id);
      await expect(fresh.files.stat(box.id, "/workspace")).rejects.toMatchObject({
        code: "file_not_found",
      });
      expect(
        await fresh.exec(box.id, {
          command: "test ! -e /workspace",
          cwd: "/",
          env: {},
          timeoutMs: 1000,
          onChunk() {},
        }),
      ).toMatchObject({ exitCode: 0 });
      await expect(fresh.files.stat(box.id, "/workspace")).rejects.toMatchObject({
        code: "file_not_found",
      });
    } finally {
      await box.destroy();
    }
  },
);

test.each(["exit", "abort"] as const)(
  "first %s after deleting workspace does not leave a synthetic directory",
  async (mode) => {
    const box = await createSandbox(e2b({ apiKey: "mock" }));

    try {
      if (mode === "exit")
        expect((await box.run("rm -rf /workspace; exit 130")).exitCode).toBe(130);
      else {
        const controller = new AbortController();

        const run = box.run("rm -rf /workspace; echo removed; sleep 5", {
          signal: controller.signal,
        });

        const output = (async () => {
          for await (const chunk of run) if (chunk.text.includes("removed")) controller.abort();
        })();

        await output;
        expect((await run).timedOut).toBe(true);
      }

      expect(await box.files.exists("/workspace")).toBe(false);
      expect((await box.files.list("/")).some((file) => file.path === "/workspace")).toBe(false);
      await box.files.write("/workspace", "replacement");
      expect(await box.files.read("/workspace")).toBe("replacement");
    } finally {
      await box.destroy();
    }
  },
);

test("adopting a markerless existing workspace preserves later removal", async () => {
  const first = e2b({ apiKey: "mock" });
  const box = await createSandbox(first);

  try {
    await box.native.files.makeDir("/workspace");
    const adopted = e2b({ apiKey: "mock" });
    await adopted.connect(box.id);
    await adopted.files.remove(box.id, "/workspace", { recursive: true });
    const fresh = e2b({ apiKey: "mock" });
    await fresh.connect(box.id);
    await expect(fresh.files.stat(box.id, "/workspace")).rejects.toMatchObject({
      code: "file_not_found",
    });
  } finally {
    await box.destroy();
  }
});

test("concurrent workspace initialization cannot recreate a directory removed by the first user", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));
  const original = box.native.commands.run.bind(box.native.commands);
  let launch = 0;

  const spy = vi.spyOn(box.native.commands, "run").mockImplementation((command, options) => {
    const delay = launch++ === 0 ? ".03" : ".1";

    return original(
      command.replaceAll("mkdir -p /workspace", `sleep ${delay}; mkdir -p /workspace`),
      options,
    );
  });

  try {
    const [first, second] = await Promise.all([
      box.run("rm -rf /workspace; touch /tmp/.sandbox-sdk-deleted"),
      box.run(
        "while [ ! -e /tmp/.sandbox-sdk-deleted ]; do sleep .01; done; test ! -e /workspace",
        { cwd: "/" },
      ),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(await box.files.exists("/workspace")).toBe(false);
  } finally {
    spy.mockRestore();
    await box.destroy();
  }
});

test("paused SDK sandboxes are listed and reaped; E2B has no other stopped state", async () => {
  const provider = e2b({ apiKey: "mock" });
  const box = await createSandbox(provider, { labels: { app: "paused-e2b" } });

  try {
    await MockSandbox.pause(box.id);
    expect(await listSandboxes(e2b({ apiKey: "mock" }), { labels: { app: "paused-e2b" } })).toEqual(
      [
        expect.objectContaining({
          id: box.id,
          state: "paused",
          labels: { app: "paused-e2b", "sandbox-sdk": "1" },
        }),
      ],
    );
    expect(listQueries.at(-1)).toMatchObject({ query: { state: ["running", "paused"] } });
    expect(await reapSandboxes(e2b({ apiKey: "mock" }), { labels: { app: "paused-e2b" } })).toBe(1);
    expect(await listSandboxes(e2b({ apiKey: "mock" }), { labels: { app: "paused-e2b" } })).toEqual(
      [],
    );
  } finally {
    await box.destroy().catch(() => {});
  }
});

test("native process exits match other providers: 143 after stop, null when killed otherwise", async () => {
  const provider = e2b({ apiKey: "mock" });
  const info = await provider.create({ labels: {} });

  try {
    const startProcess = provider.startProcess;

    if (!startProcess) throw new Error("e2b has native processes");

    const stopped = await startProcess.call(provider, info.id, {
      command: "sleep 30",
      cwd: "/workspace",
      env: {},
      onChunk() {},
    });

    await stopped.stop({ graceMs: 50 });
    expect(await stopped.wait()).toEqual({ exitCode: 143, signal: null });

    const killed = await startProcess.call(provider, info.id, {
      command: "sleep 30",
      cwd: "/workspace",
      env: {},
      onChunk() {},
    });

    // The mock's PID is a real local process; killing it is a signal death without stop().
    process.kill(killed.pid, "SIGKILL");
    expect(await killed.wait()).toEqual({ exitCode: null, signal: null });
  } finally {
    await provider.destroy(info.id);
  }
});

test("a missing cwd is a failed run with the shell error on stderr, not a request error", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));

  try {
    await box.run("true");
    expect(await box.run("pwd", { cwd: "nope" })).toMatchObject({
      ok: false,
      exitCode: expect.any(Number),
      stdout: "",
      stderr: expect.stringMatching(/nope/),
    });
  } finally {
    await box.destroy();
  }
});
