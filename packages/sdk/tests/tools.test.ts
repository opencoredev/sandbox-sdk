import { noopObserve } from "@mastra/core/tools";
import { RunContext } from "@openai/agents";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../src/index.js";
import { SandboxError } from "../src/errors.js";
import { memory } from "../src/memory.js";
import type { Provider } from "../src/provider.js";
import { createSandboxTools, toolSchemas, type ToolName, type ToolResult } from "../src/tools.js";
import { sandboxTools as aiTools } from "../src/ai.js";
import { sandboxTools as mastraTools } from "../src/mastra.js";
import { sandboxTools as openaiTools } from "../src/openai.js";
import type { JsonValue } from "../src/shared/json.js";

const names = Object.keys(toolSchemas).filter((name): name is ToolName => name in toolSchemas);

/** Whether an AI SDK tool result streams preliminary outputs. */
function isOutputStream(value: unknown): value is AsyncIterable<ToolResult> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/** Runs a tool with arguments as a model would send them, valid or not. */
function invoke(tools: ReturnType<typeof createSandboxTools>, name: ToolName, input: JsonValue) {
  const tool = tools.find((tool) => tool.name === name);

  if (!tool) throw new Error(`Missing ${name}`);

  return tool.execute(input);
}

describe("sandbox agent tools", () => {
  it("runs every file tool and scopes changes, search, and listings to root", async () => {
    await using box = await createSandbox(memory());
    await box.files.write("app/before.txt", "old\n");
    await box.files.write("outside.txt", "private");
    const tools = createSandboxTools(box, { root: "app", allow: names });
    expect(
      (await invoke(tools, "write_file", { path: "a.txt", content: "one\ntwo\nthree" })).text,
    ).toMatch(/^OK/);
    const read = await invoke(tools, "read_file", { path: "a.txt", offset: 1, limit: 1 });
    expect(read.text).toMatch(/sha=[a-f0-9]{64}/);
    expect(read.text).toContain("2: two");
    expect(read.text).toContain("nextOffset=2");
    expect(
      (await invoke(tools, "edit_file", { path: "a.txt", find: "two", replace: "changed" })).text,
    ).toMatch(/^OK/);
    expect(await box.files.read("app/a.txt")).toBe("one\nchanged\nthree");
    expect((await invoke(tools, "search", { query: "changed" })).text).toContain("changed");
    expect((await invoke(tools, "list_files", {})).text).not.toContain("outside.txt");
    expect((await invoke(tools, "changes", {})).text).toContain('"added":["/workspace/app/a.txt"]');
    expect((await invoke(tools, "preview", { port: 3000 })).text).toContain(".memory.invalid");

    for (const path of ["../outside.txt", "/etc/passwd", "/workspace/application/a.txt"])
      expect((await invoke(tools, "read_file", { path })).text).toMatch(/^FAILED/);
    expect((await invoke(tools, "run", { command: "pwd", cwd: "../" })).text).toMatch(/^FAILED/);
  });

  it("returns nonzero exits, invalid inputs, missing files and ambiguous edits as actionable results", async () => {
    await using box = await createSandbox(memory());
    const tools = createSandboxTools(box);
    expect((await invoke(tools, "run", { command: "exit 7" })).text).toMatch(/^FAILED exit=7/);
    const missing = await invoke(tools, "read_file", { path: "absent" });
    expect(missing.text).toContain("file_not_found");
    expect(missing.text).toContain("Next:");
    expect((await invoke(tools, "run", { command: 42 })).text).toContain("Invalid tool input");
    await box.files.write("same", "x x");
    expect(
      (await invoke(tools, "edit_file", { path: "same", find: "x", replace: "z" })).text,
    ).toContain("edit_not_unique");
    expect(await box.files.read("same")).toBe("x x");

    const timeout = await invoke(
      createSandboxTools(box, { limits: { run: { timeoutMs: 10 } } }),
      "run",
      { command: "sleep 2", timeoutMs: 1000 },
    );

    expect(timeout.text).toContain("Timed out");
  });

  it("enforces allow/deny and beforeRun for foreground and background commands", async () => {
    await using box = await createSandbox(memory());
    expect(
      createSandboxTools(box, { allow: ["run", "preview"], deny: ["run"] }).map((t) => t.name),
    ).toEqual(["preview"]);
    const denied = createSandboxTools(box, { beforeRun: () => false });
    expect((await invoke(denied, "run", { command: "echo BAD" })).text).toContain("denied");
    expect(
      (await invoke(denied, "start_process", { name: "bad", command: "echo BAD" })).text,
    ).toContain("denied");
    expect(await box.processes()).toEqual([]);
    const rewritten = createSandboxTools(box, { beforeRun: () => "echo rewritten" });
    expect((await invoke(rewritten, "run", { command: "echo original" })).text).toContain(
      "rewritten",
    );
  });

  it("caps UTF-8 output with head and tail while streaming complete ordered output", async () => {
    const events: string[] = [];

    await using box = await createSandbox(
      memory({
        handlers: {
          noisy({ stdout, stderr }) {
            stdout("\u001b[31mHEAD\n" + "界".repeat(15_000));
            stderr("\nTAIL\u001b[0m");

            return 0;
          },
        },
      }),
    );

    const output = await invoke(
      createSandboxTools(box, { onEvent: (e) => events.push(e.text) }),
      "run",
      { command: "noisy" },
    );

    expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(16_384);
    expect(output.text).toContain("HEAD");
    expect(output.text).toContain("TAIL");
    expect(output.text).toMatch(/bytes cut/);
    expect(output.text).not.toContain("\u001b");
    expect(events.join("")).toBe("HEAD\n" + "界".repeat(15_000) + "\nTAIL");
  });

  it("redacts files, command output, paths, errors, events, and process logs", async () => {
    const secret = "sk_test_secret123";
    const events: string[] = [];
    await using box = await createSandbox(memory(), { secrets: { TOKEN: secret } });
    await box.files.write("key", secret);
    const tools = createSandboxTools(box, { allow: names, onEvent: (e) => events.push(e.text) });

    for (const output of [
      await invoke(tools, "read_file", { path: "key" }),
      await invoke(tools, "run", { command: "printenv TOKEN" }),
      await invoke(tools, "read_file", { path: secret }),
      await invoke(tools, "search", { query: secret }),
      await invoke(tools, "start_process", { name: "key", command: "printenv TOKEN" }),
      await invoke(tools, "process_logs", { name: "key" }),
    ])
      expect(output.text).not.toContain(secret);
    expect(events.join("")).not.toContain(secret);
    expect(await box.files.read("key")).toBe(secret);
  });

  it("starts, pages logs without repetition, and stops background processes", async () => {
    await using box = await createSandbox(memory());
    const tools = createSandboxTools(box);
    expect(
      (await invoke(tools, "start_process", { name: "server", command: "echo ready; sleep 2" }))
        .text,
    ).toContain("name=server");
    const logs = await invoke(tools, "process_logs", { name: "server" });
    expect(logs.text).toContain("ready");
    const cursor = /cursor=(\d+)/.exec(logs.text)?.[1];
    expect(cursor).toBeDefined();
    expect((await invoke(tools, "process_logs", { name: "server", cursor })).text).not.toContain(
      "ready",
    );
    expect((await invoke(tools, "stop_process", { name: "server" })).text).toMatch(/^OK/);
    expect((await box.processes())[0]?.status).not.toBe("running");
  });

  it("labels binary content without returning raw bytes", async () => {
    await using box = await createSandbox(memory());
    await box.files.write("binary", new Uint8Array([0, 255, 3]));
    expect((await invoke(createSandboxTools(box), "read_file", { path: "binary" })).text).toMatch(
      /binary file; size=3 bytes; sha=[a-f0-9]{64}/,
    );
  });

  it("executes native adapters and AI preliminary results with compact final model output", async () => {
    await using box = await createSandbox(memory());
    const ai = aiTools(box);
    const run = ai.run;

    if (!run?.execute) throw new Error("AI run missing");

    const result = run.execute(
      { command: "echo native" },
      { toolCallId: "call", messages: [], context: {}, abortSignal: new AbortController().signal },
    );

    const outputs: ToolResult[] = [];

    if (isOutputStream(result)) {
      for await (const output of result) outputs.push(output);
    } else throw new Error("Expected preliminary iterator");
    expect(outputs.length).toBeGreaterThan(1);
    expect(outputs.at(-1)?.text).toMatch(/^OK/);
    expect(
      await run.toModelOutput?.({
        output: outputs.at(-1) ?? { text: "missing" },
        input: { command: "echo native" },
        toolCallId: "call",
      }),
    ).toMatchObject({ type: "text", value: expect.stringMatching(/^OK/) });
    const mastra = mastraTools(box).run;

    if (!mastra?.execute) throw new Error("Mastra run missing");
    expect(
      await mastra.execute({ command: "echo native" }, { observe: noopObserve }),
    ).toMatchObject({ text: expect.stringMatching(/^OK/) });
    const openai = openaiTools(box).find((t) => t.name === "run");

    if (!openai) throw new Error("OpenAI run missing");
    // Native invocation is covered in the built consumer; framework context has its own runtime contract.
    expect(openai.parameters.properties).toHaveProperty("command");
    expect(
      await openai.invoke(new RunContext(), JSON.stringify({ command: "echo native" })),
    ).toMatch(/^OK/);
  });
});

describe("bounded replay and policy edges", () => {
  it("replays omitted UTF-8 foreground output using process_logs cursors", async () => {
    const content = "HEAD\n" + "界".repeat(15_000) + "\nTAIL";

    await using box = await createSandbox(
      memory({
        handlers: {
          large({ stdout }) {
            stdout(content);

            return 0;
          },
        },
      }),
    );

    const tools = createSandboxTools(box);
    const run = await invoke(tools, "run", { command: "large" });
    const name = /name=(run_[a-f0-9]+)/.exec(run.text)?.[1];
    expect(name).toBeDefined();

    let cursor = "0",
      replay = "";

    for (let page = 0; page < 10; page++) {
      const output = await invoke(tools, "process_logs", { name, cursor });
      expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(16_384);
      const match = /cursor=(\d+) more=(true|false)\n([\s\S]*)/.exec(output.text);
      expect(match).not.toBeNull();
      cursor = match?.[1] ?? "0";
      replay += (match?.[3] ?? "").replace(/\n\[more output; use process_logs with cursor\]$/, "");

      if (match?.[2] === "false") break;
    }

    expect(replay).toBe(content);
    expect((await invoke(tools, "process_logs", { name, cursor: "invalid" })).text).toMatch(
      /^FAILED/,
    );
  });

  it("respects small per-tool caps, paginates lines, and never forwards preview headers", async () => {
    const provider = memory();
    const original = provider.previewUrl;
    provider.previewUrl = async (id, port) => ({
      ...(await original(id, port)),
      headers: { Authorization: "credential-only-in-header" },
    });
    await using box = await createSandbox(provider);
    await box.files.write(
      "long",
      Array.from({ length: 500 }, (_, i) => `line-${i}-text`).join("\n"),
    );

    const tools = createSandboxTools(box, {
      allow: names,
      limits: { read_file: { maxOutputBytes: 512 } },
    });

    const first = await invoke(tools, "read_file", { path: "long" });
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(512);
    const offset = Number(/nextOffset=(\d+)/.exec(first.text)?.[1]);
    expect(offset).toBeGreaterThan(0);
    const second = await invoke(tools, "read_file", { path: "long", offset });
    expect(second.text).toContain(`${offset + 1}: line-${offset}-text`);
    expect((await invoke(tools, "preview", { port: 3000 })).text).not.toContain(
      "credential-only-in-header",
    );
    expect(
      (await invoke(tools, "preview", { port: 3000, path: "https://example.com" })).text,
    ).toMatch(/^FAILED/);
    expect(() => createSandboxTools(box, { limits: { run: { maxOutputBytes: 0 } } })).toThrow();
  });

  it("waits for a supplied process port and blocks symlink components", async () => {
    const provider = memory();
    const stat = provider.files.stat;
    provider.files.stat = async (id, path) =>
      path === "/workspace/link"
        ? { path, type: "symlink", size: 0, modifiedAt: 0 }
        : stat(id, path);
    await using box = await createSandbox(provider);
    const tools = createSandboxTools(box);

    const start = await invoke(tools, "start_process", {
      name: "port",
      command: "echo ready; sleep 2",
      port: 3000,
    });

    expect(start.text).toContain("ready=true");
    expect(start.text).toContain(".memory.invalid");
    await invoke(tools, "stop_process", { name: "port" });
    expect(
      (await invoke(tools, "write_file", { path: "link/out", content: "bad" })).text,
    ).toContain("Symlink path rejected");
    expect(await box.files.exists("link/out")).toBe(false);
  });
});

describe("review regressions", () => {
  it("normalizes ANSI before redacting secrets, across streaming chunk boundaries", async () => {
    const secret = "secret-token-123",
      events: string[] = [];

    await using box = await createSandbox(
      memory({
        handlers: {
          leak({ stdout }) {
            stdout("secret-\x1b");
            stdout("[31m");
            stdout("token-123");

            return 0;
          },
        },
      }),
      { secrets: { TOKEN: secret } },
    );

    const tools = createSandboxTools(box, { onEvent: (event) => events.push(event.text) });
    const output = await invoke(tools, "run", { command: "leak" });
    expect(events.join("")).toBe("[REDACTED]");
    expect(output.text).not.toContain(secret);
    await box.files.write("ansi", "secret-\x1b[31mtoken-123");
    expect((await invoke(tools, "read_file", { path: "ansi" })).text).not.toContain(secret);
  });

  it("preserves omitted long-line contents through a replay cursor", async () => {
    await using box = await createSandbox(memory());
    await box.files.write("long", "A".repeat(20_000) + "MIDDLE" + "B".repeat(20_000) + "\nlast");
    const tools = createSandboxTools(box);
    const output = await invoke(tools, "read_file", { path: "long" });
    const name = /name=(read_[a-f0-9]+)/.exec(output.text)?.[1];
    expect(name).toBeDefined();

    let cursor = "0",
      replay = "";

    for (let i = 0; i < 5; i++) {
      const page = await invoke(tools, "process_logs", { name, cursor });
      cursor = /cursor=(\d+)/.exec(page.text)?.[1] ?? "0";
      replay += page.text;

      if (page.text.includes("more=false")) break;
    }

    expect(replay).toContain("MIDDLE");
  });

  it("allows write_file to create a missing root while tracking changes", async () => {
    await using box = await createSandbox(memory());

    const tools = createSandboxTools(box, {
      root: "new-project",
      allow: ["write_file", "changes"],
    });

    expect((await invoke(tools, "write_file", { path: "main.ts", content: "ok" })).text).toMatch(
      /^OK/,
    );
    expect((await invoke(tools, "changes", {})).text).toContain("/workspace/new-project/main.ts");
  });
});

describe("UI callback isolation", () => {
  it("finishes a command even when its UI subscriber throws", async () => {
    await using box = await createSandbox(memory());

    const tools = createSandboxTools(box, {
      onEvent() {
        throw new Error("UI disconnected");
      },
    });

    const output = await invoke(tools, "run", { command: "echo first; echo finished" });
    expect(output.text).toMatch(/^OK exit=0/);
    expect(output.text).toContain("finished");
    expect(output.text).toContain("UI streaming callback failed");
  });
});

describe("startup readiness outcomes", () => {
  it("returns ready=false on timeout while the process stays stoppable", async () => {
    const provider = memory();
    provider.previewUrl = async () => {
      throw new SandboxError("Port is not ready. No listener exists yet. Inspect process_logs.", {
        code: "port_not_ready",
      });
    };

    await using box = await createSandbox(provider);
    const tools = createSandboxTools(box, { limits: { start_process: { timeoutMs: 10 } } });

    const result = await invoke(tools, "start_process", {
      name: "pending",
      command: "echo booting; sleep 2",
      port: 3000,
    });

    expect(result.text).toMatch(/^FAILED/);
    expect(result.text).toContain("ready=false");
    expect((await box.processes()).find((p) => p.name === "pending")?.status).toBe("running");
    expect((await invoke(tools, "stop_process", { name: "pending" })).text).toMatch(/^OK/);
  });

  it("reports a boot crash with its log and applies command rewrites to startup", async () => {
    await using box = await createSandbox(memory());
    const tools = createSandboxTools(box);

    const crash = await invoke(tools, "start_process", {
      name: "crash",
      command: "echo boot-error; exit 3",
      port: 3000,
    });

    expect(crash.text).toMatch(/^FAILED/);
    expect(crash.text).toContain("boot-error");
    const rewritten = createSandboxTools(box, { beforeRun: () => "echo rewritten" });
    await invoke(rewritten, "start_process", { name: "rewritten", command: "echo original" });
    await box.process("rewritten").wait();
    expect((await invoke(rewritten, "process_logs", { name: "rewritten" })).text).toContain(
      "rewritten",
    );
  });
});

describe("framework cancellation", () => {
  it("terminates foreground work when the AI preliminary iterator is returned", async () => {
    let ended = false;

    await using box = await createSandbox(
      memory({
        handlers: {
          async cancellable({ stdout, signal }) {
            stdout("started\n");
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            ended = true;

            return 143;
          },
        },
      }),
    );

    const run = aiTools(box).run;

    if (!run?.execute) throw new Error("Missing AI execute");

    const stream = run.execute(
      { command: "cancellable" },
      { toolCallId: "cancel", messages: [], context: {} },
    );

    if (!isOutputStream(stream)) throw new Error("Missing stream");
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await iterator.return?.();
    expect(ended).toBe(true);
  });
});

describe("pagination security", () => {
  it("redacts background secrets before pagination and merged foreground streams", async () => {
    const secret = "secret-token-123",
      events: string[] = [];

    await using box = await createSandbox(
      memory({
        handlers: {
          background({ stdout }) {
            stdout("x".repeat(15865) + "secret-\x1b[31mtoken-123\nTAIL");

            return 0;
          },
          merged({ stdout, stderr }) {
            stdout("secret-");
            stderr("token-123");

            return 0;
          },
        },
      }),
      { secrets: { TOKEN: secret } },
    );

    const tools = createSandboxTools(box, { onEvent: (e) => events.push(e.text) });
    await box.start("background", { name: "background" });
    await box.process("background").wait();

    let cursor = "0",
      output = "";

    for (let i = 0; i < 5; i++) {
      const page = await invoke(tools, "process_logs", { name: "background", cursor });
      output += page.text;
      cursor = /cursor=(\d+)/.exec(page.text)?.[1] ?? "0";

      if (page.text.includes("more=false")) break;
    }

    expect(events.join("")).not.toContain(secret);
    expect(events.join("")).toContain("[REDACTED]");
    expect(output).not.toContain(secret);
    events.length = 0;
    await invoke(tools, "run", { command: "merged" });
    expect(events.join("")).toBe("[REDACTED]");
  });

  it("refuses an oversized file before downloading it", async () => {
    const backing = memory();
    const downloads: string[] = [];
    let reportedSize: number | undefined;

    const provider: Provider = {
      ...backing,
      files: {
        ...backing.files,
        async stat(id, path) {
          const info = await backing.files.stat(id, path);

          return reportedSize === undefined ? info : { ...info, size: reportedSize };
        },
        async read(id, path) {
          downloads.push(path);

          return backing.files.read(id, path);
        },
      },
    };

    await using box = await createSandbox(provider);
    await box.files.write("big", "z".repeat(4096));
    const tools = createSandboxTools(box, { limits: { read_file: { maxReadBytes: 1024 } } });
    const refused = await invoke(tools, "read_file", { path: "big" });
    expect(refused.text).toMatch(/^FAILED/);
    expect(refused.text).toContain("4096 bytes, above maxReadBytes=1024");
    expect(downloads).toEqual([]);

    // A file that grows after its size check is still read only up to the limit.
    reportedSize = 10;
    const grown = await invoke(tools, "read_file", { path: "big" });
    expect(grown.text).toMatch(/^FAILED/);
    expect(grown.text).toContain("above maxReadBytes=1024");
    expect(downloads).toEqual([]);
  });

  it("keeps replay metadata intact with the minimum accepted cap", async () => {
    await using box = await createSandbox(memory());
    await box.files.write("long", "A".repeat(40000));
    const tools = createSandboxTools(box, { limits: { read_file: { maxOutputBytes: 256 } } });
    const page = await invoke(tools, "read_file", { path: "long" });
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(256);
    const name = /name=(read_[a-f0-9]+)/.exec(page.text)?.[1];
    expect(name).toBeDefined();
    expect(page.text).toContain("cursor=0");
    expect((await invoke(tools, "process_logs", { name, cursor: "0" })).text).toContain("AAAA");
  });
});
