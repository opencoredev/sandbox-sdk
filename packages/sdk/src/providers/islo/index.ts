import { Islo } from "@islo-labs/sdk";
import { SandboxError } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type {
  CommandInput,
  CommandResult,
  ProcessOutputEvent,
  RunOptions,
  SandboxDirectoryEntry,
  SandboxProcess,
} from "../../core/types";
import { withManagedSessions } from "../../internal/managed-provider";
import {
  portResult,
  toUint8Array,
  unsupported,
  unsupportedSnapshots,
} from "../../internal/provider-utils";
import { isloCapabilities } from "../capabilities";

type IsloSandboxResponse = Awaited<ReturnType<Islo["sandboxes"]["createSandbox"]>>;

export interface IsloSandbox {
  readonly client: Islo;
  readonly sandbox: IsloSandboxResponse;
  readonly name: string;
  readonly computeUrl: string;
}

export interface IsloOptions {
  apiKey?: string;
  baseUrl?: string;
  computeUrl?: string;
  name?: string;
  image?: string;
  vcpus?: number;
  memoryMb?: number;
  diskGb?: number;
  gatewayProfile?: string;
  snapshotName?: string;
  user?: string;
  shareTtlSeconds?: number;
}

export { isloCapabilities } from "../capabilities";

export function islo(options: IsloOptions = {}): SandboxProvider<IsloSandbox> {
  const provider: SandboxProvider<IsloSandbox> = {
    id: "islo",
    capabilities: isloCapabilities,
    async create(createOptions) {
      const client = new Islo({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.computeUrl ? { computeUrl: options.computeUrl } : {}),
      });
      const computeUrl =
        options.computeUrl ?? process.env.ISLO_COMPUTE_URL ?? "https://ca.compute.islo.dev";
      const name = options.name ?? `sandbox-sdk-${crypto.randomUUID().slice(0, 12)}`;
      const sandbox = await client.sandboxes.createSandbox(
        {
          name,
          ...(options.image ? { image: options.image } : {}),
          ...(options.vcpus ? { vcpus: options.vcpus } : {}),
          ...(options.memoryMb ? { memory_mb: options.memoryMb } : {}),
          ...(options.diskGb ? { disk_gb: options.diskGb } : {}),
          ...(options.gatewayProfile ? { gateway_profile: options.gatewayProfile } : {}),
          ...(options.snapshotName ? { snapshot_name: options.snapshotName } : {}),
          ...(Object.keys(createOptions.env).length ? { env: { ...createOptions.env } } : {}),
          workdir: createOptions.cwd,
        },
        requestOptions(createOptions.signal, createOptions.timeout),
      );
      const sandboxName = sandbox.name;
      if (!sandboxName) {
        throw new SandboxError({
          code: "internal",
          provider: "islo",
          operation: "sandbox.create",
          message: "Islo returned a sandbox without a name",
        });
      }

      const raw: IsloSandbox = { client, sandbox, name: sandboxName, computeUrl };
      const execute = (command: CommandInput, runOptions: RunOptions) =>
        executeCommand(raw, command, {
          ...runOptions,
          env: { ...createOptions.env, ...runOptions.env },
          user: options.user,
        });

      try {
        await assertSuccess(
          await execute(argv("mkdir", "-p", "--", createOptions.cwd), {
            cwd: "/",
            signal: createOptions.signal,
          }),
          "files.mkdir",
        );
      } catch (error) {
        await client.sandboxes.deleteSandbox({ sandbox_name: sandboxName }).catch(() => undefined);
        throw error;
      }

      return {
        id: sandbox.id,
        raw,
        capabilities: isloCapabilities,
        files: {
          async write(path, value) {
            const content = Buffer.from(await toUint8Array(value)).toString("base64");
            await assertSuccess(
              await execute(
                argv(
                  "bash",
                  "-lc",
                  `parent=$(dirname -- ${shellQuote(path)}) && mkdir -p -- "$parent" && printf %s ${shellQuote(content)} | base64 -d > ${shellQuote(path)}`,
                ),
                { cwd: "/" },
              ),
              "files.write",
            );
          },
          async read(path) {
            const result = await execute(
              argv("bash", "-lc", `base64 -w0 -- ${shellQuote(path)}`),
              { cwd: "/" },
            );
            await assertSuccess(result, "files.read");
            return new Uint8Array(Buffer.from(result.stdout.replaceAll(/\s/g, ""), "base64"));
          },
          async list(path) {
            const result = await execute(
              argv("bash", "-lc", listScript(path)),
              { cwd: "/" },
            );
            await assertSuccess(result, "files.list");
            return parseDirectoryEntries(result.stdout);
          },
          async mkdir(path) {
            await assertSuccess(
              await execute(argv("mkdir", "-p", "--", path), { cwd: "/" }),
              "files.mkdir",
            );
          },
          async remove(path) {
            await assertSuccess(
              await execute(argv("rm", "-rf", "--", path), { cwd: "/" }),
              "files.remove",
            );
          },
          async exists(path) {
            const result = await execute(argv("test", "-e", path), { cwd: "/" });
            return result.exitCode === 0;
          },
        },
        run: execute,
        async start(command, runOptions) {
          return startCommand(raw, command, {
            ...runOptions,
            env: { ...createOptions.env, ...runOptions.env },
            user: options.user,
          });
        },
        async expose(port) {
          const ttlSeconds = Math.min(
            7 * 24 * 60 * 60,
            Math.max(60, Math.trunc(options.shareTtlSeconds ?? 24 * 60 * 60)),
          );
          const share = await client.shares.createShare({
            sandbox_name: sandboxName,
            port,
            ttl_seconds: ttlSeconds,
          });
          return portResult(port, share.url, true, false);
        },
        snapshots: unsupportedSnapshots("islo"),
        async stop() {
          await client.sandboxes.deleteSandbox({ sandbox_name: sandboxName });
        },
      };
    },
  };

  return withManagedSessions(provider, [], {
    stop: ({ raw }) => raw.client.sandboxes.pauseSandbox({ sandbox_name: raw.name }),
    resume: ({ raw }) => raw.client.sandboxes.resumeSandbox({ sandbox_name: raw.name }),
    destroy: ({ raw }) => raw.client.sandboxes.deleteSandbox({ sandbox_name: raw.name }),
  });
}

interface IsloRunOptions extends RunOptions {
  user?: string;
}

interface ExecEvent {
  event: string;
  data: string;
}

async function executeCommand(
  raw: IsloSandbox,
  command: CommandInput,
  options: IsloRunOptions,
): Promise<CommandResult> {
  const started = performance.now();
  let stdout = "";
  let stderr = "";
  const exitCode = await consumeExecStream(raw, command, options, "process.run", (event) => {
    if (event.stream === "stdout") stdout += event.data;
    else stderr += event.data;
  });
  return {
    stdout,
    stderr,
    exitCode,
    success: exitCode === 0,
    durationMs: Math.round(performance.now() - started),
  };
}

async function startCommand(
  raw: IsloSandbox,
  command: CommandInput,
  options: IsloRunOptions,
): Promise<SandboxProcess> {
  const events: ProcessOutputEvent[] = [];
  const waiters = new Set<() => void>();
  let status: "running" | "exited" = "running";
  const wake = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  const completed = consumeExecStream(raw, command, options, "process.start", (event) => {
    events.push({ ...event, timestamp: new Date() });
    wake();
  })
    .then((exitCode) => ({ exitCode }))
    .finally(() => {
      status = "exited";
      wake();
    });

  return {
    id: crypto.randomUUID(),
    async status() {
      return status;
    },
    async *output() {
      let index = 0;
      while (status === "running" || index < events.length) {
        while (index < events.length) yield events[index++]!;
        if (status === "exited") break;
        await new Promise<void>((resolve) => waiters.add(resolve));
      }
    },
    async write() {
      unsupported("islo", "process.stdin");
    },
    wait: () => completed,
    async kill() {
      unsupported("islo", "process.cancel");
    },
  };
}

async function consumeExecStream(
  raw: IsloSandbox,
  command: CommandInput,
  options: IsloRunOptions,
  operation: "process.run" | "process.start",
  onOutput: (event: ProcessOutputEvent) => void,
): Promise<number> {
  const response = await raw.client.fetch(
    new URL(
      `sandboxes/${encodeURIComponent(raw.name)}/exec/stream`,
      `${raw.computeUrl.replace(/\/+$/, "")}/`,
    ),
    {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: commandArguments(command),
        ...(options.cwd ? { workdir: options.cwd } : {}),
        ...(options.env && Object.keys(options.env).length ? { env: options.env } : {}),
        ...(options.timeout ? { timeout_secs: Math.max(1, Math.ceil(options.timeout / 1_000)) } : {}),
        ...(options.user ? { user: options.user } : {}),
      }),
    },
    requestOptions(options.signal, options.timeout),
  );
  if (!response.ok) throw responseError(operation, response);
  if (!response.body) {
    throw new SandboxError({
      code: "internal",
      provider: "islo",
      operation,
      message: "Islo exec stream returned no response body",
    });
  }

  let exitCode: number | undefined;
  let streamError = "";
  for await (const event of parseSse(response.body)) {
    if (event.event === "stdout" || event.event === "stderr") {
      onOutput({ stream: event.event, data: event.data });
    } else if (event.event === "exit") {
      const parsed = Number.parseInt(event.data.trim(), 10);
      if (!Number.isFinite(parsed)) {
        throw new SandboxError({
          code: "internal",
          provider: "islo",
          operation,
          message: `Invalid Islo exit event: ${event.data}`,
        });
      }
      exitCode = parsed;
    } else if (event.event === "error") {
      streamError = event.data.trim();
    }
  }
  if (exitCode !== undefined) return exitCode;
  if (streamError) {
    throw new SandboxError({
      code: "process_failed",
      provider: "islo",
      operation,
      message: `Islo exec stream error: ${streamError}`,
    });
  }
  throw new SandboxError({
    code: "internal",
    provider: "islo",
    operation,
    message: "Islo exec stream ended without an exit event",
  });
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<ExecEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];

  const flush = (): ExecEvent | undefined => {
    if (!event && data.length === 0) return undefined;
    const value = { event, data: data.join("\n") };
    event = "";
    data = [];
    return value;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) {
        const value = flush();
        if (value) yield value;
      } else if (!line.startsWith(":")) {
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "event") event = value;
        if (field === "data") data.push(value);
      }
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer) {
    const line = buffer.replace(/\r$/, "");
    if (!line.startsWith(":")) {
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
  }
  const value = flush();
  if (value) yield value;
}

function argv(command: string, ...args: string[]): CommandInput {
  return { command, args };
}

function commandArguments(input: CommandInput): string[] {
  if (typeof input === "string") return ["bash", "-lc", input];
  return [input.command, ...(input.args ?? [])];
}

function listScript(path: string): string {
  return `
set -e
root=${shellQuote(path)}
test -d "$root"
find "$root" -mindepth 1 -maxdepth 1 -print0 | while IFS= read -r -d '' entry; do
  if test -L "$entry"; then type=l
  elif test -d "$entry"; then type=d
  elif test -f "$entry"; then type=f
  else type=u
  fi
  name=$(basename -- "$entry" | base64 -w0)
  full=$(printf %s "$entry" | base64 -w0)
  size=$(stat -c %s -- "$entry" 2>/dev/null || printf 0)
  printf '%s\\t%s\\t%s\\t%s\\n' "$name" "$full" "$type" "$size"
done
`;
}

function parseDirectoryEntries(value: string): SandboxDirectoryEntry[] {
  return value
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [encodedName = "", encodedPath = "", rawType = "u", rawSize = ""] = line.split("\t");
      return {
        name: Buffer.from(encodedName, "base64").toString(),
        path: Buffer.from(encodedPath, "base64").toString(),
        type:
          rawType === "f"
            ? ("file" as const)
            : rawType === "d"
              ? ("directory" as const)
              : rawType === "l"
                ? ("symlink" as const)
                : ("unknown" as const),
        ...(rawSize ? { size: Number(rawSize) } : {}),
      };
    });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function assertSuccess(
  result: { exitCode: number; stderr: string },
  operation: string,
): Promise<void> {
  if (result.exitCode === 0) return;
  throw new SandboxError({
    code: "process_failed",
    provider: "islo",
    operation,
    message: result.stderr || `${operation} exited ${result.exitCode}`,
  });
}

function requestOptions(signal?: AbortSignal, timeoutMs?: number) {
  return {
    ...(signal ? { abortSignal: signal } : {}),
    ...(timeoutMs ? { timeoutInSeconds: Math.max(1, Math.ceil(timeoutMs / 1_000)) } : {}),
  };
}

function responseError(operation: string, response: Response): SandboxError {
  return new SandboxError({
    code:
      response.status === 401
        ? "authentication"
        : response.status === 403
          ? "permission"
          : response.status === 404
            ? "not_found"
            : response.status === 409
              ? "conflict"
              : response.status === 429
                ? "rate_limited"
                : response.status >= 500
                  ? "unavailable"
                  : "internal",
    provider: "islo",
    operation,
    message: `Islo request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`,
  });
}
