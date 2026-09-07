import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandFailedError, createSandbox } from "../../src";
import { defineCapabilities } from "../../src/core/capabilities";
import type { SandboxProvider } from "../../src/core/provider";
import type {
  CapabilityMap,
  CommandResult,
  ProcessOutputEvent,
  SandboxProcess,
} from "../../src/core/types";
import { unsupportedSnapshots } from "../../src/internal/provider-utils";

type Responder = (command: string) => Partial<CommandResult> | undefined;

function fakeProvider(
  options: { respond?: Responder; streaming?: boolean; plainCapabilities?: boolean } = {},
) {
  const commands: string[] = [];
  const files = new Map<string, Uint8Array>();
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: options.plainCapabilities
      ? ({ "process.run": "in-process" } as CapabilityMap)
      : defineCapabilities({
          "process.run": options.streaming ? "separate-streams" : "in-process",
          ...(options.streaming ? { "process.stream": "separate-streams" as const } : {}),
        }),
    async create() {
      return {
        id: "fake",
        raw: {},
        capabilities: options.plainCapabilities
          ? ({ "process.run": "in-process" } as CapabilityMap)
          : defineCapabilities({
              "process.run": options.streaming ? "separate-streams" : "in-process",
              ...(options.streaming ? { "process.stream": "separate-streams" as const } : {}),
            }),
        files: {
          async write(path, value) {
            files.set(
              path,
              typeof value === "string" ? new TextEncoder().encode(value) : (value as Uint8Array),
            );
          },
          async read(path) {
            const value = files.get(path);
            if (!value) throw new Error(`not found: ${path}`);
            return value;
          },
          async list() {
            return [];
          },
          async mkdir() {},
          async remove(path) {
            files.delete(path);
          },
          async exists(path) {
            return files.has(path);
          },
        },
        async run(command) {
          const text = typeof command === "string" ? command : command.command;
          commands.push(text);
          const response = options.respond?.(text);
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            success: true,
            ...response,
            ...(response?.exitCode !== undefined ? { success: response.exitCode === 0 } : {}),
          };
        },
        async start(command): Promise<SandboxProcess> {
          const text = typeof command === "string" ? command : command.command;
          commands.push(text);
          const events: ProcessOutputEvent[] = [
            { stream: "stdout", data: "chunk-one " },
            { stream: "stdout", data: new TextEncoder().encode("chunk-two") },
            { stream: "stderr", data: "warning" },
          ];
          return {
            id: "proc",
            async status() {
              return "exited";
            },
            async *output() {
              yield* events;
            },
            async write() {},
            async wait() {
              return { exitCode: 0 };
            },
            async kill() {},
          };
        },
        async expose() {
          throw new Error("unsupported");
        },
        snapshots: unsupportedSnapshots("local"),
        async stop() {},
      };
    },
  };
  return { provider, commands, files };
}

test("$ runs commands with quoted interpolations", async () => {
  const { provider, commands } = fakeProvider({
    respond: () => ({ stdout: "ok" }),
  });
  await using sandbox = await createSandbox({ provider });
  const name = "weird 'name'";
  const result = await sandbox.$`ls -la ${name} ${["a b", "c"]}`;
  expect(result.stdout).toBe("ok");
  expect(commands[0]).toBe(`ls -la 'weird '"'"'name'"'"'' 'a b' 'c'`);
});

test("$ throws CommandFailedError with the result attached", async () => {
  const { provider } = fakeProvider({
    respond: () => ({ exitCode: 2, stderr: "boom" }),
  });
  await using sandbox = await createSandbox({ provider });
  try {
    await sandbox.$`false`;
    throw new Error("expected CommandFailedError");
  } catch (error) {
    expect(error).toBeInstanceOf(CommandFailedError);
    const failed = error as CommandFailedError;
    expect(failed.code).toBe("process_failed");
    expect(failed.result.exitCode).toBe(2);
    expect(failed.command).toBe("false");
  }
});

test("run delivers final output through callbacks when streaming is unsupported", async () => {
  const { provider } = fakeProvider({
    plainCapabilities: true,
    respond: () => ({ stdout: "all output", stderr: "all errors" }),
  });
  await using sandbox = await createSandbox({ provider });
  let stdout = "";
  let stderr = "";
  const result = await sandbox.run("echo hi", {
    onStdout: (data) => (stdout += data),
    onStderr: (data) => (stderr += data),
  });
  expect(result.stdout).toBe("all output");
  expect(stdout).toBe("all output");
  expect(stderr).toBe("all errors");
});

test("run streams chunks through callbacks when the provider supports it", async () => {
  const { provider } = fakeProvider({ streaming: true });
  await using sandbox = await createSandbox({ provider });
  const chunks: string[] = [];
  let stderr = "";
  const result = await sandbox.run("echo hi", {
    onStdout: (data) => chunks.push(data),
    onStderr: (data) => (stderr += data),
  });
  expect(chunks).toEqual(["chunk-one ", "chunk-two"]);
  expect(stderr).toBe("warning");
  expect(result.stdout).toBe("chunk-one chunk-two");
  expect(result.exitCode).toBe(0);
});

test("runCode writes a temporary file, runs the interpreter, and cleans up", async () => {
  const seen: string[] = [];
  const { provider, files } = fakeProvider({
    respond: (command) => {
      seen.push(command);
      return { stdout: "42" };
    },
  });
  await using sandbox = await createSandbox({ provider });
  const result = await sandbox.runCode("print(42)");
  expect(result.stdout).toBe("42");
  expect(seen[0]).toMatch(/^python3 '\/tmp\/sandbox-sdk-[a-z0-9]+\.py'$/);
  expect(files.size).toBe(0);
});

test("runCode falls back to python when python3 is missing", async () => {
  const seen: string[] = [];
  const { provider } = fakeProvider({
    respond: (command) => {
      seen.push(command);
      return command.startsWith("python3") ? { exitCode: 127 } : { stdout: "ok" };
    },
  });
  await using sandbox = await createSandbox({ provider });
  const result = await sandbox.runCode("print('ok')");
  expect(result.stdout).toBe("ok");
  expect(seen[0]).toStartWith("python3 ");
  expect(seen[1]).toStartWith("python ");
});

test("runCode picks interpreters per language", async () => {
  const seen: string[] = [];
  const { provider } = fakeProvider({
    respond: (command) => {
      seen.push(command);
      return {};
    },
  });
  await using sandbox = await createSandbox({ provider });
  await sandbox.runCode("console.log(1)", { language: "javascript" });
  await sandbox.runCode("echo hi", { language: "bash" });
  expect(seen[0]).toMatch(/^node '.*\.mjs'$/);
  expect(seen[1]).toMatch(/^bash '.*\.sh'$/);
});

test("files.stat parses GNU stat output and resolves relative paths", async () => {
  const { provider, commands } = fakeProvider({
    respond: (command) =>
      command.startsWith("stat -c") ? { stdout: "regular file|120|1755475200\n" } : {},
  });
  await using sandbox = await createSandbox({ provider });
  const stat = await sandbox.files.stat("notes.txt");
  expect(commands[0]).toBe("stat -c '%F|%s|%Y' -- '/workspace/notes.txt'");
  expect(stat).toMatchObject({ path: "/workspace/notes.txt", type: "file", size: 120 });
  expect(stat.modifiedAt).toEqual(new Date(1755475200 * 1000));
});

test("files.stat falls back to BSD format and reports missing files", async () => {
  const { provider } = fakeProvider({
    respond: (command) =>
      command.startsWith("stat -c")
        ? { exitCode: 1, stderr: "stat: illegal option" }
        : { stdout: "Directory|4096|1755475200" },
  });
  await using sandbox = await createSandbox({ provider });
  expect((await sandbox.files.stat("dir")).type).toBe("directory");

  const missing = fakeProvider({
    respond: () => ({ exitCode: 1, stderr: "stat: cannot stat 'x': No such file or directory" }),
  });
  await using sandbox2 = await createSandbox({ provider: missing.provider });
  await expect(sandbox2.files.stat("x")).rejects.toMatchObject({ code: "not_found" });
});

test("files.move and files.copy shell out with quoted paths", async () => {
  const { provider, commands } = fakeProvider();
  await using sandbox = await createSandbox({ provider });
  await sandbox.files.move("a.txt", "b.txt");
  await sandbox.files.copy("src", "/elsewhere/dest");
  expect(commands).toEqual([
    "mv -- '/workspace/a.txt' '/workspace/b.txt'",
    "cp -r -- '/workspace/src' '/elsewhere/dest'",
  ]);
});

test("git.clone builds the command and returns the resolved path", async () => {
  const { provider, commands } = fakeProvider();
  await using sandbox = await createSandbox({ provider });
  const { path } = await sandbox.git.clone("https://github.com/acme/widget.git", {
    branch: "main",
    depth: 1,
  });
  expect(commands[0]).toBe(
    "git clone --branch 'main' --depth 1 -- 'https://github.com/acme/widget.git' 'widget'",
  );
  expect(path).toBe("/workspace/widget");
});

test("git.clone injects auth and redacts the token from errors", async () => {
  const { provider, commands } = fakeProvider({
    respond: () => ({
      exitCode: 128,
      stderr: "fatal: could not read from https://x-access-token:tok_secret@github.com/acme/widget",
    }),
  });
  await using sandbox = await createSandbox({ provider });
  try {
    await sandbox.git.clone("https://github.com/acme/widget", {
      auth: { token: "tok_secret" },
    });
    throw new Error("expected clone to fail");
  } catch (error) {
    const failed = error as Error;
    expect(commands[0]).toContain("x-access-token:tok_secret@github.com");
    expect(failed.message).not.toContain("tok_secret");
    expect(failed.message).toContain("[REDACTED]");
  }
});

test("git.pull and git.checkout run against the resolved repository directory", async () => {
  const { provider, commands } = fakeProvider();
  await using sandbox = await createSandbox({ provider });
  await sandbox.git.pull();
  await sandbox.git.checkout("feature/x", { path: "repo" });
  expect(commands).toEqual([
    "git -C '/workspace' pull",
    "git -C '/workspace/repo' checkout 'feature/x'",
  ]);
});

test("git.pull surfaces not_found for non-repositories", async () => {
  const { provider } = fakeProvider({
    respond: () => ({ exitCode: 128, stderr: "fatal: not a git repository" }),
  });
  await using sandbox = await createSandbox({ provider });
  await expect(sandbox.git.pull()).rejects.toMatchObject({
    code: "not_found",
    operation: "git.pull",
  });
});

test("files.writeMany writes every file", async () => {
  const { provider, files } = fakeProvider();
  await using sandbox = await createSandbox({ provider });
  await sandbox.files.writeMany([
    { path: "one.txt", value: "1" },
    { path: "two.txt", value: "2" },
  ]);
  expect(files.has("/workspace/one.txt")).toBe(true);
  expect(files.has("/workspace/two.txt")).toBe(true);
});

test("files.watch polls for create, modify, and remove events", async () => {
  let tick = 0;
  const snapshots = [
    "/workspace/a.txt|3|100",
    "/workspace/a.txt|9|200\n/workspace/b.txt|1|200",
    "/workspace/b.txt|1|200",
  ];
  const { provider } = fakeProvider({
    respond: (command) => {
      if (command.startsWith("stat -c")) return {};
      if (command.startsWith("find")) {
        const stdout = snapshots[Math.min(tick, snapshots.length - 1)]!;
        tick += 1;
        return { stdout };
      }
      return {};
    },
  });
  await using sandbox = await createSandbox({ provider });
  const events: string[] = [];
  await using watcher = await sandbox.files.watch(
    ".",
    (event) => events.push(`${event.type}:${event.path}`),
    { pollInterval: 5 },
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  await watcher.stop();
  expect(events.slice(0, 3)).toEqual([
    "modify:/workspace/a.txt",
    "create:/workspace/b.txt",
    "remove:/workspace/a.txt",
  ]);
});

test("files.upload and files.download bridge the local filesystem", async () => {
  const { provider } = fakeProvider();
  await using sandbox = await createSandbox({ provider });
  const directory = await mkdtemp(join(tmpdir(), "sandbox-sdk-dx-"));
  try {
    const source = join(directory, "in.txt");
    const target = join(directory, "out.txt");
    await Bun.write(source, "round trip");
    await sandbox.files.upload(source, "remote.txt");
    expect(await sandbox.files.text("remote.txt")).toBe("round trip");
    await sandbox.files.download("remote.txt", target);
    expect((await readFile(target)).toString()).toBe("round trip");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
