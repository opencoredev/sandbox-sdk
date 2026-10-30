import { expect, test, vi } from "vitest";
import { createSandbox, reapSandboxes } from "../src/index.js";
import { shellProvider } from "./shell-provider.js";
import { memory } from "../src/memory.js";
import type { Provider } from "../src/provider.js";

function counting(provider: Provider) {
  const calls: string[] = [];

  const counted: Provider = {
    ...provider,
    exec(id, input) {
      calls.push("exec");

      return provider.exec(id, input);
    },
    files: {
      ...provider.files,
      read(id, path) {
        calls.push("read");

        return provider.files.read(id, path);
      },
      list(id, path) {
        calls.push("list");

        return provider.files.list(id, path);
      },
      stat(id, path) {
        calls.push("stat");

        return provider.files.stat(id, path);
      },
      mkdir(id, path) {
        calls.push("mkdir");

        return provider.files.mkdir(id, path);
      },
      write(id, path, data) {
        calls.push("write");

        return provider.files.write(id, path, data);
      },
      remove(id, path, options) {
        calls.push("remove");

        return provider.files.remove(id, path, options);
      },
    },
  };

  return { provider: counted, calls };
}

test.each([shellProvider, memory])(
  "run and the template tag each make exactly one provider call (%#)",
  async (factory) => {
    const { provider, calls } = counting(await factory());
    const box = await createSandbox(provider);

    try {
      calls.length = 0;
      expect(await box.run("true")).toMatchObject({ ok: true, exitCode: 0 });
      expect(calls).toEqual(["exec"]);
      calls.length = 0;
      expect(await box.$`true`).toMatchObject({ ok: true, exitCode: 0 });
      expect(calls).toEqual(["exec"]);
    } finally {
      await box.destroy();
    }
  },
);

test("idle reaping skips an in-flight run and reaps after it exits", async () => {
  const provider = await shellProvider();
  const box = await createSandbox(provider);
  const observer: Provider = { ...provider, name: "independent-shell-observer" };

  try {
    let ready = () => {};

    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const run = box.run("echo ready; sleep .4");

    const output = (async () => {
      for await (const chunk of run) if (chunk.text.includes("ready")) ready();
    })();

    await started;
    expect(await reapSandboxes(observer, { idleOnly: true })).toBe(0);
    await output;
    expect((await run).ok).toBe(true);
    expect(await reapSandboxes(observer, { idleOnly: true })).toBe(1);
  } finally {
    await box.destroy();
  }
});

test("activity cleanup preserves shell semantics, stdin, and nonzero exits", async () => {
  const provider = await shellProvider();
  const box = await createSandbox(provider);

  try {
    for (const command of [
      "exit 23",
      "exec sh -c 'exit 23'",
      "# trailing comment\nexit 23 # no newline",
    ]) {
      expect(await box.run(command)).toMatchObject({ exitCode: 23, command });
      expect(await box.files.list("/tmp/.sandbox-sdk/runs")).toEqual([]);
    }

    expect((await box.run("cat; printf '%s' \"$0:$#\"", { stdin: "input\n" })).stdout).toBe(
      "input\nsh:0",
    );
    expect(
      (
        await box.run('printf %s "$out:$err:$code"', {
          env: { out: "first", err: "second", code: "third" },
        })
      ).stdout,
    ).toBe("first:second:third");
    expect(await box.run("sleep 5", { timeoutMs: 30 })).toMatchObject({ timedOut: true });
    expect(await box.files.list("/tmp/.sandbox-sdk/runs")).toEqual([]);
  } finally {
    await box.destroy();
  }
});

test("idle reaping protects descendants that outlive their command shell", async () => {
  const provider = await shellProvider();
  const box = await createSandbox(provider);
  const observer: Provider = { ...provider, name: "independent-shell-observer" };

  try {
    let ready = () => {};

    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const run = box.run("(sleep .5; echo child) & echo ready");

    const output = (async () => {
      for await (const chunk of run) if (chunk.text.includes("ready")) ready();
    })();

    await started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await reapSandboxes(observer, { idleOnly: true })).toBe(0);
    await output;
    expect((await run).stdout).toContain("child");
    expect(await reapSandboxes(observer, { idleOnly: true })).toBe(1);
  } finally {
    await box.destroy();
  }
});

test("memory starts a fresh idle interval when a run completes", async () => {
  vi.useFakeTimers();
  const provider = memory();
  const box = await createSandbox(provider, { idleTimeoutMs: 1000 });

  try {
    const run = Promise.resolve(box.run("sleep .9"));
    await vi.advanceTimersByTimeAsync(900);
    expect((await run).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect((await provider.list({})).map((info) => info.id)).toEqual([box.id]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await provider.list({})).toEqual([]);
  } finally {
    await box.destroy();
    vi.useRealTimers();
  }
});

test("idle reaping skips a run waiting for its guest launch", async () => {
  const native = await shellProvider();
  let blocked: Promise<void> | undefined;

  const provider: Provider = {
    ...native,
    async exec(id, input) {
      await blocked;

      return native.exec(id, input);
    },
  };

  const box = await createSandbox(provider);
  let release = () => {};

  blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = Promise.resolve(box.run("true"));

  try {
    await Promise.resolve();
    expect(await reapSandboxes(provider, { idleOnly: true })).toBe(0);
    release();
    expect((await run).ok).toBe(true);
    expect(await reapSandboxes(provider, { idleOnly: true })).toBe(1);
  } finally {
    release();
    await run.catch(() => {});
    await box.destroy();
  }
});

test("a user signal that kills the wrapper cannot strand activity", async () => {
  const provider = await shellProvider();
  const box = await createSandbox(provider);

  try {
    expect((await box.run("kill -KILL 0")).ok).toBe(false);
    expect(await box.files.list("/tmp/.sandbox-sdk/runs")).toEqual([]);
  } finally {
    await box.destroy();
  }
});
