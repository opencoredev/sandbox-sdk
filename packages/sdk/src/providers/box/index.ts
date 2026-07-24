import { BoxApi, Configuration, type Box as NativeBox } from "@asciidev/box-sdk";
import { SandboxError } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type { CommandInput } from "../../core/types";
import { withManagedSessions } from "../../internal/managed-provider";
import {
  commandString,
  portResult,
  toUint8Array,
  unsupported,
  unsupportedSnapshots,
} from "../../internal/provider-utils";
import { boxCapabilities } from "../capabilities";

const DEFAULT_BASE_URL = "https://ascii.dev/api/box/v1";
const MAX_COMMAND_TIMEOUT_MS = 60_000;

export interface BoxOptions {
  /** Box API key. Defaults to BOX_API_KEY. */
  apiKey?: string;
  /** Box API base URL. Defaults to BOX_BASE_URL, then the public v1 endpoint. */
  baseUrl?: string;
  /** Seconds before Box automatically archives. The service default is one hour. */
  ttlSeconds?: number | null;
  /** Withhold account-level secrets from the Box. */
  noEnv?: boolean;
  /** Friendly Box name applied after provisioning. */
  name?: string;
  /** Return ungated hosted URLs instead of protected URLs. Defaults to true. */
  public?: boolean;
  /** Maximum time to wait for provisioning, in milliseconds. Defaults to 10 minutes. */
  readyTimeout?: number;
}

export interface AsciiBoxSandbox {
  readonly client: BoxApi;
  box: NativeBox;
  readonly readyTimeoutMs: number;
}

export { boxCapabilities } from "../capabilities";

export function box(options: BoxOptions = {}): SandboxProvider<AsciiBoxSandbox> {
  const readyTimeoutMs = options.readyTimeout ?? 600_000;
  const publicPorts = options.public ?? true;

  const provider: SandboxProvider<AsciiBoxSandbox> = {
    id: "box",
    capabilities: boxCapabilities,
    async create(createOptions) {
      const apiKey = options.apiKey ?? process.env.BOX_API_KEY;
      if (!apiKey) {
        throw new SandboxError({
          code: "authentication",
          provider: "box",
          operation: "sandbox.create",
          message: "BOX_API_KEY is required to create an Ascii Box",
        });
      }
      const client = new BoxApi(
        new Configuration({
          basePath: options.baseUrl ?? process.env.BOX_BASE_URL ?? DEFAULT_BASE_URL,
          accessToken: apiKey,
        }),
      );
      assertNotAborted(createOptions.signal);
      const created = await client.create(
        {
          createBoxRequest: {
            ttlSeconds: options.ttlSeconds,
            noEnv: options.noEnv,
            env: { ...createOptions.env },
          },
        },
        { signal: createOptions.signal },
      );
      const id = created.box.id;
      let native: AsciiBoxSandbox | undefined;
      try {
        const ready = await waitUntilBoxReady(
          client,
          id,
          createOptions.signal,
          createOptions.timeout ?? readyTimeoutMs,
        );
        native = { client, box: ready, readyTimeoutMs };
        if (options.name) {
          native.box = (
            await client.update({ boxId: id, updateBoxRequest: { name: options.name } })
          ).box;
        }

        const remoteRoot = toRemotePath(createOptions.cwd);
        const mkdir = await execute(client, id, {
          command: commandString({ command: "mkdir", args: ["-p", "--", remoteRoot] }),
          timeoutMs: MAX_COMMAND_TIMEOUT_MS,
          signal: createOptions.signal,
        });
        assertSucceeded(mkdir, "sandbox.create.cwd");
        return {
          id,
          raw: native,
          capabilities: boxCapabilities,
          files: {
            async write(path, value) {
              const remotePath = toRemotePath(path);
              const parent = remotePath.includes("/")
                ? remotePath.slice(0, remotePath.lastIndexOf("/"))
                : ".";
              const mkdirResult = await execute(client, id, {
                command: commandString({ command: "mkdir", args: ["-p", "--", parent] }),
                timeoutMs: MAX_COMMAND_TIMEOUT_MS,
              });
              assertSucceeded(mkdirResult, "files.write.mkdir");
              await client.writeFile({
                boxId: id,
                fileWriteRequest: {
                  path: remotePath,
                  content: Buffer.from(await toUint8Array(value)).toString("base64"),
                  encoding: "base64",
                },
              });
            },
            async read(path) {
              const response = await client.readFile({
                boxId: id,
                path: toRemotePath(path),
                encoding: "base64",
              });
              return new Uint8Array(Buffer.from(response.content, "base64"));
            },
            async list(path) {
              const result = await execute(client, id, {
                command: commandString({
                  command: "python3",
                  args: ["-c", DIRECTORY_LIST_SCRIPT, toRemotePath(path)],
                }),
                timeoutMs: MAX_COMMAND_TIMEOUT_MS,
              });
              assertSucceeded(result, "files.list");
              const entries = JSON.parse(result.stdout) as NativeDirectoryEntry[];
              return entries.map((entry) => ({
                name: entry.name,
                path: toVirtualPath(entry.path),
                type: entry.type,
                size: entry.type === "file" ? entry.size : undefined,
              }));
            },
            async mkdir(path) {
              const result = await execute(client, id, {
                command: commandString({
                  command: "mkdir",
                  args: ["-p", "--", toRemotePath(path)],
                }),
                timeoutMs: MAX_COMMAND_TIMEOUT_MS,
              });
              assertSucceeded(result, "files.mkdir");
            },
            async remove(path) {
              const result = await execute(client, id, {
                command: commandString({
                  command: "rm",
                  args: ["-rf", "--", toRemotePath(path)],
                }),
                timeoutMs: MAX_COMMAND_TIMEOUT_MS,
              });
              assertSucceeded(result, "files.remove");
            },
            async exists(path) {
              const result = await execute(client, id, {
                command: commandString({
                  command: "test",
                  args: ["-e", toRemotePath(path)],
                }),
                timeoutMs: MAX_COMMAND_TIMEOUT_MS,
              });
              if (result.exitCode === 0) return true;
              if (result.exitCode === 1) return false;
              assertSucceeded(result, "files.exists");
              return false;
            },
          },
          async run(command, runOptions) {
            const result = await execute(client, id, {
              command: withEnvironment(command, runOptions.env),
              cwd: toRemotePath(runOptions.cwd!),
              timeoutMs: runOptions.timeout,
              signal: runOptions.signal,
            });
            if (result.timedOut) {
              throw new SandboxError({
                code: "timeout",
                provider: "box",
                operation: "process.run",
                message: `Command timed out after ${runOptions.timeout ?? 30_000}ms`,
              });
            }
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode ?? 1,
              success: result.success,
              signal: result.signal ?? undefined,
              durationMs:
                result.startedAt && result.finishedAt
                  ? result.finishedAt.getTime() - result.startedAt.getTime()
                  : undefined,
            };
          },
          async start() {
            unsupported("box", "process.start");
          },
          async expose(port) {
            const visibility = publicPorts ? "--public" : "--private";
            const hosted = await execute(client, id, {
              command: `host ${port} ${visibility}`,
              timeoutMs: MAX_COMMAND_TIMEOUT_MS,
            });
            assertSucceeded(hosted, "ports.expose");
            const resolved = await execute(client, id, {
              command: `host url ${port}${publicPorts ? " --public" : ""}`,
              timeoutMs: MAX_COMMAND_TIMEOUT_MS,
            });
            assertSucceeded(resolved, "ports.expose.url");
            const url =
              findUrl(`${resolved.stdout}\n${resolved.stderr}`) ??
              findUrl(`${hosted.stdout}\n${hosted.stderr}`);
            if (!url) throw new Error(`Box host command did not return a URL for port ${port}`);
            const protectedUrl = new URL(url).searchParams.has("_token");
            const exposedUrl = protectedUrl ? withoutProtectedToken(url) : url;
            return portResult(
              port,
              exposedUrl,
              !protectedUrl,
              protectedUrl,
              protectedUrl
                ? (path = "/", init = {}) => fetch(withProtectedPath(url, path), init)
                : undefined,
            );
          },
          snapshots: unsupportedSnapshots("box"),
          async stop() {
            await destroyBox(client, id, readyTimeoutMs);
          },
        };
      } catch (error) {
        await destroyBox(client, id, readyTimeoutMs).catch(() => undefined);
        throw error;
      }
    },
  };

  return withManagedSessions(provider, [], {
    async stop(sandbox) {
      await sandbox.raw.client.stop({ boxId: sandbox.id });
      sandbox.raw.box = await waitForState(
        sandbox.raw.client,
        sandbox.id,
        ["archived"],
        sandbox.raw.readyTimeoutMs,
      );
    },
    async resume(sandbox) {
      await sandbox.raw.client.resume({ boxId: sandbox.id });
      sandbox.raw.box = await waitUntilBoxReady(
        sandbox.raw.client,
        sandbox.id,
        undefined,
        sandbox.raw.readyTimeoutMs,
      );
    },
    async destroy(sandbox) {
      await destroyBox(sandbox.raw.client, sandbox.id, sandbox.raw.readyTimeoutMs);
    },
  });
}

interface NativeDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "unknown";
  size: number;
}

const DIRECTORY_LIST_SCRIPT = [
  "import json, os, sys",
  "result = []",
  "for entry in os.scandir(sys.argv[1]):",
  "    kind = 'symlink' if entry.is_symlink() else ('directory' if entry.is_dir() else ('file' if entry.is_file() else 'unknown'))",
  "    result.append({'name': entry.name, 'path': entry.path, 'type': kind, 'size': entry.stat(follow_symlinks=False).st_size})",
  "print(json.dumps(result))",
].join("\n");

type CommandResponse = Awaited<ReturnType<BoxApi["command"]>>;

async function execute(
  client: BoxApi,
  boxId: string,
  options: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<CommandResponse> {
  assertNotAborted(options.signal);
  if (options.timeoutMs !== undefined && options.timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "box",
      operation: "process.run",
      message: "Ascii Box commands support a maximum timeout of 60000ms",
    });
  }
  return client.command(
    {
      boxId,
      commandRequest: {
        command: options.command,
        cwd: options.cwd,
        timeoutSeconds:
          options.timeoutMs === undefined
            ? undefined
            : Math.max(1, Math.ceil(options.timeoutMs / 1_000)),
      },
    },
    { signal: options.signal },
  );
}

function withEnvironment(
  input: CommandInput,
  environment: Readonly<Record<string, string>> | undefined,
): string {
  const command = commandString(input);
  const entries = Object.entries(environment ?? {});
  if (entries.length === 0) return command;
  const assignments = entries.map(([key, value]) => shellQuote(`${key}=${value}`));
  return `env ${assignments.join(" ")} sh -c ${shellQuote(command)}`;
}

function toRemotePath(path: string): string {
  return path === "/" ? "." : path.replace(/^\/+/, "");
}

function toVirtualPath(path: string): string {
  return `/${path.replace(/^\.\/?/, "")}`.replace(/\/$/, "") || "/";
}

function assertSucceeded(result: CommandResponse, operation: string): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `${operation} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
  );
}

function findUrl(output: string): string | undefined {
  return output.match(/https:\/\/[^\s"']+/)?.[0]?.replace(/[),.;]+$/, "");
}

function withProtectedPath(base: string, path: string): URL {
  const protectedUrl = new URL(base);
  const target = new URL(path, base);
  for (const [key, value] of protectedUrl.searchParams) target.searchParams.set(key, value);
  return target;
}

function withoutProtectedToken(url: string): string {
  const exposed = new URL(url);
  exposed.searchParams.delete("_token");
  return exposed.toString();
}

async function waitForState(
  client: BoxApi,
  boxId: string,
  states: ReadonlyArray<NativeBox["state"]>,
  timeoutMs: number,
): Promise<NativeBox> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = (await client.get({ boxId })).box;
    if (states.includes(current.state)) return current;
    if (current.state === "error") throw new Error("Box entered terminal state error");
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Box state");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function destroyBox(client: BoxApi, boxId: string, timeoutMs: number): Promise<void> {
  try {
    await client.remove({ boxId });
    return;
  } catch (error) {
    if (!hasResponseStatus(error, 409)) throw error;
  }
  await client.stop({ boxId });
  await waitForState(client, boxId, ["archived"], timeoutMs);
  await client.remove({ boxId });
}

function hasResponseStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null &&
    "status" in error.response &&
    error.response.status === status
  );
}

async function waitUntilBoxReady(
  client: BoxApi,
  boxId: string,
  signal?: AbortSignal,
  timeoutMs = 600_000,
): Promise<NativeBox> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    assertNotAborted(signal);
    const current = (await client.get({ boxId }, { signal })).box;
    if (["ready", "idle", "running"].includes(current.state)) return current;
    if (["archived", "archiving", "error"].includes(current.state)) {
      throw new Error(`Box entered terminal state ${current.state}`);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Sandbox creation timed out after ${timeoutMs}ms`);
    }
    await abortableDelay(Math.min(1_000, remainingMs), signal);
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export type BoxSandbox = AsciiBoxSandbox;
