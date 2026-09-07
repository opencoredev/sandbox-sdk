import { defineAdapter } from "../../core/adapter";
import type { SandboxAdapter } from "../../core/adapter";
import { SandboxError } from "../../core/errors";
import type { SandboxProvider, SandboxRuntime } from "../../core/provider";
import type { CommandResult, SandboxDirectoryEntry, SandboxFileStat } from "../../core/types";
import {
  assertNotAborted,
  commandString,
  toUint8Array,
  unsupported,
  unsupportedSnapshots,
} from "../../internal/provider-utils";
import { memoryCapabilities } from "../capabilities";

export interface MemoryOptions {
  id?: string;
  files?: Readonly<Record<string, string | Uint8Array>>;
}

function normalize(path: string): string {
  const next = path.replace(/\/{2,}/g, "/");
  return next === "/" ? "/" : next.replace(/\/$/, "") || "/";
}

function parentOf(path: string): string {
  const normalized = normalize(path);
  if (normalized === "/") return "/";
  return normalized.slice(0, normalized.lastIndexOf("/")) || "/";
}

function basename(path: string): string {
  const normalized = normalize(path);
  if (normalized === "/") return "/";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function ok(stdout = "", stderr = "", exitCode = 0): CommandResult {
  return { stdout, stderr, exitCode, success: exitCode === 0 };
}

export function memory(options: MemoryOptions = {}): SandboxAdapter<{ id: string }> {
  const provider: SandboxProvider<{ id: string }> = {
    id: "memory",
    capabilities: memoryCapabilities,
    async create(createOptions) {
      assertNotAborted(createOptions.signal);
      const files = new Map<string, Uint8Array>();
      const dirs = new Set<string>(["/"]);
      const ensureDir = (path: string) => {
        let current = normalize(path);
        while (!dirs.has(current)) {
          dirs.add(current);
          current = parentOf(current);
        }
        dirs.add("/");
      };
      ensureDir(createOptions.cwd);
      for (const [path, value] of Object.entries(options.files ?? {})) {
        const resolved = path.startsWith("/") ? normalize(path) : normalize(`${createOptions.cwd}/${path}`);
        ensureDir(parentOf(resolved));
        files.set(
          resolved,
          typeof value === "string" ? new TextEncoder().encode(value) : value,
        );
      }

      const statPath = (path: string): SandboxFileStat => {
        const resolved = normalize(path);
        if (files.has(resolved)) {
          const data = files.get(resolved)!;
          return { path: resolved, type: "file", size: data.byteLength };
        }
        if (dirs.has(resolved) || [...files.keys()].some((entry) => entry.startsWith(`${resolved}/`))) {
          return { path: resolved, type: "directory", size: 0 };
        }
        throw new SandboxError({
          code: "not_found",
          provider: "memory",
          operation: "files.stat",
          message: `not found: ${resolved}`,
        });
      };

      const listPath = (path: string): SandboxDirectoryEntry[] => {
        const resolved = normalize(path);
        const names = new Map<string, SandboxDirectoryEntry>();
        for (const dir of dirs) {
          if (dir !== "/" && parentOf(dir) === resolved) {
            names.set(dir, { name: basename(dir), path: dir, type: "directory" });
          }
        }
        for (const [filePath, data] of files) {
          if (parentOf(filePath) === resolved) {
            names.set(filePath, {
              name: basename(filePath),
              path: filePath,
              type: "file",
              size: data.byteLength,
            });
          }
        }
        return [...names.values()].sort((left, right) => left.name.localeCompare(right.name));
      };

      const runtime: SandboxRuntime<{ id: string }> = {
        id: options.id ?? "memory",
        raw: { id: options.id ?? "memory" },
        capabilities: memoryCapabilities,
        files: {
          async write(path, value) {
            const resolved = normalize(path);
            ensureDir(parentOf(resolved));
            files.set(resolved, await toUint8Array(value));
            dirs.delete(resolved);
          },
          async read(path) {
            const resolved = normalize(path);
            const data = files.get(resolved);
            if (!data) {
              throw new SandboxError({
                code: "not_found",
                provider: "memory",
                operation: "files.read",
                message: `not found: ${resolved}`,
              });
            }
            return data;
          },
          async list(path) {
            return listPath(path);
          },
          async mkdir(path) {
            ensureDir(path);
          },
          async remove(path) {
            const resolved = normalize(path);
            files.delete(resolved);
            for (const filePath of files.keys()) {
              if (filePath.startsWith(`${resolved}/`)) files.delete(filePath);
            }
            for (const dir of dirs) {
              if (dir === resolved || dir.startsWith(`${resolved}/`)) dirs.delete(dir);
            }
          },
          async exists(path) {
            const resolved = normalize(path);
            return (
              files.has(resolved) ||
              dirs.has(resolved) ||
              [...files.keys()].some((entry) => entry.startsWith(`${resolved}/`))
            );
          },
          async stat(path) {
            return statPath(path);
          },
          async move(source, destination) {
            const from = normalize(source);
            const to = normalize(destination);
            if (files.has(from)) {
              files.set(to, files.get(from)!);
              files.delete(from);
              ensureDir(parentOf(to));
              return;
            }
            throw new SandboxError({
              code: "not_found",
              provider: "memory",
              operation: "files.move",
              message: `not found: ${from}`,
            });
          },
          async copy(source, destination) {
            const from = normalize(source);
            const to = normalize(destination);
            const data = files.get(from);
            if (!data) {
              throw new SandboxError({
                code: "not_found",
                provider: "memory",
                operation: "files.copy",
                message: `not found: ${from}`,
              });
            }
            files.set(to, data);
            ensureDir(parentOf(to));
          },
        },
        async run(command, runOptions) {
          const text = commandString(command).trim();
          if (runOptions?.timeout !== undefined && /^sleep\b/.test(text)) {
            throw new SandboxError({
              code: "timeout",
              provider: "memory",
              operation: "process.run",
              message: `Command timed out after ${runOptions.timeout}ms`,
            });
          }
          if (text === "true") return ok();
          if (text === "false" || text === "exit 2") return ok("", "", text === "false" ? 1 : 2);
          if (text === "pwd") return ok(`${createOptions.cwd}\n`);
          if (text.startsWith("echo ")) {
            const body = text.slice(5).replace(/^['"]|['"]$/g, "");
            if (text.endsWith(">&2")) return ok("", `${body.replace(/\s*>&2$/, "")}\n`);
            return ok(`${body}\n`);
          }
          if (text.startsWith("printf ")) {
            const body = text.slice(7).replace(/^['"]|['"]$/g, "");
            if (text.includes(">&2")) return ok("", `${body.replace(/\s*>&2$/, "")}`);
            return ok(body);
          }
          const cat = text.match(/^cat(?: --)? (.+)$/);
          if (cat) {
            const path = cat[1]!.replace(/^'|'$/g, "");
            const data = files.get(normalize(path));
            if (!data) return ok("", `not found: ${path}\n`, 1);
            return ok(decode(data));
          }
          const ls = text.match(/^ls(?: (.+))?$/);
          if (ls) {
            const path = ls[1] ? ls[1].replace(/^'|'$/g, "") : createOptions.cwd;
            return ok(`${listPath(path).map((entry) => entry.name).join("\n")}\n`);
          }
          const mkdir = text.match(/^mkdir(?: -p)? (.+)$/);
          if (mkdir) {
            ensureDir(mkdir[1]!.replace(/^'|'$/g, ""));
            return ok();
          }
          const rm = text.match(/^rm(?: -rf)? (.+)$/);
          if (rm) {
            await runtime.files.remove(rm[1]!.replace(/^'|'$/g, ""));
            return ok();
          }
          const stat = text.match(/^stat (?:-c|-f) '([^']+)' -- (.+)$/);
          if (stat) {
            const format = stat[1]!;
            const path = stat[2]!.replace(/^'|'$/g, "");
            try {
              const info = statPath(path);
              const type =
                info.type === "directory" ? "directory" : info.type === "file" ? "regular file" : info.type;
              if (format.includes("%F") || format.includes("%HT")) {
                return ok(`${type}|${info.size}|${Math.floor(Date.now() / 1000)}\n`);
              }
              return ok(`${info.path}|${info.size}|${Math.floor(Date.now() / 1000)}\n`);
            } catch {
              return ok("", `not found: ${path}\n`, 1);
            }
          }
          if (text.startsWith("find ")) {
            const rootMatch = text.match(/^find ('[^']+'|\S+)/);
            const root = (rootMatch?.[1] ?? createOptions.cwd).replace(/^'|'$/g, "");
            const prefix = normalize(root);
            const lines: string[] = [];
            const stamp = Math.floor(Date.now() / 1000);
            for (const [filePath, data] of files) {
              if (filePath === prefix || filePath.startsWith(`${prefix}/`)) {
                lines.push(`${filePath}|${data.byteLength}|${stamp}`);
              }
            }
            return ok(`${lines.join("\n")}\n`);
          }
          if (text.startsWith("git ")) return ok("", "git: not a git repository\n", 128);
          return ok("", `${text.split(" ")[0]}: command not found\n`, 127);
        },
        async start() {
          unsupported("memory", "process.start");
        },
        async expose() {
          unsupported("memory", "ports.expose");
        },
        snapshots: unsupportedSnapshots("memory"),
        async info() {
          return { state: "running" };
        },
        async destroy() {
          files.clear();
          dirs.clear();
          dirs.add("/");
        },
        async stop() {},
      };
      return runtime;
    },
  };
  return defineAdapter(provider);
}

export { memoryCapabilities };
