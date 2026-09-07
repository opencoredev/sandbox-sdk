import { defineAdapter } from "../../core/adapter";
import type { SandboxAdapter } from "../../core/adapter";
import { SandboxError } from "../../core/errors";
import type { ProviderCreateOptions, SandboxRuntime } from "../../core/provider";
import type { CommandResult, SandboxDirectoryEntry } from "../../core/types";
import {
  assertNotAborted,
  commandString,
  portResult,
  toUint8Array,
  unsupported,
  unsupportedSnapshots,
} from "../../internal/provider-utils";
import { cloudflareCapabilities } from "../capabilities";

export interface CloudflareGetSandboxOptions {
  sleepAfter?: string;
  keepAlive?: boolean;
  enableDefaultSession?: boolean;
  normalizeId?: boolean;
}

export interface CloudflareExecResult {
  success?: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CloudflareFileResult {
  content?: string;
  encoding?: string;
}

export interface CloudflareListEntry {
  name: string;
  path?: string;
  type?: "file" | "directory" | string;
  size?: number;
}

export interface CloudflareSandboxClient {
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeout?: number;
      stdin?: string;
    },
  ): Promise<CloudflareExecResult>;
  writeFile(path: string, content: string, options?: { encoding?: "utf-8" | "base64" }): Promise<void>;
  readFile(path: string, options?: { encoding?: "utf-8" | "base64" | "none" }): Promise<
    string | CloudflareFileResult
  >;
  exists(path: string): Promise<boolean | { exists: boolean }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  deleteFile(path: string): Promise<void>;
  moveFile?(source: string, destination: string): Promise<void>;
  listFiles?(path: string): Promise<CloudflareListEntry[]>;
  exposePort(port: number): Promise<string | { url?: string }>;
  setKeepAlive?(keepAlive: boolean): Promise<void>;
  destroy(): Promise<void>;
}

export interface CloudflareOptions {
  /** Durable Object namespace from the Worker `env` binding. */
  namespace: unknown;
  /** Official `getSandbox` from `@cloudflare/sandbox`. */
  getSandbox: (
    namespace: unknown,
    id: string,
    options?: CloudflareGetSandboxOptions,
  ) => CloudflareSandboxClient | Promise<CloudflareSandboxClient>;
  /** Reused as the Cloudflare sandbox id. Same id returns the same container. */
  id?: string;
  sleepAfter?: string;
  keepAlive?: boolean;
}

export { cloudflareCapabilities } from "../capabilities";

export function cloudflare(options: CloudflareOptions): SandboxAdapter<CloudflareSandboxClient> {
  if (options.namespace === undefined || options.namespace === null) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "cloudflare",
      operation: "sandbox.create",
      message: "cloudflare() needs the Worker Sandbox binding as namespace",
    });
  }
  if (typeof options.getSandbox !== "function") {
    throw new SandboxError({
      code: "invalid_input",
      provider: "cloudflare",
      operation: "sandbox.create",
      message: "cloudflare() needs getSandbox from @cloudflare/sandbox",
    });
  }

  const getOptions: CloudflareGetSandboxOptions = {
    sleepAfter: options.sleepAfter,
    keepAlive: options.keepAlive,
    enableDefaultSession: false,
  };

  const open = async (id: string): Promise<CloudflareSandboxClient> =>
    options.getSandbox(options.namespace, id, getOptions);

  const runtime = async (
    raw: CloudflareSandboxClient,
    id: string,
  ): Promise<SandboxRuntime<CloudflareSandboxClient>> => {
    return {
      id,
      raw,
      capabilities: cloudflareCapabilities,
      files: {
        async write(path, value) {
          if (typeof value === "string") {
            await raw.writeFile(path, value);
            return;
          }
          await raw.writeFile(path, encodeBase64(await toUint8Array(value)), {
            encoding: "base64",
          });
        },
        async read(path) {
          return readFileBytes(await raw.readFile(path));
        },
        async list(path) {
          if (typeof raw.listFiles === "function") {
            return (await raw.listFiles(path)).map((entry) => ({
              name: entry.name,
              path: entry.path ?? joinPath(path, entry.name),
              type: entry.type === "directory" ? "directory" : "file",
              size: entry.size,
            }));
          }
          return listWithLs(raw, path);
        },
        async mkdir(path) {
          await raw.mkdir(path, { recursive: true });
        },
        async remove(path) {
          try {
            await raw.deleteFile(path);
          } catch {
            const result = await raw.exec(
              commandString({ command: "rm", args: ["-rf", "--", path] }),
            );
            if (result.exitCode !== 0) {
              throw new SandboxError({
                code: "internal",
                provider: "cloudflare",
                operation: "files.remove",
                message: result.stderr || result.stdout || "files.remove failed",
              });
            }
          }
        },
        async exists(path) {
          const result = await raw.exists(path);
          if (typeof result === "boolean") return result;
          return Boolean(result.exists);
        },
        move: raw.moveFile
          ? async (source, destination) => {
              await raw.moveFile?.(source, destination);
            }
          : undefined,
      },
      async run(command, runOptions) {
        assertNotAborted(runOptions.signal);
        const started = performance.now();
        const result = await raw.exec(commandString(command), {
          cwd: runOptions.cwd,
          env: runOptions.env ? { ...runOptions.env } : undefined,
          timeout: runOptions.timeout,
        });
        assertNotAborted(runOptions.signal);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          success: result.success ?? result.exitCode === 0,
          durationMs: Math.round(performance.now() - started),
        } satisfies CommandResult;
      },
      async start() {
        unsupported("cloudflare", "process.start");
      },
      async expose(port) {
        const exposed = await raw.exposePort(port);
        const url = typeof exposed === "string" ? exposed : exposed.url;
        if (!url) {
          throw new SandboxError({
            code: "internal",
            provider: "cloudflare",
            operation: "ports.expose",
            message: "exposePort returned no URL",
          });
        }
        return portResult(port, url, true, false);
      },
      snapshots: unsupportedSnapshots("cloudflare"),
      async destroy() {
        await raw.destroy();
      },
      async stop() {
        if (typeof raw.setKeepAlive === "function") await raw.setKeepAlive(false);
      },
    };
  };

  return defineAdapter({
    id: "cloudflare",
    capabilities: cloudflareCapabilities,
    async create(createOptions: ProviderCreateOptions) {
      assertNotAborted(createOptions.signal);
      const id = options.id ?? `sdk-${crypto.randomUUID()}`;
      const raw = await open(id);
      try {
        assertNotAborted(createOptions.signal);
        await raw.mkdir(createOptions.cwd, { recursive: true });
      } catch (error) {
        await raw.destroy().catch(() => undefined);
        throw error;
      }
      return runtime(raw, id);
    },
    async connect(connectOptions) {
      assertNotAborted(connectOptions.signal);
      const raw = await open(connectOptions.id);
      assertNotAborted(connectOptions.signal);
      return runtime(raw, connectOptions.id);
    },
  });
}

function joinPath(root: string, name: string): string {
  return `${root.replace(/\/$/, "")}/${name}`;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function readFileBytes(result: string | CloudflareFileResult): Uint8Array {
  if (typeof result === "string") return new TextEncoder().encode(result);
  const content = result.content;
  if (content === undefined) {
    throw new SandboxError({
      code: "internal",
      provider: "cloudflare",
      operation: "files.read",
      message: "readFile returned no content",
    });
  }
  if (result.encoding === "base64") return decodeBase64(content);
  return new TextEncoder().encode(content);
}

async function listWithLs(
  raw: CloudflareSandboxClient,
  path: string,
): Promise<SandboxDirectoryEntry[]> {
  const result = await raw.exec(commandString({ command: "ls", args: ["-1Ap", "--", path] }));
  if (result.exitCode !== 0) {
    throw new SandboxError({
      code: "not_found",
      provider: "cloudflare",
      operation: "files.list",
      message: result.stderr || result.stdout || `cannot list ${path}`,
    });
  }
  const entries: SandboxDirectoryEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    const name = line.trim();
    if (!name || name === "./" || name === "../") continue;
    const isDirectory = name.endsWith("/");
    const clean = isDirectory ? name.slice(0, -1) : name;
    entries.push({
      name: clean,
      path: joinPath(path, clean),
      type: isDirectory ? "directory" : "file",
    });
  }
  return entries;
}
