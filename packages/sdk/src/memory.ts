import { posix } from "node:path";
import type {
  Provider,
  CreateInput,
  SandboxInfo,
  ExecInput,
  ExecResult,
  FileInfo,
  NativeProcess,
} from "./provider.js";
import { SandboxError } from "./errors.js";

export interface CommandContext {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  signal: AbortSignal;
  stdout(text: string): void;
  stderr(text: string): void;
  files: {
    read(path: string): Promise<Uint8Array>;
    write(path: string, data: string | Uint8Array): Promise<void>;
    list(path: string): Promise<FileInfo[]>;
  };
}

export type CommandHandler = (context: CommandContext) => number | Promise<number>;

/** `mode` holds POSIX permission bits; `stat -c %a` and `chmod` read and set them. */
interface Node {
  data: Uint8Array | null;
  modifiedAt: number;
  mode: number;
}

interface Machine {
  info: SandboxInfo;
  nodes: Map<string, Node>;
  env: Record<string, string>;
  processes: Map<number, { controller: AbortController; result: Promise<ExecResult> }>;
  nextPid: number;
  active: Set<AbortController>;
  idleTimeoutMs?: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  lifetimeTimer?: ReturnType<typeof setTimeout>;
}

export interface MemoryOptions {
  handlers?: Record<string, CommandHandler>;
}

export interface MemoryNative {
  readonly files: Map<string, Node>;
}

/** Offline fake. No git, shell programs outside the handler table (plus `cd`, `export`,
 * `kill`, `chmod MODE PATH...` and `stat -c %a PATH...`), PTYs, or real
 * sockets. Preview URLs use memory.invalid and must never be fetched. Register
 * handlers with memory({handlers}) or provider.register(name, handler).
 */
export function memory(options: MemoryOptions = {}): Provider<MemoryNative, "network-policy"> & {
  register(name: string, handler: CommandHandler): void;
} {
  const machines = new Map<string, Machine>();
  const handlers = new Map<string, CommandHandler>();

  const fail = (message: string, code: "not_found" | "file_not_found" | "invalid_argument") =>
    new SandboxError(
      `${message}. Memory resource does not exist or request is invalid. Check the path or ID.`,
      { code, provider: "memory" },
    );

  const machine = (id: string) => {
    const value = machines.get(id);

    if (!value) throw fail(`Sandbox ${id} not found`, "not_found");

    if (value.idleTimeoutMs) {
      clearTimeout(value.idleTimer);
      value.idleTimer = setTimeout(() => {
        if (value.active.size) machine(id);
        else void provider.destroy(id);
      }, value.idleTimeoutMs);
      value.idleTimer.unref?.();
    }

    return value;
  };

  const node = (id: string, path: string) => {
    const value = machine(id).nodes.get(posix.resolve("/", path));

    if (!value) throw fail(`File ${path} not found`, "file_not_found");

    return value;
  };

  const now = () => Date.now();

  function mkdir(id: string, path: string) {
    const m = machine(id);

    for (let dir = posix.resolve("/", path); ; dir = posix.dirname(dir)) {
      const existing = m.nodes.get(dir);

      if (existing?.data) throw fail(`${dir} is not a directory`, "invalid_argument");

      if (!existing) m.nodes.set(dir, { data: null, modifiedAt: now(), mode: 0o755 });

      if (dir === "/") break;
    }
  }

  const files: Provider["files"] = {
    // No tar or git here: transfers and checkpoints use primitive file calls.
    transfer: "files",
    checkpoints: "files",
    writeCreatesParents: true,
    writeSupportsMode: true,
    async readRange(id, path, options) {
      const value = node(id, path);

      if (value.data === null) throw fail(`${path} is a directory`, "invalid_argument");

      return value.data.slice(options.offset, options.offset + options.length);
    },
    async read(id, path) {
      const value = node(id, path);

      if (value.data === null) throw fail(`${path} is a directory`, "invalid_argument");

      return value.data.slice();
    },
    async write(id, path, data, options) {
      const m = machine(id);
      mkdir(id, posix.dirname(path));
      const key = posix.resolve("/", path);
      const existing = m.nodes.get(key);
      m.nodes.set(key, {
        data: data.slice(),
        modifiedAt: Math.max(now(), (existing?.modifiedAt ?? 0) + 1),
        mode: options?.mode ?? existing?.mode ?? 0o644,
      });
    },
    async stat(id, path) {
      const value = node(id, path);

      return {
        path: posix.resolve("/", path),
        type: value.data === null ? "directory" : "file",
        size: value.data?.length ?? 0,
        modifiedAt: value.modifiedAt,
      };
    },
    async list(id, path) {
      const root = posix.resolve("/", path);

      if (node(id, path).data !== null)
        throw fail(`${path} is not a directory`, "invalid_argument");
      const result: FileInfo[] = [];

      for (const candidate of machine(id).nodes.keys())
        if (candidate !== root && posix.dirname(candidate) === root)
          result.push(await files.stat(id, candidate));

      return result.sort((a, b) => a.path.localeCompare(b.path));
    },
    async remove(id, path, options) {
      const m = machine(id);
      const root = posix.resolve("/", path);
      node(id, root);
      const children = [...m.nodes.keys()].filter((candidate) => candidate.startsWith(root + "/"));

      if (children.length && !options.recursive)
        throw fail(`${path} is not empty`, "invalid_argument");

      for (const child of children) m.nodes.delete(child);
      m.nodes.delete(root);
    },
    async mkdir(id, path) {
      mkdir(id, path);
    },
  };

  const wait: CommandHandler = ({ args, signal }) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(137);

        return;
      }

      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve(0);
        },
        Math.max(0, Number(args[0] ?? 0) * 1000),
      );

      const abort = () => {
        clearTimeout(timer);
        resolve(137);
      };

      signal.addEventListener("abort", abort, { once: true });
    });

  handlers.set("echo", ({ args, stdout }) => {
    const noNewline = args[0] === "-n";
    stdout((noNewline ? args.slice(1) : args).join(" ") + (noNewline ? "" : "\n"));

    return 0;
  });
  handlers.set("printf", ({ args, stdout }) => {
    let index = 1;
    stdout(
      (args[0] ?? "")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/%[sd%]/g, (match) => (match === "%%" ? "%" : (args[index++] ?? ""))),
    );

    return 0;
  });
  handlers.set("pwd", ({ cwd, stdout }) => {
    stdout(cwd + "\n");

    return 0;
  });
  handlers.set("true", () => 0);
  handlers.set("false", () => 1);
  handlers.set("exit", ({ args }) => Number(args[0] ?? 0));
  handlers.set("sleep", wait);
  handlers.set("cat", async ({ args, stdin, stdout, stderr, files }) => {
    if (!args.length) stdout(stdin);
    else
      for (const path of args) {
        try {
          stdout(new TextDecoder().decode(await files.read(path)));
        } catch {
          stderr(`cat: ${path}: No such file or directory\n`);

          return 1;
        }
      }

    return 0;
  });
  handlers.set("ls", async ({ args, stdout, files }) => {
    stdout(
      (await files.list(args.find((arg) => !arg.startsWith("-")) ?? "."))
        .map((info) => posix.basename(info.path))
        .join("\n") + "\n",
    );

    return 0;
  });
  handlers.set("printenv", ({ args, env, stdout }) => {
    stdout(
      (args.length
        ? args.map((key) => env[key] ?? "")
        : Object.entries(env).map(([key, value]) => `${key}=${value}`)
      ).join("\n") + "\n",
    );

    return 0;
  });

  for (const [name, handler] of Object.entries(options.handlers ?? {})) handlers.set(name, handler);

  // Small POSIX tokenizer: quote-aware variables and separators, without eval or host execution.
  function tokenize(command: string, env: Record<string, string>) {
    const tokens: { text: string; operator: boolean }[] = [];
    let word = "";
    let active = false;
    let mode: "single" | "double" | "plain" = "plain";

    const flush = () => {
      if (active) tokens.push({ text: word, operator: false });
      word = "";
      active = false;
    };

    for (let index = 0; index < command.length; index++) {
      const char = command[index] ?? "";

      if (mode === "single") {
        if (char === "'") mode = "plain";
        else word += char;
        continue;
      }

      if (char === "'" && mode === "plain") {
        mode = "single";
        active = true;
        continue;
      }

      if (char === '"') {
        mode = mode === "double" ? "plain" : "double";
        active = true;
        continue;
      }

      if (char === "\\") {
        const next = command[++index] ?? "";
        word += next === "n" ? "\\n" : next;
        active = true;
        continue;
      }

      if (char === "$") {
        const rest = command.slice(index + 1);
        const match = /^(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(rest);

        if (match) {
          word += env[match[1] ?? match[2] ?? ""] ?? "";
          index += match[0].length;
          active = true;
          continue;
        }
      }

      if (mode === "plain" && /\s/.test(char)) {
        flush();
        continue;
      }

      if (mode === "plain" && "><".includes(char) && active && /^\d+$/.test(word)) {
        const fd = word;
        word = "";
        active = false;
        tokens.push({ text: fd + char, operator: true });
        continue;
      }

      if (mode === "plain" && char === ">" && command.slice(index, index + 3) === ">&2") {
        flush();
        tokens.push({ text: ">&2", operator: true });
        index += 2;
        continue;
      }

      if (mode === "plain" && ";&>|<".includes(char)) {
        flush();
        let op = char;

        if (command[index + 1] === char) op += command[++index];
        tokens.push({ text: op, operator: true });
        continue;
      }

      word += char;
      active = true;
    }

    if (mode !== "plain") throw fail("Unclosed shell quote", "invalid_argument");
    flush();

    return tokens;
  }

  async function execute(id: string, input: ExecInput): Promise<ExecResult> {
    const m = machine(id);
    const controller = new AbortController();
    m.active.add(controller);
    let timedOut = false;

    const abort = () => {
      timedOut = true;
      controller.abort();
    };

    input.signal?.addEventListener("abort", abort, { once: true });

    if (input.signal?.aborted) abort();
    const timer = setTimeout(abort, input.timeoutMs);
    let cwd = input.cwd;
    const env = { ...m.env, ...input.env };
    let exitCode = 0;
    let exited = false;

    try {
      if (input.activityPath) {
        mkdir(id, posix.dirname(input.activityPath));
        await files.write(id, input.activityPath, new Uint8Array([1]));
      }

      const tokens = tokenize(input.command, env);

      const unsupported = tokens.find(
        (token) => token.operator && ![";", "&&", "||", ">", ">&2"].includes(token.text),
      );

      const badRedirect = tokens.find(
        (token, index) =>
          token.operator &&
          token.text === ">" &&
          (!tokens[index + 1] ||
            tokens[index + 1]?.operator ||
            (tokens[index + 2] && !tokens[index + 2]?.operator)),
      );

      const badConditional = tokens.find(
        (token, index) =>
          token.operator &&
          ["&&", "||"].includes(token.text) &&
          (!tokens[index - 1] ||
            [";", "&&", "||"].includes(tokens[index - 1]?.text ?? "") ||
            !tokens[index + 1] ||
            tokens[index + 1]?.operator),
      );

      let redirects = 0;

      const compoundRedirect = tokens.find((token) => {
        if (!token.operator) return false;

        if ([";", "&&", "||"].includes(token.text)) redirects = 0;
        else if ([">", ">&2"].includes(token.text)) return ++redirects > 1;

        return false;
      });

      const bad = unsupported ?? badRedirect ?? badConditional ?? compoundRedirect;

      if (bad) {
        input.onChunk({
          stream: "stderr",
          text: `Unsupported shell syntax: ${bad.text} (memory provider)\n`,
        });

        return { exitCode: 127, timedOut: false };
      }

      let segment: { text: string; operator: boolean }[] = [];
      let previous = ";";

      async function runSegment(next: string) {
        const parts = segment;
        segment = [];
        const stderrIndex = parts.findIndex((part) => part.operator && part.text === ">&2");

        if (stderrIndex >= 0) parts.splice(stderrIndex, 1);
        const outIndex = parts.findIndex((part) => part.operator && part.text === ">");
        const redirect = outIndex >= 0 ? parts[outIndex + 1]?.text : undefined;

        if (outIndex >= 0) parts.splice(outIndex);
        const args = parts.map((part) => part.text);

        if (
          !args.length ||
          exited ||
          controller.signal.aborted ||
          (previous === "&&" && exitCode !== 0) ||
          (previous === "||" && exitCode === 0)
        ) {
          previous = next;

          return;
        }

        previous = next;

        const name = args.shift() ?? "";

        if (name === "cd") {
          cwd = posix.resolve(cwd, args[0] ?? "/workspace");

          if (node(id, cwd).data !== null) throw fail("Not a directory", "invalid_argument");
          exitCode = 0;

          return;
        }

        if (name === "export") {
          for (const entry of args) {
            const split = entry.indexOf("=");

            if (split >= 0) env[entry.slice(0, split)] = entry.slice(split + 1);
          }

          return;
        }

        if (name === "kill") {
          const pid = Math.abs(Number(args.find((arg) => /^-?\d+$/.test(arg))));
          m.processes.get(pid)?.controller.abort();

          return;
        }

        if (name === "exit") exited = true;

        if (name === "chmod") {
          const mode = Number.parseInt(args[0] ?? "", 8);

          if (!/^[0-7]{1,4}$/.test(args[0] ?? "") || args.length < 2) {
            input.onChunk({
              stream: "stderr",
              text: "chmod: only octal modes are supported (memory provider)\n",
            });
            exitCode = 1;

            return;
          }

          for (const path of args.slice(1)) node(id, posix.resolve(cwd, path)).mode = mode;
          exitCode = 0;

          return;
        }

        if (name === "stat" && args[0] === "-c" && args[1] === "%a") {
          for (const path of args.slice(2))
            input.onChunk({
              stream: "stdout",
              text: `${node(id, posix.resolve(cwd, path)).mode.toString(8)}\n`,
            });
          exitCode = 0;

          return;
        }

        const handler = handlers.get(name);

        if (!handler) {
          input.onChunk({
            stream: "stderr",
            text: `${name}: command not found (memory handler not registered)\n`,
          });
          exitCode = 127;

          return;
        }

        let output = "";

        const emit = (stream: "stdout" | "stderr", text: string) => {
          if (!controller.signal.aborted) {
            if (redirect && stream === "stdout") output += text;
            else input.onChunk({ stream, text });
          }
        };

        exitCode = await handler({
          args,
          cwd,
          env,
          stdin: input.stdin ?? "",
          signal: controller.signal,
          stdout: (text) => emit(stderrIndex >= 0 ? "stderr" : "stdout", text),
          stderr: (text) => emit("stderr", text),
          files: {
            read: (path) => files.read(id, posix.resolve(cwd, path)),
            write: (path, data) =>
              files.write(
                id,
                posix.resolve(cwd, path),
                data instanceof Uint8Array ? data : new TextEncoder().encode(data),
              ),
            list: (path) => files.list(id, posix.resolve(cwd, path)),
          },
        });

        if (redirect)
          await files.write(id, posix.resolve(cwd, redirect), new TextEncoder().encode(output));
      }

      for (const token of tokens) {
        if (token.operator && [";", "&&", "||"].includes(token.text)) await runSegment(token.text);
        else segment.push(token);
      }

      await runSegment(";");

      return { exitCode: timedOut ? null : exitCode, timedOut };
    } finally {
      if (input.activityPath) {
        m.nodes.delete(input.activityPath);

        if (machines.has(id)) machine(id);
      }

      m.active.delete(controller);
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  }

  const provider: Provider<MemoryNative, "network-policy"> & {
    register(name: string, handler: CommandHandler): void;
  } = {
    name: "memory",
    inlineActivity: true,
    processMode: "stream",
    previewMode: "placeholder",
    keyMode: "exact",
    capabilities: new Set<"network-policy">(["network-policy"]),
    files,
    register(name, handler) {
      handlers.set(name, handler);
    },
    async create(input: CreateInput) {
      if (input.size !== undefined)
        throw new SandboxError(
          "Memory cannot enforce machine size. Omit size or choose a provider with size support.",
          { code: "unsupported", provider: "memory" },
        );

      if (input.key) {
        const existing = [...machines.values()].find((m) => m.info.key === input.key);

        if (existing)
          throw new SandboxError(
            "Key already exists. Another caller created it. Find the existing sandbox.",
            { code: "provider", provider: "memory" },
          );
      }

      const id = `mem-${crypto.randomUUID()}`;

      const info: SandboxInfo = {
        id,
        key: input.key,
        labels: { ...input.labels },
        state: "running",
        createdAt: now(),
      };

      machines.set(id, {
        info,
        nodes: new Map(),
        env: { ...input.env },
        processes: new Map(),
        nextPid: 100,
        active: new Set(),
        idleTimeoutMs: input.idleTimeoutMs,
      });

      if (input.timeoutMs) {
        const m = machine(id);
        m.lifetimeTimer = setTimeout(() => {
          void provider.destroy(id);
        }, input.timeoutMs);
        m.lifetimeTimer.unref?.();
      }

      mkdir(id, "/workspace");
      mkdir(id, "/tmp");

      return info;
    },
    async find(key) {
      return [...machines.values()].find((m) => m.info.key === key)?.info;
    },
    async connect(id) {
      return machine(id).info;
    },
    async list(labels) {
      const matches: SandboxInfo[] = [];

      for (const { info } of machines.values())
        if (Object.entries(labels).every(([key, value]) => info.labels[key] === value))
          matches.push(info);

      return matches;
    },
    async destroy(id) {
      const m = machines.get(id);

      if (!m) return;
      clearTimeout(m.idleTimer);
      clearTimeout(m.lifetimeTimer);

      for (const controller of m.active) controller.abort();

      for (const proc of m.processes.values()) proc.controller.abort();
      await Promise.allSettled([...m.processes.values()].map((proc) => proc.result));
      machines.delete(id);
    },
    exec: execute,
    // The fake has no shell conditionals or `env -0`, so it answers recovery directly.
    async readSecretEnvironment(id) {
      const m = machine(id);
      const record = m.nodes.get("/tmp/.sandbox-sdk/secret-names.json");

      if (!record?.data) return undefined;

      return { record: new TextDecoder().decode(record.data), environment: { ...m.env } };
    },
    async previewUrl(id, port) {
      machine(id);

      return { url: `https://${id}-${port}.memory.invalid/` };
    },
    native(id) {
      return { files: machine(id).nodes };
    },
    async startProcess(id, input): Promise<NativeProcess> {
      const m = machine(id);
      const pid = m.nextPid++;
      const controller = new AbortController();
      const result = execute(id, { ...input, timeoutMs: 2_147_483_647, signal: controller.signal });
      m.processes.set(pid, { controller, result });
      void result.then(
        () => m.processes.delete(pid),
        () => m.processes.delete(pid),
      );

      return {
        pid,
        wait: async () => {
          const exit = await result;

          return {
            exitCode: exit.timedOut ? 143 : exit.exitCode,
            signal: exit.timedOut ? "SIGTERM" : null,
          };
        },
        stop: async () => {
          controller.abort();
          await result;
        },
      };
    },
  };

  return provider;
}
