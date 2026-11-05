/**
 * A Docker-free test provider: each "sandbox" is a directory under a temp root, commands run in real
 * bash on this machine, and files are real files. The guest paths `/workspace` and `/tmp/.sandbox-sdk`
 * are mapped into the sandbox's directory in commands, paths, env and output, so nothing lands in the
 * host's real /workspace or /tmp. `pause` sends SIGSTOP to every process group the sandbox started and
 * `resume` SIGCONT; `pauseMode: "lossy"` kills them instead, like a cold restore. Tests only: it is not
 * isolation of any kind.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import type {
  ExecInput,
  ExecResult,
  FileInfo,
  NativeProcess,
  Provider,
  SandboxInfo,
} from "@opencoredev/sandbox-sdk/provider";

interface HostMachine {
  info: SandboxInfo;
  dir: string;
  groups: Set<ChildProcess>;
}

export interface HostProvider extends Provider<{ dir: string }, "pause"> {
  readonly root: string;
  pauseMode: "preserve" | "lossy";
  dispose(): Promise<void>;
}

export async function hostProvider(): Promise<HostProvider> {
  const root = await mkdtemp(join(tmpdir(), "rw-host-"));
  const machines = new Map<string, HostMachine>();
  let next = 0;

  const machine = (id: string) => {
    const value = machines.get(id);

    if (!value)
      throw new SandboxError(`Sandbox ${id} not found. Host sandbox is gone. Create a new one.`, {
        code: "not_found",
        provider: "host",
      });

    return value;
  };

  const inward = (m: HostMachine, text: string) =>
    text
      .replaceAll("/tmp/.sandbox-sdk", `${m.dir}/sdk`)
      .replaceAll("/workspace", `${m.dir}/workspace`);

  const outward = (m: HostMachine, text: string) =>
    text
      .replaceAll(`${m.dir}/workspace`, "/workspace")
      .replaceAll(`${m.dir}/sdk`, "/tmp/.sandbox-sdk");

  const fail = (path: string) =>
    new SandboxError(`File ${path} not found. Host path does not exist. Check the path.`, {
      code: "file_not_found",
      provider: "host",
    });

  const launch = (m: HostMachine, input: Omit<ExecInput, "timeoutMs">) => {
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: `${m.dir}/home`,
      LANG: "C.UTF-8",
      ...Object.fromEntries(
        Object.entries(input.env).map(([key, value]) => [key, inward(m, value)]),
      ),
    };

    const child = spawn("bash", ["-c", inward(m, input.command)], {
      cwd: inward(m, input.cwd),
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    m.groups.add(child);
    child.once("exit", () => m.groups.delete(child));
    child.stdout?.on("data", (data: Buffer) =>
      input.onChunk({ stream: "stdout", text: outward(m, data.toString("utf8")) }),
    );
    child.stderr?.on("data", (data: Buffer) =>
      input.onChunk({ stream: "stderr", text: outward(m, data.toString("utf8")) }),
    );
    child.stdin?.end(input.stdin ?? "");

    return child;
  };

  const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (child.pid === undefined || child.exitCode !== null) return;

    try {
      process.kill(-child.pid, signal);
    } catch {
      /* already gone */
    }
  };

  const exited = (child: ChildProcess) =>
    new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once("close", (code) => resolve(code));
    });

  const info = async (m: HostMachine, path: string): Promise<FileInfo> => {
    try {
      const value = await stat(inward(m, path));

      return {
        path,
        type: value.isDirectory() ? "directory" : value.isSymbolicLink() ? "symlink" : "file",
        size: value.size,
        modifiedAt: value.mtimeMs,
      };
    } catch {
      throw fail(path);
    }
  };

  const provider: HostProvider = {
    name: "host",
    keyMode: "exact",
    root,
    pauseMode: "preserve",
    capabilities: new Set(["pause"]),
    async create(input) {
      const id = `host-${++next}`;
      const dir = join(root, id);
      await mkdir(join(dir, "workspace"), { recursive: true });
      await mkdir(join(dir, "sdk"), { recursive: true });
      await mkdir(join(dir, "home"), { recursive: true });

      const created: SandboxInfo = {
        id,
        labels: { ...input.labels },
        state: "running",
        createdAt: Date.now(),
      };

      if (input.key) created.key = input.key;
      machines.set(id, { info: created, dir, groups: new Set() });

      return created;
    },
    async find(key) {
      return [...machines.values()].find((m) => m.info.key === key)?.info;
    },
    async connect(id) {
      return machine(id).info;
    },
    async list(labels) {
      const matches: SandboxInfo[] = [];

      for (const { info: item } of machines.values())
        if (Object.entries(labels).every(([key, value]) => item.labels[key] === value))
          matches.push(item);

      return matches;
    },
    async destroy(id) {
      const m = machines.get(id);

      if (!m) return;

      for (const child of m.groups) signalGroup(child, "SIGKILL");
      machines.delete(id);
      await rm(m.dir, { recursive: true, force: true });
    },
    async exec(id, input): Promise<ExecResult> {
      const m = machine(id);
      const child = launch(m, input);
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        signalGroup(child, "SIGKILL");
      }, input.timeoutMs);

      const abort = () => signalGroup(child, "SIGKILL");
      input.signal?.addEventListener("abort", abort, { once: true });

      try {
        const code = await exited(child);

        return { exitCode: timedOut || input.signal?.aborted ? null : code, timedOut };
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
      }
    },
    files: {
      writeCreatesParents: true,
      writeSupportsMode: true,
      async read(id, path) {
        try {
          return new Uint8Array(await readFile(inward(machine(id), path)));
        } catch {
          throw fail(path);
        }
      },
      async write(id, path, data, options) {
        const target = inward(machine(id), path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);

        if (options?.mode !== undefined) await chmod(target, options.mode);
      },
      async list(id, path) {
        const m = machine(id);

        try {
          const names = await readdir(inward(m, path));

          return Promise.all(
            names.sort().map((name) => info(m, `${path.replace(/\/$/, "")}/${name}`)),
          );
        } catch {
          throw fail(path);
        }
      },
      async stat(id, path) {
        return info(machine(id), path);
      },
      async remove(id, path, options) {
        await rm(inward(machine(id), path), { recursive: options.recursive, force: true });
      },
      async mkdir(id, path) {
        await mkdir(inward(machine(id), path), { recursive: true });
      },
    },
    async previewUrl(id, port) {
      machine(id);

      return { url: `https://${id}-${port}.host.invalid/` };
    },
    native(id) {
      return { dir: machine(id).dir };
    },
    async pause(id) {
      const m = machine(id);

      for (const child of m.groups)
        signalGroup(child, provider.pauseMode === "lossy" ? "SIGKILL" : "SIGSTOP");
      m.info.state = "paused";
    },
    async resume(id) {
      const m = machine(id);

      for (const child of m.groups) signalGroup(child, "SIGCONT");
      m.info.state = "running";
    },
    async startProcess(id, input): Promise<NativeProcess> {
      const m = machine(id);
      const child = launch(m, input);
      const done = exited(child);

      return {
        pid: child.pid ?? 0,
        wait: async () => {
          const code = await done;

          return { exitCode: code, signal: child.signalCode };
        },
        stop: async ({ graceMs }) => {
          signalGroup(child, "SIGTERM");
          const timer = setTimeout(() => signalGroup(child, "SIGKILL"), graceMs);
          await done;
          clearTimeout(timer);
        },
      };
    },
    async dispose() {
      for (const id of Array.from(machines.keys())) await provider.destroy(id);
      await rm(root, { recursive: true, force: true });
    },
  };

  return provider;
}
