/** Verified against @boxd-sh/sdk 0.2.17 and https://docs.boxd.sh/reference/typescript-sdk. */
import type { Boxd, Machine } from "@boxd-sh/sdk";
import type { Provider, SandboxInfo } from "../../provider.js";
import { boxdError, failure } from "./errors.js";
import { files, python, type Guest } from "./guest.js";
import { execute } from "./execute.js";
export interface BoxdOptions {
  apiKey?: string;
  baseURL?: string;
  image?: string;
  requestTimeoutMs?: number;
}
export interface BoxdNative {
  machine: Machine;
  client: Boxd;
}
export type BoxdProvider = Provider<BoxdNative, "pause">;
const marker = "/var/lib/sandbox-sdk/metadata.json";
export function boxd(options: BoxdOptions = {}): BoxdProvider {
  let client: Promise<Boxd> | undefined;
  let current: Boxd | undefined;
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
        if ((await c.machines.files.upload(id, path, bytes)) !== bytes.length)
          throw failure("Incomplete file upload", "provider", id);
      },
      read: async (path, range) => {
        // The native download stream can truncate its last block or exceed the
        // request deadline on multi-MiB files. Bounded exec reads avoid it.
        const parts: Uint8Array[] = [];
        let offset = range?.offset ?? 0;
        let remaining = range?.length ?? Infinity;
        while (remaining > 0) {
          const length = Math.min(1024 * 1024 + 1, remaining);
          const readChunk = () => c.machines.exec(id, {
            command: python(
              "import sys; f=open(sys.argv[1],'rb'); f.seek(int(sys.argv[2])); sys.stdout.buffer.write(f.read(int(sys.argv[3])))",
              path, String(offset), String(length),
            ),
            encoding: "buffer",
            timeout: options.requestTimeoutMs ?? 30000,
          });
          // This fixed command only reads a byte range. Repeating it cannot
          // replay a write, even if a timed-out native stream finishes late.
          const result = await readChunk().catch((error: unknown) => {
            if (!["timeout", "unavailable"].includes(boxdError(error, id).code)) throw error;
            return readChunk();
          });
          if (result.exitCode !== 0) throw failure("File does not exist", "file_not_found", id);
          const bytes = new Uint8Array(result.stdout);
          parts.push(bytes);
          offset += bytes.length;
          remaining -= bytes.length;
          if (bytes.length < length) break;
        }
        return new Uint8Array(Buffer.concat(parts));
      },
    };
  }
  async function info(m: Machine): Promise<SandboxInfo> {
    if (!m.name.startsWith("sbxsdk-")) throw failure("Not an SDK machine", "not_found", m.id);
    const text = new TextDecoder().decode(await (await api()).machines.files.download(m.id, marker));
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
    capabilities: new Set(["pause"]),
    create: (input) =>
      safe(undefined, async () => {
        if (
          input.size !== undefined ||
          (input.network && input.network !== "all") ||
          input.idleTimeoutMs !== undefined ||
          input.timeoutMs !== undefined ||
          input.from !== undefined
        )
          throw failure(
            "Sizes, network restrictions, idle/lifetime limits and snapshot restore are not implemented",
            "unsupported",
          );
        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        const c = await api();
        let m: Machine;
        try {
          m = await c.machines.create({
            name: `sbxsdk-${crypto.randomUUID()}`,
            image: options.image,
            env: input.env,
            isolated: true,
            config: { autoSuspendTimeout: 0, autoDestroyTimeout: 0 },
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
          await g.raw(
            "if ! mkdir -p /workspace /var/lib/sandbox-sdk 2>/dev/null || [ ! -w /workspace ] || [ ! -w /var/lib/sandbox-sdk ]; then sudo -n install -d -o \"$(id -u)\" -g \"$(id -g)\" /workspace /var/lib/sandbox-sdk; fi && test -w /workspace && test -w /var/lib/sandbox-sdk && mkdir -p /tmp/.sandbox-sdk && command -v python3 git tar nohup >/dev/null",
          );
          await g.upload(
            marker,
            Buffer.from(
              JSON.stringify({
                key: input.key ?? null,
                labels: input.labels,
                createdAt: Date.now(),
              }),
            ),
          );
          boxes.set(m.id, ready);
          return await info(ready);
        } catch (error) {
          await c.machines.delete(m.id);
          throw error;
        }
      }),
    list: (labels) =>
      safe(undefined, async () => {
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
      }),
    async find(key) {
      const v = (await provider.list({})).find((v) => v.key === key);
      return v ? provider.connect(v.id) : undefined;
    },
    connect: (id) =>
      safe(id, async () => {
        const m = await (await api()).machines.get(id);
        const value = await info(m);
        boxes.set(id, m);
        return value;
      }),
    destroy: (id) =>
      safe(id, async () => {
        try {
          await (await api()).machines.delete(id);
        } catch (error) {
          if (boxdError(error).code !== "not_found") throw error;
        }
        boxes.delete(id);
      }),
    async close(id) {
      boxes.delete(id);
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
