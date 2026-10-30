// Provider extensions (`box.ext`), the provider-level capabilities (`deleteSnapshot`, `buildTemplate`),
// terminal wrapping, native file watching and usage metrics, against memory() and small stub providers.
import { describe, expect, test } from "vitest";
import {
  buildTemplate,
  connectSandbox,
  createSandbox,
  deleteSnapshot,
  hasCapability,
  SandboxError,
} from "../src/index.js";
import { memory } from "../src/memory.js";
import type {
  FileEvent,
  Provider,
  TemplateBuildOptions,
  TemplateSpec,
  Terminal,
  TerminalOptions,
} from "../src/provider.js";
import { rejection } from "./rejection.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A provider chosen at runtime: the compiler knows only the Provider contract. */
const runtime = (provider: Provider): Provider => provider;

describe("extensions", () => {
  test("bind lazily, once, to the sandbox, and are empty for providers without any", async () => {
    const base = memory();
    let factories = 0;

    const provider: Provider<
      ReturnType<typeof base.native>,
      "network-policy",
      { demo: { whoami(): Promise<string> } }
    > = {
      ...base,
      extensions: {
        demo(id) {
          factories++;

          return { whoami: async () => `sandbox ${id}` };
        },
      },
    };

    const box = await createSandbox(provider);
    expect(factories).toBe(0);
    expect(await box.ext.demo.whoami()).toBe(`sandbox ${box.id}`);
    expect(await box.ext.demo.whoami()).toBe(`sandbox ${box.id}`);
    expect(factories).toBe(1);
    expect(Object.keys(box.ext)).toEqual(["demo"]);
    await box.destroy();

    const plain = await createSandbox(memory());
    expect(plain.ext).toEqual({});
    await plain.destroy();
  });

  test("errors are redacted SandboxErrors, and a closed handle refuses every call", async () => {
    const secret = "extension-secret-value";
    const base = memory();

    const provider: Provider<
      ReturnType<typeof base.native>,
      "network-policy",
      { demo: { fail(): Promise<void> } }
    > = {
      ...base,
      extensions: {
        demo: () => ({
          async fail() {
            throw new Error(`upstream said ${secret}`);
          },
        }),
      },
    };

    const box = await createSandbox(provider, { secrets: { TOKEN: secret } });
    const error = await rejection(box.ext.demo.fail());
    expect(error).toBeInstanceOf(SandboxError);
    expect(`${error.message} ${String(error.cause)}`).not.toContain(secret);

    const methods = box.ext.demo;
    await box.close();
    await expect(methods.fail()).rejects.toMatchObject({ code: "not_found" });
    expect(() => box.ext.demo).toThrow(SandboxError);
  });

  test("methods keep their object as this", async () => {
    const base = memory();

    const provider: Provider<
      unknown,
      "network-policy",
      { demo: { one(): Promise<number>; two(): Promise<number> } }
    > = {
      ...base,
      extensions: {
        demo: () => ({
          async one() {
            return 1;
          },
          async two() {
            return (await this.one()) + 1;
          },
        }),
      },
    };

    const box = await createSandbox(provider);
    expect(await box.ext.demo.two()).toBe(2);
    await box.destroy();
  });

  test("a reconnected handle recovers secrets before redacting an extension error", async () => {
    const secret = "recorded-secret-value";
    const base = memory();
    let calls = 0;

    const provider: Provider<unknown, "network-policy", { demo: { fail(): Promise<void> } }> = {
      ...base,
      extensions: {
        demo: () => ({
          async fail() {
            calls++;
            throw new Error(`upstream echoed ${secret}`);
          },
        }),
      },
    };

    const created = await createSandbox(provider, {
      key: "ext-recovery",
      secrets: { TOKEN: secret },
    });

    await created.close();

    // No secrets passed: the handle only learns TOKEN by reading it back from the sandbox.
    const box = await connectSandbox(provider, created.id);
    const error = await rejection(box.ext.demo.fail());
    expect(calls).toBe(1);
    expect(`${error.message} ${String(error.cause)}`).not.toContain(secret);

    const unreadable: typeof provider = {
      ...provider,
      async readSecretEnvironment() {
        throw new Error("guest unreachable");
      },
    };

    const blind = await connectSandbox(unreadable, created.id);
    const withheld = await rejection(blind.ext.demo.fail());
    expect(withheld.message).toContain("withheld");
    expect(`${withheld.message} ${String(withheld.cause)}`).not.toContain(secret);
    await blind.destroy();
  });

  test("a factory that throws surfaces as a redacted SandboxError on access", async () => {
    const secret = "factory-secret-value";
    const base = memory();

    const provider: Provider<unknown, "network-policy", { demo: { ping(): Promise<void> } }> = {
      ...base,
      extensions: {
        demo: () => {
          throw new Error(`cannot bind ${secret}`);
        },
      },
    };

    const box = await createSandbox(provider, { secrets: { TOKEN: secret } });
    let thrown: unknown;

    try {
      void box.ext.demo;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxError);
    expect(String(thrown)).not.toContain(secret);
    await box.destroy();
  });
});

describe("provider-level capabilities", () => {
  test("deleteSnapshot and buildTemplate refuse providers that lack the capability", async () => {
    const provider = runtime(memory());

    await expect(deleteSnapshot(provider, "snap")).rejects.toMatchObject({
      code: "unsupported",
      provider: "memory",
    });
    await expect(buildTemplate(provider, { name: "t" })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  test("a declared capability without its hook is an adapter error, at use and at create", async () => {
    const provider = runtime({
      ...memory(),
      capabilities: new Set(["templates", "snapshot-delete"]),
    });

    await expect(deleteSnapshot(provider, "snap")).rejects.toMatchObject({ code: "provider" });
    await expect(buildTemplate(provider, { name: "t" })).rejects.toMatchObject({
      code: "provider",
    });
    await expect(createSandbox(provider)).rejects.toMatchObject({ code: "provider" });
  });

  test("calls reach the hooks with validated input, and errors are redacted", async () => {
    const calls: { spec: TemplateSpec; options: TemplateBuildOptions }[] = [];
    const deleted: string[] = [];

    const provider: Provider<unknown, "templates" | "snapshot-delete"> = {
      ...memory(),
      capabilities: new Set(["templates", "snapshot-delete"]),
      async deleteSnapshot(id) {
        deleted.push(id);

        return id === "known";
      },
      async buildTemplate(spec, options) {
        calls.push({ spec, options });
        options.onLog?.("step 1");

        return { id: `tpl-${spec.name}`, name: spec.name, buildId: "b1" };
      },
    };

    expect(await deleteSnapshot(provider, "known")).toBe(true);
    expect(await deleteSnapshot(provider, "gone")).toBe(false);
    expect(deleted).toEqual(["known", "gone"]);
    await expect(deleteSnapshot(provider, "")).rejects.toMatchObject({ code: "invalid_argument" });

    const logs: string[] = [];

    expect(
      await buildTemplate(
        provider,
        { name: "node", image: "node:22", run: ["npm i -g pnpm"] },
        { onLog: (line) => logs.push(line), timeoutMs: 1000 },
      ),
    ).toEqual({ id: "tpl-node", name: "node", buildId: "b1" });
    expect(calls[0]?.spec).toEqual({ name: "node", image: "node:22", run: ["npm i -g pnpm"] });
    expect(logs).toEqual(["step 1"]);

    for (const [spec, options] of [
      [{ name: "" }, {}],
      [{ name: "x", run: ["  "] }, {}],
      [{ name: "x" }, { timeoutMs: 0 }],
    ] as const)
      await expect(buildTemplate(provider, spec, options)).rejects.toMatchObject({
        code: "invalid_argument",
      });
    expect(calls).toHaveLength(1);
  });
});

describe("terminal", () => {
  /** A memory provider with a scripted PTY that echoes input and records what it was opened with. */
  function terminalProvider() {
    const opened: TerminalOptions[] = [];
    const written: string[] = [];
    const listeners = new Set<(data: string) => void>();
    let exit: (code: number) => void = () => {};

    const provider: Provider<unknown, "network-policy" | "terminal"> = {
      ...memory(),
      capabilities: new Set(["network-policy", "terminal"]),
      async terminal(_id, options): Promise<Terminal> {
        opened.push(options);

        const exited = new Promise<number>((resolve) => {
          exit = resolve;
        });

        return {
          write(data) {
            written.push(data);

            for (const listener of listeners) listener(`echo:${data}`);
          },
          resize() {},
          onData(callback) {
            listeners.add(callback);

            return () => listeners.delete(callback);
          },
          close() {
            exit(0);
          },
          wait: async () => ({ exitCode: await exited }),
        };
      },
    };

    return { provider, opened, written, exit: (code: number) => exit(code) };
  }

  test("opens with an absolute cwd and the handle env, and redacts output", async () => {
    const secret = "terminal-secret-value";
    const { provider, opened, written } = terminalProvider();

    const box = await createSandbox(provider, {
      env: { MODE: "dev" },
      secrets: { TOKEN: secret },
    });

    const terminal = await box.terminal({ cols: 80, rows: 24, cwd: "app", env: { EXTRA: "1" } });
    expect(opened[0]).toEqual({
      cols: 80,
      rows: 24,
      cwd: "/workspace/app",
      env: { MODE: "dev", TOKEN: secret, EXTRA: "1" },
    });

    const seen: string[] = [];
    const off = terminal.onData((data) => seen.push(data));
    await terminal.write(`printf ${secret}\n`);
    off();
    expect(written).toEqual([`printf ${secret}\n`]);
    expect(seen.join("")).not.toContain(secret);
    expect(seen.join("")).toContain("[REDACTED]");

    const waiting = terminal.wait?.();
    await terminal.close();
    expect(await waiting).toEqual({ exitCode: 0 });
    await box.destroy();
  });

  test("rejects bad sizes and env names before opening, and is absent without the capability", async () => {
    const { provider, opened } = terminalProvider();
    const box = await createSandbox(provider);

    for (const options of [
      { cols: 0, rows: 24 },
      { cols: 80, rows: 1.5 },
      { cols: 80, rows: 24, env: { "BAD-NAME": "x" } },
    ])
      await expect(box.terminal(options)).rejects.toMatchObject({ code: "invalid_argument" });
    expect(opened).toHaveLength(0);
    await box.destroy();

    const plain = await createSandbox(runtime(memory()));
    expect(hasCapability(plain, "terminal")).toBe(false);
    expect("terminal" in plain).toBe(false);
    await plain.destroy();
  });
});

describe("native file watching", () => {
  test("uses the adapter's events, with absolute paths, until stopped", async () => {
    const base = memory();
    const starts: { path: string; recursive: boolean }[] = [];
    let aborted = false;

    const provider: Provider = {
      ...base,
      files: {
        ...base.files,
        async watch(_id, path, options) {
          starts.push({ path, recursive: options.recursive });
          options.onEvent({ type: "added", path: `${path}/new.txt` });
          await new Promise<void>((resolve) =>
            options.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          aborted = true;
        },
      },
    };

    const box = await createSandbox(provider);
    const events: FileEvent[] = [];
    const stop = box.files.watch("src", (event) => events.push(event), { recursive: true });
    await expect.poll(() => events).toEqual([{ type: "added", path: "/workspace/src/new.txt" }]);
    expect(starts).toEqual([{ path: "/workspace/src", recursive: true }]);
    stop();
    await expect.poll(() => aborted).toBe(true);
    await box.destroy();
  });

  test("falls back to polling on unsupported, and reports and retries other failures", async () => {
    const base = memory();
    let attempts = 0;

    const unsupported: Provider = {
      ...base,
      files: {
        ...base.files,
        async watch() {
          throw new SandboxError("no native watch", { code: "unsupported" });
        },
      },
    };

    const box = await createSandbox(unsupported);
    await box.files.write("watched/a.txt", "a");
    const events: FileEvent["type"][] = [];

    const stop = box.files.watch("watched", (event) => events.push(event.type), {
      intervalMs: 20,
    });

    await pause(60);
    await box.files.write("watched/b.txt", "b");
    await expect.poll(() => events).toContain("added");
    stop();
    await box.destroy();

    const failing: Provider = {
      ...memory(),
      files: {
        ...base.files,
        async watch() {
          attempts++;
          throw new SandboxError("stream broke", { code: "unavailable" });
        },
      },
    };

    const second = await createSandbox(failing);
    const errors: string[] = [];
    const stopFailing = second.files.watch("x", () => {}, { onError: (e) => errors.push(e.code) });
    await expect.poll(() => errors, { timeout: 3000 }).toEqual(["unavailable", "unavailable"]);
    stopFailing();
    const settled = attempts;
    await pause(1200);
    expect(attempts).toBe(settled);
    await second.destroy();
  });
});

describe("usage", () => {
  test("merges provider metrics, and core counters always win", async () => {
    const base = memory();

    const provider: Provider = {
      ...base,
      async usage() {
        return { cpuPercent: 42, memoryBytes: 1024, commands: 999 };
      },
    };

    const box = await createSandbox(provider);
    await box.run("echo hi");
    const usage = await box.usage();
    expect(usage).toMatchObject({ cpuPercent: 42, memoryBytes: 1024, commands: 1, bytesOut: 3 });
    expect(usage.diskBytes).toBeUndefined();
    await box.destroy();
  });
});
