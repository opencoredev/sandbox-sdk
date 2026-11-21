/** Verified against disk 1.12.1, Archil's TypeScript SDK (https://github.com/archil-data/archil-sdk). */
import { createHash } from "node:crypto";
import type {
  Archil,
  ArchilOptions as ArchilClientOptions,
  CreateSandboxRequest,
  Sandbox,
  SandboxNetwork,
  SandboxStatus,
} from "disk";
import type {
  CreateInput,
  Labels,
  Provider,
  SandboxInfo,
  Terminal,
  TerminalOptions,
} from "../../provider.js";
import { loadPeer } from "../../peer.js";
import { files, python, type Guest } from "../../shared/guest.js";
import { isObject, isString, isStringRecord } from "../../shared/narrow.js";
import { quote } from "../../shared/shell.js";
import { archilError, failure, nativeStatus, notRunning } from "./errors.js";
import { collect, execute, inDirectory, terminate, type ArchilRunner } from "./execute.js";

export interface ArchilOptions {
  /** Defaults to ARCHIL_API_KEY. Keys are made per region in the Archil console. */
  apiKey?: string;
  /** The key's region, such as `aws-us-east-1` (the default) or `aws-eu-west-1`. Defaults to ARCHIL_REGION. */
  region?: string;
  /** Public OCI image for new sandboxes. Unset uses Archil's default, `node:24-bookworm`. */
  image?: string;
  /** A ready image ID from Archil's image builds, instead of `image`. */
  imageId?: string;
}

export interface ArchilNative {
  sandbox: Sandbox;
  client: Archil;
}

type ArchilCapability = "pause" | "terminal" | "network-policy" | "size";

export type ArchilProvider = Provider<ArchilNative, ArchilCapability>;

/** The `disk` module, or a test fixture with the same shape. */
export interface ArchilModule {
  Archil: new (options: ArchilClientOptions) => Archil;
}

const prefix = "sbxsdk-";

// The label the core stamps on every sandbox it creates. Every sandbox under the prefix has it.
const sdkLabel: Labels = { "sandbox-sdk": "1" };

/** A keyed sandbox's native name. Archil names are unique per account, so the key is exact. */
function keyedName(key: string) {
  return `${prefix}k${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

const presets = {
  small: { cpu: 1, memoryMb: 2048 },
  medium: { cpu: 2, memoryMb: 4096 },
  large: { cpu: 4, memoryMb: 8192 },
} as const;

function machineFor(
  size: CreateInput["size"],
): Pick<CreateSandboxRequest, "vcpuCount" | "memSizeMiB"> {
  if (size === undefined) return {};
  const value = isString(size) ? presets[size] : size;

  if (!isString(size) && size.diskGb !== undefined)
    throw failure("Archil sandboxes have no disk size option", "unsupported");

  if (!Number.isInteger(value.cpu) || value.cpu < 1 || value.cpu > 32)
    throw failure("Archil sandboxes take 1 to 32 whole vCPUs", "unsupported");

  if (!Number.isInteger(value.memoryMb) || value.memoryMb < 256 || value.memoryMb > 65_536)
    throw failure("Archil sandboxes take 256 to 65536 MiB of memory, in whole MiB", "unsupported");

  return { vcpuCount: value.cpu, memSizeMiB: value.memoryMb };
}

/** Archil lifetimes are whole seconds, 60 s to 24 h. Expiry pauses the sandbox rather than deleting it. */
function lifetimeFor(timeoutMs: number | undefined) {
  if (timeoutMs === undefined) return undefined;
  const seconds = Math.ceil(timeoutMs / 1000);

  if (seconds < 60 || seconds > 86_400)
    throw failure("Archil sandbox lifetimes are 60 seconds to 24 hours", "unsupported");

  return seconds;
}

function idleFor(idleTimeoutMs: number | undefined) {
  if (idleTimeoutMs === undefined) return undefined;
  const seconds = Math.ceil(idleTimeoutMs / 1000);

  if (seconds < 1 || seconds > 86_400)
    throw failure("Archil idle timeouts are 1 second to 24 hours", "unsupported");

  return seconds;
}

function networkFor(network: CreateInput["network"]): SandboxNetwork | undefined {
  if (network === undefined) return undefined;

  if (network === "all") return { egress: { default: "allow" } };

  if (network === "none") return { egress: { default: "deny" } };

  return { egress: { default: "deny", allow: [...network.allow] } };
}

// States that still hold a sandbox. failed, deleting and deleted do not.
function stateOf(status: SandboxStatus): SandboxInfo["state"] | undefined {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "pausing":
    case "paused":
      return "paused";
    case "stopping":
    case "stopped":
    case "exited":
      return "stopped";
    case "failed":
    case "deleting":
    case "deleted":
      return undefined;
    default: {
      const _exhaustive: never = status;

      return undefined;
    }
  }
}

/**
 * Archil keeps no labels on a sandbox, so the adapter writes them into its root disk at create:
 * `{ key, labels, createdAt }`. The disk persists across pause and stop, but a file can only be
 * read while the sandbox runs.
 */
const markerPath = "/var/lib/sandbox-sdk/metadata.json";

// Makes the default working directory and writes the marker, in one process.
const setupCommand = `mkdir -p /workspace /var/lib/sandbox-sdk && printf '%s' "$SANDBOX_SDK_MARKER" > ${markerPath}`;

interface Marker {
  key?: string;
  labels: Labels;
}

function parseMarker(bytes: Uint8Array): Marker | undefined {
  let value: unknown;

  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }

  if (!isObject(value) || !("labels" in value) || !isStringRecord(value.labels)) return undefined;
  const key = "key" in value && isString(value.key) ? value.key : undefined;

  return { key, labels: { ...value.labels } };
}

function matches(info: SandboxInfo, labels: Labels) {
  return Object.entries(labels).every(([key, value]) => info.labels[key] === value);
}

// Writes stdin to argv[1] in place (the inode and its mode survive), making its directory first.
const writeProgram = (mode: number | undefined) =>
  `set -e; mkdir -p -- "$(dirname -- "$SANDBOX_SDK_PATH")"; cat > "$SANDBOX_SDK_PATH"${
    mode === undefined ? "" : `; chmod ${mode.toString(8)} -- "$SANDBOX_SDK_PATH"`
  }`;

// Prints argv[3] bytes of regular file argv[1] from offset argv[2] (-1: to the end); exit 3 if absent.
const readProgram =
  "import os,sys\np=sys.argv[1]\nif not os.path.isfile(p): sys.exit(3)\nwith open(p,'rb') as f:\n f.seek(int(sys.argv[2]))\n n=int(sys.argv[3])\n o=sys.stdout.buffer\n while n!=0:\n  b=f.read(1048576 if n<0 else min(n,1048576))\n  if not b: break\n  o.write(b)\n  if n>0: n-=len(b)";

/** @internal The adapter behind `archil()`. `load` imports `disk`; tests pass a fixture. */
export function createArchilProvider(
  options: ArchilOptions,
  load: () => Promise<ArchilModule>,
): ArchilProvider {
  let client: Promise<Archil> | undefined;
  let current: Archil | undefined;
  const boxes = new Map<string, Sandbox>();

  async function connectClient(): Promise<Archil> {
    const apiKey = options.apiKey ?? process.env.ARCHIL_API_KEY;

    if (!apiKey?.trim())
      throw failure(
        "Archil API key is missing. Authentication is required. Set ARCHIL_API_KEY or pass apiKey.",
        "auth",
      );
    const region = options.region ?? process.env.ARCHIL_REGION ?? "aws-us-east-1";
    const { Archil } = await loadPeer("disk", "archil", load);

    return (current = new Archil({ apiKey: apiKey.trim(), region }));
  }

  /** One client per provider. A failed setup (no key, no peer) is retried on the next call. */
  async function api(): Promise<Archil> {
    client ??= connectClient();

    try {
      return await client;
    } catch (error) {
      client = undefined;
      throw error;
    }
  }

  async function safe<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw archilError(error, id);
    }
  }

  /** The sandbox, fetched once per client. Not this SDK's, or gone: not_found. */
  async function sandbox(id: string): Promise<Sandbox> {
    const known = boxes.get(id);

    if (known) return known;
    let value: Sandbox;

    try {
      value = await (await api()).sandboxes.get(id);
    } catch (error) {
      // A malformed ID is a 400 from Archil; for connect it is simply not a sandbox here.
      if ([400, 404].includes(nativeStatus(error) ?? 0))
        throw failure("Sandbox not found", "not_found", id);
      throw error;
    }

    if (!value.name.startsWith(prefix) || stateOf(value.status) === undefined)
      throw failure("Sandbox not found", "not_found", id);
    boxes.set(id, value);

    return value;
  }

  /** Brings a paused or stopped sandbox back so it can run commands. */
  async function wake(box: Sandbox) {
    await box.refresh();

    if (box.status === "paused" || box.status === "pausing") await box.resume();
    else if (["stopped", "stopping", "exited"].includes(box.status)) await box.start();
  }

  /**
   * A runner that wakes the sandbox once when Archil refuses a process because it is not running:
   * an idle or lifetime expiry pauses it on its own.
   */
  function runner(id: string): ArchilRunner {
    return {
      run: async (command, runOptions) => {
        const box = await sandbox(id);

        try {
          return await box.run(command, runOptions);
        } catch (error) {
          if (!notRunning(error)) throw error;
          await wake(box);

          return box.run(command, runOptions);
        }
      },
    };
  }

  function guest(id: string): Guest {
    const run = runner(id);

    return {
      name: "archil",
      raw: async (command) => {
        const result = await collect(run, id, command);

        if (result.exitCode !== 0) throw failure("Guest operation failed", "provider", id);

        return new TextDecoder().decode(result.stdout);
      },
      upload: async (path, bytes, mode) => {
        const result = await collect(run, id, writeProgram(mode), {
          env: { SANDBOX_SDK_PATH: path },
          stdin: bytes,
        });

        if (result.exitCode !== 0) throw failure("File write failed", "provider", id);
      },
      read: async (path, range) => {
        // A range is usually a small log page: one helper read, unless Archil's stream skipped bytes.
        if (range) {
          const result = await collect(
            run,
            id,
            python(readProgram, path, String(range.offset), String(range.length)),
          );

          if (result.exitCode === 3) throw failure("File does not exist", "file_not_found", id);

          if (result.exitCode !== 0) throw failure("File read failed", "provider", id);

          if (result.lost === 0) return result.stdout;
        }

        const whole = await download(id, path);

        return range ? whole.subarray(range.offset, range.offset + range.length) : whole;
      },
    };
  }

  /**
   * Reads a whole file through `disk`'s download, which asks for one 512 KiB piece at a time and so
   * never outruns Archil's output stream. Its failures carry guest text, so a stat classifies them.
   */
  async function download(id: string, path: string): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];

    const attempt = async () => {
      parts.length = 0;
      await (
        await sandbox(id)
      ).files.downloadFile(path, (chunk) => {
        parts.push(chunk.slice());
      });
    };

    try {
      await attempt();
    } catch {
      // Missing, not a regular file, or the sandbox paused itself: the stat wakes it if so.
      const check = await collect(runner(id), id, `[ -f ${quote(path)} ]`);

      if (check.exitCode !== 0) throw failure("File does not exist", "file_not_found", id);

      try {
        await attempt();
      } catch {
        throw failure("File read failed", "provider", id);
      }
    }

    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;

    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }

    return bytes;
  }

  /** Reads a running sandbox's marker. Undefined when it has none: not made by this SDK, or still being made. */
  async function markerOf(id: string): Promise<Marker | undefined> {
    const result = await collect(runner(id), id, `cat -- ${quote(markerPath)}`, {
      timeoutMs: 30_000,
    });

    return result.exitCode === 0 ? parseMarker(result.stdout) : undefined;
  }

  /**
   * A sandbox as SandboxInfo. A running one reports the key and labels in its marker; a paused or
   * stopped one cannot be read without waking it, so `readable` is false and its labels are empty.
   */
  async function infoOf(
    box: Sandbox,
  ): Promise<{ info: SandboxInfo; readable: boolean } | undefined> {
    const state = stateOf(box.status);

    if (!box.name.startsWith(prefix) || state === undefined) return undefined;
    const base = { id: box.id, state, createdAt: box.createdAt.getTime() };

    // The name prefix proves the core's own label; the rest waits until the sandbox runs again.
    if (state !== "running") return { info: { ...base, labels: { ...sdkLabel } }, readable: false };
    boxes.set(box.id, box);
    const marker = await markerOf(box.id);

    if (!marker) return undefined;

    return { info: { ...base, key: marker.key, labels: marker.labels }, readable: true };
  }

  /** Deletes a sandbox, stopping it first. True once it is gone. */
  async function remove(c: Archil, id: string): Promise<boolean> {
    const deadline = Date.now() + 120_000;

    for (;;) {
      let box: Sandbox;

      try {
        box = await c.sandboxes.get(id);
      } catch (error) {
        if ([400, 404].includes(nativeStatus(error) ?? 0)) return true;
        throw error;
      }

      if (box.status === "deleting" || box.status === "deleted") return true;

      try {
        if (!["stopped", "exited", "failed"].includes(box.status)) await box.stop();
        await box.delete();

        return true;
      } catch (error) {
        if (nativeStatus(error) === 404) return true;

        // 409 while a pause, resume or start is still settling.
        if (nativeStatus(error) !== 409 || Date.now() > deadline) throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async function terminal(id: string, terminalOptions: TerminalOptions): Promise<Terminal> {
    const listeners = new Set<(data: string) => void>();
    const decoder = new TextDecoder();

    const process = await runner(id).run(
      inDirectory(terminalOptions.cwd ?? "/workspace", "exec /bin/bash -l || exec /bin/sh"),
      {
        env: { TERM: "xterm-256color", ...terminalOptions.env },
        terminal: { cols: terminalOptions.cols, rows: terminalOptions.rows },
        collectOutput: false,
        onOutput: ({ data }) => {
          const text = decoder.decode(data, { stream: true });

          if (text) for (const listener of listeners) listener(text);
        },
      },
    );

    const ended = process.wait();

    return {
      write: (data) => safe(id, () => process.sendInput(data)),
      resize: (cols, rows) => safe(id, () => process.resize({ cols, rows })),
      onData(callback) {
        listeners.add(callback);

        return () => listeners.delete(callback);
      },
      close: () =>
        safe(id, async () => {
          if (!(await terminate(process)))
            throw failure("Terminal could not be closed", "outcome_unknown", id);
          await process.disconnect().catch(() => {});
        }),
      wait: () =>
        safe(id, async () => {
          const result = await ended;

          return { exitCode: result.status === "completed" ? (result.exitCode ?? null) : null };
        }),
    };
  }

  const provider: ArchilProvider = {
    name: "archil",
    keyMode: "exact",
    // One VM per sandbox: every process runs as root in one PID namespace with /proc mounted.
    procActivity: true,
    capabilities: new Set<ArchilCapability>(["pause", "terminal", "network-policy", "size"]),
    create: (input) =>
      safe(undefined, async () => {
        if (input.from !== undefined)
          throw failure("Archil adapter has no snapshot restore", "unsupported");

        const request: CreateSandboxRequest = {
          name: input.key === undefined ? `${prefix}${crypto.randomUUID()}` : keyedName(input.key),
          ...machineFor(input.size),
          ...(options.imageId === undefined
            ? options.image === undefined
              ? {}
              : { baseImage: options.image }
            : { imageId: options.imageId }),
          env: input.env,
          network: networkFor(input.network),
          ports: input.ports?.length ? [...input.ports] : undefined,
          maxTtlSeconds: lifetimeFor(input.timeoutMs),
          idleTtlSeconds: idleFor(input.idleTimeoutMs),
        };

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        const c = await api();
        let box: Sandbox;

        try {
          box = await c.sandboxes.create(request);
        } catch (error) {
          // An HTTP refusal made nothing (a name conflict included: the core looks the key up again).
          if (nativeStatus(error) !== undefined) throw error;
          // No answer: the create may have landed. The name is this attempt's alone unless keyed.
          const found = (await c.sandboxes.list()).find((native) => native.name === request.name);

          if (!found) throw error;

          if (input.key !== undefined)
            throw failure(
              `Sandbox creation outcome is unknown; sandbox ${found.id} has this key`,
              "outcome_unknown",
            );
          box = found;
        }

        const marker = JSON.stringify({ key: input.key, labels: input.labels } satisfies Marker);

        try {
          if (box.status !== "running") await box.refresh();

          if (stateOf(box.status) !== "running")
            throw failure(`Sandbox did not start (${box.status})`, "provider", box.id);
          boxes.set(box.id, box);

          const prepared = await collect(runner(box.id), box.id, setupCommand, {
            env: { SANDBOX_SDK_MARKER: marker },
          });

          if (prepared.exitCode !== 0) throw failure("Sandbox setup failed", "provider", box.id);

          return {
            id: box.id,
            key: input.key,
            labels: { ...input.labels },
            state: "running",
            createdAt: box.createdAt.getTime(),
          };
        } catch (error) {
          boxes.delete(box.id);

          // The sandbox exists and is billed: settle the failure only once it is gone.
          const cleaned = await remove(c, box.id).catch(() => false);

          if (!cleaned)
            throw failure(
              `Sandbox ${box.id} did not become usable and could not be deleted; delete it before retrying`,
              "outcome_unknown",
              box.id,
            );
          throw archilError(error, box.id);
        }
      }),
    find: (key) =>
      safe(undefined, async () => {
        const name = keyedName(key);
        const box = (await (await api()).sandboxes.list()).find((native) => native.name === name);

        if (!box) return undefined;
        const state = stateOf(box.status);

        if (state === undefined) return undefined;
        boxes.set(box.id, box);

        // A stopped sandbox cold-boots from its disk; a paused one wakes on its first command.
        if (state === "stopped") await box.start();

        if (box.status !== "running")
          return {
            id: box.id,
            key,
            labels: {},
            state: "paused",
            createdAt: box.createdAt.getTime(),
          };
        const marker = await markerOf(box.id);

        return {
          id: box.id,
          key,
          labels: marker?.labels ?? {},
          state: "running",
          createdAt: box.createdAt.getTime(),
        };
      }),
    connect: (id) =>
      safe(id, async () => {
        boxes.delete(id);
        const found = await infoOf(await sandbox(id));

        if (!found) throw failure("Sandbox not found", "not_found", id);

        return found.info;
      }),
    list: (labels) =>
      safe(undefined, async () => {
        const result: SandboxInfo[] = [];
        // Only labels beyond the core's own need a marker read.
        const filtered = Object.keys(labels).some((name) => !(name in sdkLabel));

        const candidates = (await (await api()).sandboxes.list()).filter(
          (box) => box.name.startsWith(prefix) && stateOf(box.status) !== undefined,
        );

        // Eight marker reads at a time.
        for (let i = 0; i < candidates.length; i += 8) {
          const infos = await Promise.all(
            candidates.slice(i, i + 8).map((box) => infoOf(box).catch(() => undefined)),
          );

          for (const found of infos)
            if (found && (found.readable || !filtered) && matches(found.info, labels))
              result.push(found.info);
        }

        return result;
      }),
    destroy: (id) =>
      safe(id, async () => {
        const c = await api();
        boxes.delete(id);

        if (!(await remove(c, id))) throw failure("Sandbox could not be deleted", "provider", id);
      }),
    async close(id) {
      boxes.delete(id);
    },
    exec: (id, input) => safe(id, () => execute({ runner: runner(id), sandboxId: id, input })),
    files: { ...files(async (id) => guest(id), safe), writeSupportsMode: true },
    previewUrl: (id, port) =>
      safe(id, async () => ({ url: `https://${await (await sandbox(id)).exposePort(port)}` })),
    pause: (id) =>
      safe(id, async () => {
        await (await sandbox(id)).pause();
      }),
    resume: (id) =>
      safe(id, async () => {
        const box = await sandbox(id);
        await box.refresh();

        if (box.status === "running") return;
        await box.resume();
      }),
    terminal: (id, terminalOptions) => safe(id, () => terminal(id, terminalOptions)),
    native(id) {
      const box = boxes.get(id);

      if (!box) throw failure("Connect the sandbox first", "not_found", id);

      if (!current) throw failure("Client is detached", "not_found", id);

      return { sandbox: box, client: current };
    },
  };

  return provider;
}
