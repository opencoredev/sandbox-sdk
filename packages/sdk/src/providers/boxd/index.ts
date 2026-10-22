/** Verified against @boxd-sh/sdk 0.2.17 and https://docs.boxd.sh/reference/typescript-sdk. */
import type { Boxd, Machine } from "@boxd-sh/sdk";
import type { CreateInput, Provider, SandboxInfo } from "../../provider.js";
import { boxdError, failure } from "./errors.js";
import { files, python, type Guest } from "./guest.js";
import { execute } from "./execute.js";
import { FileTransfers } from "./transfers.js";
export interface BoxdOptions {
  apiKey?: string;
  baseURL?: string;
  image?: string;
  requestTimeoutMs?: number;
  /** Cancels this adapter's file transfers, including in-flight uploads/downloads. */
  fileTransferSignal?: AbortSignal;
}
export interface BoxdNative {
  machine: Machine;
  client: Boxd;
}
export type BoxdProvider = Provider<BoxdNative, "pause" | "size" | "snapshot">;
const marker = "/var/lib/sandbox-sdk/metadata.json";
// Each class has fixed 100 GB disk and 4 GiB memory per vCPU.
function vcpuFor(size: CreateInput["size"]): number | undefined {
  if (size === undefined) return undefined;
  if (typeof size === "string") return { small: 1, medium: 2, large: 4 }[size];
  if (![1, 2, 4, 8].includes(size.cpu))
    throw failure("boxd sizes are 1 vCPU / 4 GiB, 2 / 8, 4 / 16, or 8 / 32, each with 100 GB disk", "unsupported");
  if (size.memoryMb !== size.cpu * 4096 || size.diskGb !== 100)
    throw failure(`boxd gives ${size.cpu} vCPU / ${size.cpu * 4} GiB memory / 100 GB disk; CPU and memory cannot be selected independently`, "unsupported");
  return size.cpu;
}
export function boxd(options: BoxdOptions = {}): BoxdProvider {
  let client: Promise<Boxd> | undefined;
  let current: Boxd | undefined;
  let webClient: FileTransfers | undefined;
  const boxes = new Map<string, Machine>();
  async function api() {
    return (client ??= (async () => {
      if (
        options.requestTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
      )
        throw failure("requestTimeoutMs must be a positive integer", "invalid_argument");
      const apiKey = options.apiKey ?? process.env.BOXD_API_KEY;
      if (!apiKey?.trim()) throw failure("Set BOXD_API_KEY", "auth");
      const { Boxd } = await import("@boxd-sh/sdk");
      return (current = new Boxd({
        apiKey,
        baseURL: options.baseURL,
        timeout: options.requestTimeoutMs ?? 30000,
        maxRetries: 0,
      }));
    })());
  }
  async function fileApi() {
    await api();
    return (webClient ??= new FileTransfers({
      apiKey: options.apiKey ?? process.env.BOXD_API_KEY,
      baseURL: options.baseURL,
      timeout: options.requestTimeoutMs ?? 30000,
      maxRetries: 0,
    }, options.fileTransferSignal));
  }
  async function safe<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw boxdError(error, id);
    }
  }
  async function guest(id: string): Promise<Guest> {
    const c = await api();
    return {
      name: "boxd",
      raw: async (command) => {
        const r = await c.machines.exec(id, {
          command,
          timeout: options.requestTimeoutMs ?? 30000,
        });
        if (r.exitCode !== 0) throw failure("Guest operation failed", "provider", id);
        return r.stdout;
      },
      upload: async (path, bytes) => {
        if ((await (await fileApi()).upload(id, path, bytes)) !== bytes.length)
          throw failure("Incomplete file upload", "provider", id);
      },
      read: async (path, range) => {
        if (!range) return (await fileApi()).download(id, path);
        // Tail readers request a bounded range. Seek in the guest rather than
        // downloading a growing log in full for each page.
        const result = await c.machines.exec(id, {
          command: python(
            "import sys; f=open(sys.argv[1],'rb'); f.seek(int(sys.argv[2])); sys.stdout.buffer.write(f.read(int(sys.argv[3])))",
            path, String(range.offset), String(range.length),
          ),
          encoding: "buffer",
          timeout: options.requestTimeoutMs ?? 30000,
        });
        if (result.exitCode !== 0) throw failure("File does not exist", "file_not_found", id);
        return new Uint8Array(result.stdout);
      },
    };
  }
  async function info(m: Machine): Promise<SandboxInfo> {
    if (!m.name.startsWith("sbxsdk-")) throw failure("Not an SDK machine", "not_found", m.id);
    const text = new TextDecoder().decode(await (await fileApi()).download(m.id, marker));
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw failure("Invalid SDK metadata", "not_found", m.id); }
    if (
      !value ||
      typeof value !== "object" ||
      !("labels" in value) ||
      !value.labels ||
      typeof value.labels !== "object" ||
      Array.isArray(value.labels) ||
      !("createdAt" in value) ||
      typeof value.createdAt !== "number" ||
      !("key" in value) ||
      (value.key !== null && typeof value.key !== "string")
    )
      throw failure("Invalid SDK metadata", "not_found", m.id);
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(value.labels)) {
      if (typeof v !== "string") throw failure("Invalid SDK labels", "not_found", m.id);
      Object.defineProperty(labels, k, { value: v, enumerable: true });
    }
    return {
      id: m.id,
      key: value.key ?? undefined,
      labels,
      createdAt: value.createdAt,
      state:
        m.status === "running"
          ? "running"
          : ["suspended", "hibernated"].includes(m.status)
            ? "paused"
            : "stopped",
    };
  }
  const provider: BoxdProvider = {
    name: "boxd",
    keyMode: "best-effort",
    inlineActivity: true,
    capabilities: new Set(["pause", "size", "snapshot"]),
    create: (input) =>
      safe(undefined, async () => {
        if (
          (input.network && input.network !== "all") ||
          input.idleTimeoutMs !== undefined ||
          input.timeoutMs !== undefined
        )
          throw failure(
            "Network restrictions and idle/lifetime limits are not implemented",
            "unsupported",
          );
        if (input.from !== undefined && !input.from.trim())
          throw failure("Snapshot restore requires a nonempty snapshot ID or name", "invalid_argument");
        if (input.from !== undefined && (input.size !== undefined || Object.keys(input.env ?? {}).length > 0 || options.image !== undefined))
          throw failure("boxd snapshot restore inherits size, image and environment; overrides are not supported", "unsupported");
        const vcpu = vcpuFor(input.size);
        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        const c = await api();
        let m: Machine;
        try {
          const name = `sbxsdk-${crypto.randomUUID()}`;
          m = await c.machines.create(input.from !== undefined ? {
            name,
            fromSnapshot: input.from,
            isolated: true,
            config: { autoSuspendTimeout: 0 },
          } : {
            name,
            image: options.image,
            env: input.env,
            isolated: true,
            config: { autoSuspendTimeout: 0, autoDestroyTimeout: 0, vcpu },
          });
        } catch (error) {
          const mapped = boxdError(error);
          if (mapped.code === "unavailable" || mapped.code === "timeout")
            throw failure(
              "Machine creation outcome is unknown; inspect the account before retrying",
              "outcome_unknown",
            );
          throw error;
        }

        try {
          const ready = await c.machines.waitUntilReady(m.id, {
            timeout: options.requestTimeoutMs ?? 90000,
          });
          if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
          const g = await guest(m.id);
          const value: SandboxInfo = {
            id: m.id,
            key: input.key,
            labels: input.labels,
            createdAt: Date.now(),
            state: "running",
          };
          await g.raw(
            "if ! mkdir -p /workspace /var/lib/sandbox-sdk 2>/dev/null || [ ! -w /workspace ] || [ ! -w /var/lib/sandbox-sdk ]; then sudo -n install -d -o \"$(id -u)\" -g \"$(id -g)\" /workspace /var/lib/sandbox-sdk; fi && test -w /workspace && test -w /var/lib/sandbox-sdk && mkdir -p /tmp/.sandbox-sdk && command -v python3 git tar nohup >/dev/null && " +
            python("import sys; open(sys.argv[1],'w').write(sys.argv[2])", marker,
              JSON.stringify({ key: value.key ?? null, labels: value.labels, createdAt: value.createdAt })),
          );
          boxes.set(m.id, ready);
          return value;
        } catch (error) {
          await c.machines.delete(m.id);
          throw error;
        }
      }),
    list: (labels) =>
      safe(undefined, async () => {
        try {
          const result: SandboxInfo[] = [];
          for (const m of await (await api()).machines.list()) {
            if (!m.name.startsWith("sbxsdk-") || m.status === "destroyed") continue;
            try {
              const v = await info(m);
              if (Object.entries(labels).every(([k, vv]) => v.labels[k] === vv)) result.push(v);
            } catch (error) {
              if (boxdError(error).code !== "not_found") throw error;
            }
          }
          return result;
        } finally {
          // A listing-only adapter has no handle that will later call close().
          if (!boxes.size) await webClient?.releaseIdle();
        }
      }),
    async find(key) {
      const v = (await provider.list({})).find((v) => v.key === key);
      return v ? provider.connect(v.id) : undefined;
    },
    connect: (id) =>
      safe(id, async () => {
        try {
          const m = await (await api()).machines.get(id);
          const value = await info(m);
          boxes.set(id, m);
          return value;
        } finally {
          if (!boxes.size) await webClient?.releaseIdle();
        }
      }),
    destroy: (id) =>
      safe(id, async () => {
        try {
          await (await api()).machines.delete(id);
        } catch (error) {
          if (boxdError(error).code !== "not_found") throw error;
        }
        boxes.delete(id);
        await webClient?.closeMachine(id);
        if (!boxes.size) await webClient?.releaseIdle();
      }),
    async close(id) {
      boxes.delete(id);
      await webClient?.closeMachine(id);
      if (!boxes.size) await webClient?.releaseIdle();
    },
    exec: (id, input) => safe(id, async () => execute(await api(), id, input)),
    files: files(guest, safe),
    previewUrl: (id, port) =>
      safe(id, async () => {
        const c = await api();
        // Named routes add a second DNS label outside the *.boxd.sh cert.
        // Use the native default route, whose hostname has a valid wildcard.
        const found = (await c.machines.proxies.list(id)).find((p) => p.isDefault);
        if (!found) throw failure("Default proxy is not ready", "unavailable", id);
        await c.machines.proxies.setPort(id, port);
        // Default routes otherwise apply a browser challenge to API clients.
        await c.machines.setBotProtection(id, "off");
        return { url: `https://${found.domain}` };
      }),
    pause: (id) =>
      safe(id, async () => {
        await (await api()).machines.pause(id);
      }),
    resume: (id) =>
      safe(id, async () => {
        await (await api()).machines.resume(id);
      }),
    snapshot: (id) => safe(id, async () => {
      const c = await api();
      const name = `sbxsdk-${crypto.randomUUID()}`;
      const deadline = Date.now() + (options.requestTimeoutMs ?? 90000);
      try {
        await c.snapshots.create(id, name);
        while (Date.now() < deadline) {
          const snapshot = await c.snapshots.get(name);
          if (snapshot.status === "ready") return { id: name };
          if (snapshot.status === "failed") throw failure("boxd snapshot capture failed", "provider", id);
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw failure("boxd snapshot did not become ready", "timeout", id);
      } catch (error) {
        // The API has no core snapshot-delete hook. Remove failed captures here
        // so retries cannot leave untracked, billable artifacts behind.
        try {
          await c.snapshots.delete(name);
        } catch (cleanupError) {
          if (boxdError(cleanupError, id).code !== "not_found")
            throw failure(`Snapshot ${name} cleanup is unconfirmed after ${boxdError(error, id).code}; inspect and remove it before retrying`, "outcome_unknown", id);
        }
        throw error;
      }
    }),
    native(id) {
      const machine = boxes.get(id);
      if (!machine) throw failure("Connect the machine first", "not_found", id);
      if (!client) throw failure("Client is detached", "not_found", id);
      return { machine, client: nativeClient() };
    },
  };
  function nativeClient() {
    if (!current) throw failure("Client is detached", "not_found");
    return current;
  }
  return provider;
}
