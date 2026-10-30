/** Test-only Linux transport. Every remote path maps into a disposable directory. */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { spawn } from "node:child_process";
import type { Provider, SandboxInfo, FileInfo } from "../src/provider.js";
import { SandboxError } from "../src/index.js";
import { guestInputVariable, mapGuestInput } from "./guest-input.js";

export async function shellProvider(): Promise<Provider> {
  const root = await fs.mkdtemp(join(tmpdir(), "sdk-shell-"));
  let info: SandboxInfo | undefined;
  let environment: Record<string, string> = {};
  const mapped = (path: string) => join(root, path);

  const rewrite = (command: string) =>
    command.replace(/\/workspace|\/tmp\/\.sandbox-sdk|\/tmp\/sdk-bare/g, (path) => mapped(path));

  async function stat(path: string): Promise<FileInfo> {
    try {
      const value = await fs.lstat(mapped(path));

      return {
        path,
        type: value.isDirectory() ? "directory" : value.isSymbolicLink() ? "symlink" : "file",
        size: value.size,
        modifiedAt: value.mtimeMs,
      };
    } catch {
      throw new SandboxError("File missing. Path does not exist. Check the path.", {
        code: "file_not_found",
      });
    }
  }

  return {
    name: "shell-test",
    keyMode: "exact",
    capabilities: new Set(),
    async create(input) {
      info = {
        id: "shell",
        key: input.key,
        labels: input.labels,
        state: "running",
        createdAt: Date.now(),
      };
      environment = input.env ?? {};
      await fs.mkdir(mapped("/workspace"), { recursive: true });

      return info;
    },
    async find() {
      return info;
    },
    async connect() {
      if (!info)
        throw new SandboxError("Missing sandbox. It was destroyed. Create another.", {
          code: "not_found",
        });

      return info;
    },
    async list() {
      return info ? [info] : [];
    },
    async destroy() {
      info = undefined;
      await fs.rm(root, { recursive: true, force: true });
    },
    native() {
      return root;
    },
    async previewUrl(_, port) {
      return { url: `http://unused.invalid:${port}/` };
    },
    files: {
      async read(_, path) {
        return new Uint8Array(await fs.readFile(mapped(path)));
      },
      async write(_, path, data) {
        await fs.writeFile(mapped(path), data);
      },
      async mkdir(_, path) {
        await fs.mkdir(mapped(path), { recursive: true });
      },
      stat: (_, path) => stat(path),
      async list(_, path) {
        return Promise.all(
          (await fs.readdir(mapped(path))).map((name) => stat(posix.join(path, name))),
        );
      },
      async remove(_, path, options) {
        await fs.rm(mapped(path), { recursive: options.recursive });
      },
    },
    async exec(_, input) {
      return await new Promise((resolve, reject) => {
        const env = { ...process.env, ...environment, ...input.env };

        if (env.GIT_INDEX_FILE) env.GIT_INDEX_FILE = rewrite(env.GIT_INDEX_FILE);
        const guest = env[guestInputVariable] !== undefined;

        if (env[guestInputVariable])
          env[guestInputVariable] = mapGuestInput(env[guestInputVariable], mapped);

        const child = spawn("sh", ["-c", rewrite(input.command)], {
          cwd: mapped(input.cwd),
          env,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let timedOut = false;

        const abort = () => {
          timedOut = true;

          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
        };

        const timer = setTimeout(abort, input.timeoutMs);
        input.signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (data) =>
          input.onChunk({ stream: "stdout", text: data.toString() }),
        );
        child.stderr.on("data", (data) =>
          input.onChunk({ stream: "stderr", text: data.toString() }),
        );
        child.stdin.on("error", () => {});
        child.stdin.end(guest && input.stdin ? mapGuestInput(input.stdin, mapped) : input.stdin);
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
          resolve({ exitCode: timedOut ? null : code, timedOut });
        });

        if (input.signal?.aborted) abort();
      });
    },
  };
}
