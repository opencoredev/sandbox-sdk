/** Official API (verified against @upstash/box 0.7.9 declarations):
 * https://upstash.com/docs/box/overall/how-it-works
 * https://upstash.com/docs/box/overall/quickstart
 * https://upstash.com/docs/box/overall/live-sessions
 * https://upstash.com/docs/box/overall/files
 * https://upstash.com/docs/box/overall/network-policy
 * https://upstash.com/docs/box/overall/snapshots
 * https://upstash.com/docs/box/overall/preview
 * https://upstash.com/docs/box/overall/ephemeral-box (labels, size, env and previews verified live)
 * https://www.npmjs.com/package/@upstash/box
 */
import { posix } from "node:path";
import type { Box, BoxConfig, BoxData, BoxSize, EphemeralBox, EphemeralBoxConfig, FileStat, NetworkPolicy } from "@upstash/box";
type BoxStatus = BoxData["status"];
import type {
  Provider,
  SandboxInfo,
  Labels,
  FileInfo,
  CreateInput,
  Preview,
} from "../../provider.js";
import { Redactor, SandboxError } from "../../errors.js";
import { quote } from "../../run.js";
import { upstashError, unsupported } from "./errors.js";
import { execute, startProcess } from "./exec.js";
import { listDirectory, readFile, writeFile } from "./files.js";

type CommonOptions = Pick<
  BoxConfig,
  "apiKey" | "baseUrl" | "runtime" | "enableTelemetry"
> & {
  /** Native SDK operation timeout, not a sandbox lifetime. */
  requestTimeoutMs?: number;
  /** Default previews require a bearer token. */
  public?: boolean;
};
/** Durable Box: pauses when idle and keeps its files until destroyed. */
export type UpstashBoxOptions = CommonOptions & { ephemeral?: false };
/** Ephemeral Box: ready on create, cannot pause, and Upstash deletes it after its TTL. */
export type UpstashEphemeralOptions = CommonOptions & {
  ephemeral: true;
  /** Seconds before Upstash deletes the box: a leak backstop, not a deadline. Defaults to 3600; at most 259200. */
  ttlSeconds?: number;
};
export type UpstashOptions = UpstashBoxOptions | UpstashEphemeralOptions;
export type UpstashCapability = "pause" | "snapshot" | "size" | "network-policy";
export type UpstashEphemeralCapability = Exclude<UpstashCapability, "pause">;
export type UpstashProvider = Provider<Box, UpstashCapability>;
export type UpstashEphemeralProvider = Provider<Box, UpstashEphemeralCapability>;
const maxTtlSeconds = 259_200;
const marker = "sandbox-sdk";
const metadataPath = "/tmp/.sandbox-sdk/upstash.json";
// Upstash reruns initCommand on automatic as well as explicit resume. Disk
// snapshots retain process records, but cannot restore those OS processes.
const initCommand = `for d in /tmp/.sandbox-sdk/procs/*; do [ -f "$d/spec.json" ] && [ ! -f "$d/exit" ] && printf 137 > "$d/exit"; done; rm -rf /tmp/.sandbox-sdk/upstash-runs; true`;
const boxStatuses = ["creating", "idle", "running", "paused", "error", "deleted"] as const satisfies readonly BoxStatus[];
const isBoxStatus = (value: unknown): value is BoxStatus => boxStatuses.some((status) => status === value);
type Metadata = { version: 1; key?: string; labels: Labels };
function metadata(text: string): Metadata {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new SandboxError("Invalid SDK metadata", { code: "not_found", provider: "upstash" }); }
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("labels" in value) ||
    !value.labels ||
    typeof value.labels !== "object" ||
    Array.isArray(value.labels) ||
    ("key" in value && typeof value.key !== "string")
  )
    throw new SandboxError("Invalid SDK metadata", { code: "not_found", provider: "upstash" });
  const labels: Labels = {};
  for (const [key, item] of Object.entries(value.labels)) {
    if (typeof item !== "string") throw new SandboxError("Invalid SDK label", { code: "not_found", provider: "upstash" });
    Object.defineProperty(labels, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    version: 1,
    labels,
    ...("key" in value && typeof value.key === "string" ? { key: value.key } : {}),
  };
}
function info(data: Pick<BoxData, "id" | "status" | "created_at">, meta: Metadata): SandboxInfo {
  return {
    id: data.id,
    key: meta.key,
    labels: meta.labels,
    createdAt: data.created_at * 1000,
    state:
      data.status === "paused"
        ? "paused"
        : data.status === "running" || data.status === "idle"
          ? "running"
          : "stopped",
  };
}
/** Upstash flags ephemeral boxes in list and get records; the 0.7.9 types omit it. */
const isEphemeral = (data: BoxData) => "ephemeral" in data && data.ephemeral === true;
function fileInfo(path: string, file: FileStat): FileInfo {
  if (file.type === "other") unsupported("Special filesystem entries are not supported");
  return { path, type: file.type, size: file.size, modifiedAt: Date.parse(file.mod_time) };
}
function network(input: CreateInput["network"]): NetworkPolicy {
  if (typeof input !== "object") return { mode: input === "none" ? "deny-all" : "allow-all" };
  if (!input.allow.length) return { mode: "deny-all" };
  if (
    input.allow.some(
      (host) =>
        host.length > 253 ||
        !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(
          host,
        ),
    )
  )
    unsupported("Network allow entries must be DNS hostnames");
  return { mode: "custom", allowedDomains: input.allow };
}

export function upstash(options: UpstashEphemeralOptions): UpstashEphemeralProvider;
export function upstash(options?: UpstashBoxOptions): UpstashProvider;
/** Mode unknown at compile time: pause is not promised. */
export function upstash(options: UpstashOptions): UpstashEphemeralProvider;
export function upstash(options: UpstashOptions = {}): UpstashProvider | UpstashEphemeralProvider {
  const ttl = options.ephemeral ? options.ttlSeconds ?? 3600 : undefined;
  if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > maxTtlSeconds))
    throw new SandboxError(`Ephemeral ttlSeconds must be a whole number from 1 to ${maxTtlSeconds}.`, {
      code: "invalid_argument",
      provider: "upstash",
    });
  const redactor = new Redactor();
  const boxes = new Map<string, Box>();
  const monitors = new Map<string, Set<() => void>>();
  const previews = new Map<string, Map<number, Promise<Preview>>>();
  const detach = (id: string) => {
    for (const stop of monitors.get(id) ?? []) stop();
    monitors.delete(id);
  };
  const connection = () => {
    const apiKey = options.apiKey ?? process.env.UPSTASH_BOX_API_KEY;
    if (!apiKey)
      throw new SandboxError(
        "Upstash Box API key is missing. Authentication is required. Set UPSTASH_BOX_API_KEY or apiKey.",
        { code: "auth", provider: "upstash" },
      );
    redactor.add([apiKey]);
    return { apiKey, baseUrl: options.baseUrl, enableTelemetry: options.enableTelemetry };
  };
  const sdk = async () => {
    const config = connection();
    const { Box, EphemeralBox } = await import("@upstash/box");
    return { Box, EphemeralBox, config };
  };
  async function safe<T>(action: () => Promise<T>, id?: string, file = false, operation = "request"): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw upstashError(error, id, file, operation, value => redactor.text(value));
    }
  }
  async function box(id: string) {
    const cached = boxes.get(id);
    if (cached) return cached;
    const { Box, config } = await sdk();
    const value = await Box.get(id, { ...config, timeout: options.requestTimeoutMs });
    boxes.set(id, value);
    return value;
  }
  const onFile = <T>(id: string, operation: string, action: (value: Box) => Promise<T>) =>
    safe(async () => action(await box(id)), id, true, `files.${operation}`);
  const readMetadata = async (value: Box) => metadata(await value.files.read(metadataPath));
  async function snapshotSize(id: string): Promise<BoxSize> {
    const config = connection();
    const baseUrl = (config.baseUrl ?? process.env.UPSTASH_BOX_BASE_URL ?? "https://us-east-1.box.upstash.com").replace(/\/$/, "");
    // The native SDK only lists snapshots per source box. The account endpoint
    // also covers snapshots whose source has been deleted, preserving native IDs.
    const response = await fetch(`${baseUrl}/v2/box/snapshots`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30_000),
    });
    if (!response.ok)
      throw Object.assign(new Error("Snapshot metadata lookup failed"), { statusCode: response.status });
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("snapshots" in data) || (data.snapshots !== null && !Array.isArray(data.snapshots)))
      throw new SandboxError("Invalid snapshot metadata response. Upstash did not return a snapshot list. Retry when the service is available.", { code: "provider", provider: "upstash" });
    for (const item of data.snapshots ?? []) {
      const snapshot: unknown = item;
      if (!snapshot || typeof snapshot !== "object" || !("id" in snapshot) || snapshot.id !== id) continue;
      if ("name" in snapshot && typeof snapshot.name === "string") {
        const size = /^sdk-v1-(small|medium|large)-/.exec(snapshot.name)?.[1];
        if (size === "small" || size === "medium" || size === "large") return size;
      }
      // Legacy/native snapshots have no SDK size tag. A surviving source box
      // supplies its actual size; never silently default a vanished source to Small.
      if ("box_id" in snapshot && typeof snapshot.box_id === "string") {
        try { return (await box(snapshot.box_id)).size; }
        catch (error) { if (upstashError(error).code !== "not_found") throw error; }
      }
      unsupported("Snapshot size is unknown because its source box is unavailable; pass an explicit size");
    }
    throw new SandboxError("Snapshot was not found. It may have been deleted. Check the snapshot ID and account.", { code: "not_found", provider: "upstash" });
  }
  /** One box record; Box.list returns every box on the account. */
  async function boxData(config: ReturnType<typeof connection>, id: string): Promise<Pick<BoxData, "id" | "status" | "created_at">> {
    const baseUrl = (config.baseUrl ?? process.env.UPSTASH_BOX_BASE_URL ?? "https://us-east-1.box.upstash.com").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/v2/box/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30_000),
    });
    if (!response.ok)
      throw Object.assign(new Error("Box metadata lookup failed"), { statusCode: response.status });
    const data: unknown = await response.json();
    const status = data && typeof data === "object" && "status" in data ? data.status : undefined;
    if (
      !data ||
      typeof data !== "object" ||
      !("id" in data) ||
      data.id !== id ||
      !isBoxStatus(status) ||
      !("created_at" in data) ||
      typeof data.created_at !== "number"
    )
      throw new SandboxError("Invalid box metadata response. Upstash did not return the created box. Retry when the service is available.", { code: "provider", provider: "upstash", sandboxId: id });
    return { id, status, created_at: data.created_at };
  }
  const provider: UpstashProvider = {
    name: "upstash",
    keyMode: "best-effort",
    capabilities: new Set<UpstashCapability>(
      ttl === undefined ? ["pause", "snapshot", "size", "network-policy"] : ["snapshot", "size", "network-policy"],
    ),
    create: (input) =>
      safe(async () => {
        if (input.idleTimeoutMs !== undefined || input.timeoutMs !== undefined)
          unsupported(
            "Custom idle deadlines and hard lifetimes are not available on durable boxes",
          );
        if (input.size !== undefined && typeof input.size !== "string")
          unsupported(
            "Use small, medium, or large; exact CPU, memory, and disk sizes are unavailable",
          );
        redactor.add(Object.values(input.env ?? {}));
        const policy = network(input.network);
        const { Box, EphemeralBox, config } = await sdk();
        const params = {
          ...config,
          runtime: options.runtime,
          size: input.size ?? (input.from === undefined ? undefined : await snapshotSize(input.from)),
          // Native create-time env; values never enter command text.
          env: input.env,
          // A fresh box has no metadata until setup writes it, and discovery skips
          // boxes without metadata, so labelling at create saves a request.
          // Snapshot clones inherit the source metadata and are labelled after setup.
          labels: input.from === undefined ? [marker] : [],
          networkPolicy: policy,
          timeout: options.requestTimeoutMs,
        } satisfies BoxConfig & EphemeralBoxConfig;
        let created: Pick<EphemeralBox, "id" | "exec" | "delete">;
        let handle: Promise<Box>;
        if (ttl === undefined) {
          const value =
            input.from === undefined
              ? await Box.create({ ...params, initCommand })
              : await Box.fromSnapshot(input.from, { ...params, initCommand });
          created = value;
          handle = Promise.resolve(value);
        } else {
          created =
            input.from === undefined
              ? await EphemeralBox.create({ ...params, ttl })
              : await EphemeralBox.fromSnapshot(input.from, { ...params, ttl });
          // EphemeralBox hides its Box. Fetch one beside setup for the cache and native().
          handle = Box.get(created.id, { ...config, timeout: options.requestTimeoutMs });
          void handle.catch(() => {});
        }
        try {
          if (input.signal?.aborted)
            throw new SandboxError("Creation aborted. The caller cancelled. Retry when ready.", {
              code: "aborted",
              provider: "upstash",
            });
          const meta: Metadata = {
            version: 1,
            key: input.key,
            labels: { ...input.labels, "sandbox-sdk": "1" },
          };
          // One guest round trip prepares both directories and persists metadata.
          // Keep this after native create: initCommand also runs on resume and
          // must not overwrite metadata or publish an incomplete snapshot clone.
          // Ephemeral boxes take no initCommand, so a restored clone runs it here.
          const setup = created.exec.command(
            (ttl === undefined || input.from === undefined ? "" : `${initCommand} && `) +
            `mkdir -p /workspace ${quote(posix.dirname(metadataPath))} && ` +
            `if [ ! -w /workspace ]; then sudo -n install -d -o "$(id -u)" -g "$(id -g)" -m 755 /workspace; fi && ` +
            `test -w /workspace && (umask 077; printf %s ${quote(JSON.stringify(meta))} > ${quote(metadataPath)})`,
          );
          const record = boxData(config, created.id);
          void record.catch(() => {});
          if ((await setup).exitCode !== 0)
            throw new SandboxError("Workspace or discovery metadata setup failed. Check guest write permissions and passwordless sudo access.", { code: "provider", provider: "upstash", sandboxId: created.id });
          const value = await handle;
          boxes.set(value.id, value);
          // Publish discovery only after metadata and the workspace are ready. Native
          // labels allow five short strings; durable metadata preserves arbitrary labels.
          if (input.from !== undefined) await value.labels.add(marker);
          return info(await record, meta);
        } catch (error) {
          await created.delete();
          boxes.delete(created.id);
          throw error;
        }
      }, undefined, false, "create"),
    list: (labels) =>
      safe(async () => {
        const { Box, config } = await sdk();
        const result: SandboxInfo[] = [];
        for (const data of await Box.list({ ...config, label: marker })) {
          // Each mode owns only its own product, so find() never crosses products.
          if (!data.labels?.includes(marker) || data.status === "deleted" || isEphemeral(data) !== (ttl !== undefined)) continue;
          try {
            const meta = await readMetadata(await box(data.id));
            if (Object.entries(labels).every(([key, value]) => meta.labels[key] === value))
              result.push(info(data, meta));
          } catch (error) {
            if (upstashError(error).code !== "not_found") throw error;
          }
        }
        return result;
      }, undefined, false, "list"),
    async find(key) {
      return (await provider.list({})).find((value) => value.key === key);
    },
    connect: (id) =>
      safe(async () => {
        const { Box, config } = await sdk();
        const data = (await Box.list(config)).find((data) => data.id === id);
        if (!data) throw Object.assign(new Error("Missing box"), { statusCode: 404 });
        if (isEphemeral(data) !== (ttl !== undefined))
          throw new SandboxError(
            `Box ${id} is ${isEphemeral(data) ? "an Ephemeral Box" : "a durable Box"}. Connect with upstash({ ephemeral: ${isEphemeral(data)} }).`,
            { code: "unsupported", provider: "upstash", sandboxId: id },
          );
        const value = await box(id);
        return info(data, await readMetadata(value));
      }, id, false, "connect"),
    destroy: (id) =>
      safe(async () => {
        try {
          await (await box(id)).delete();
        } catch (error) {
          if (upstashError(error).code !== "not_found") throw error;
        } finally {
          detach(id);
          previews.delete(id);
          boxes.delete(id);
        }
      }, id, false, "destroy"),
    exec: (id, input) => safe(async () => execute(await box(id), input), id, false, "exec"),
    startProcess: (id, input) =>
      safe(async () => {
        const value = await box(id);
        // Ephemeral boxes cannot pause; kill the launcher's group, found by its private run path.
        const halt = ttl === undefined
          ? () => value.pause()
          : (dir: string) => value.exec.command(
            `for p in $(pgrep -f ${quote(`[${dir[1]}]${dir.slice(2)}/`)}); do kill -KILL -$p 2>/dev/null; done; true`,
          );
        const hook = await startProcess(value, input, halt);
        let active = monitors.get(id);
        if (!active) {
          active = new Set();
          monitors.set(id, active);
        }
        active.add(hook.detach);
        void hook
          .wait()
          .finally(() => active.delete(hook.detach))
          .catch(() => {});
        return {
          pid: hook.pid,
          wait: () => safe(hook.wait, id, false, "process.wait"),
          stop: (settings) => safe(() => hook.stop(settings), id, false, "process.stop"),
        };
      }, id, false, "process.start"),
    async close(id) {
      detach(id);
      boxes.delete(id);
    },
    files: {
      writeCreatesParents: true,
      // Upstash's own step history, written into the workspace by the platform.
      internal: [".step-git"],
      read: (id, path) => onFile(id, "read", value => readFile(value, path)),
      readRange: (id, path, range) => onFile(id, "readRange", value => readFile(value, path, range)),
      write: (id, path, data) => onFile(id, "write", value => writeFile(value, path, data)),
      list: (id, path) =>
        onFile(id, "list", async (value) => {
          const entries = await listDirectory(value, path);
          if (entries)
            return entries.map((entry) => {
              if (entry.type === "other") unsupported("Special filesystem entries are not supported");
              return { path: posix.join(path, entry.name), type: entry.type, size: entry.size, modifiedAt: entry.modifiedAt };
            });
          return Promise.all(
            (await value.files.list(path)).map(async (entry) => {
              const full = posix.join(path, entry.name);
              return fileInfo(full, await value.files.stat(full));
            }),
          );
        }),
      stat: (id, path) => onFile(id, "stat", async (value) => fileInfo(path, await value.files.stat(path))),
      remove: (id, path, settings) => onFile(id, "remove", (value) => value.files.remove(path, settings)),
      mkdir: (id, path) => onFile(id, "mkdir", (value) => value.files.mkdir(path, { parents: true })),
    },
    previewUrl: (id, port) => {
      let ports = previews.get(id);
      if (!ports) {
        ports = new Map();
        previews.set(id, ports);
      }
      const cached = ports.get(port);
      if (cached) return cached;
      // Recreating a native public URL rotates its auth credentials. Cache the
      // promise as well as the result so concurrent readiness probes share it.
      const pending = safe(async () => {
        const link = await (
          await box(id)
        ).getPublicURL(port, options.public ? undefined : { bearerToken: true });
        if (!options.public && !link.token)
          throw new Error("Protected preview returned no bearer token");
        return {
          url: link.url,
          ...(link.token ? { headers: { Authorization: `Bearer ${link.token}` } } : {}),
        };
      }, id, false, "preview");
      ports.set(port, pending);
      void pending.catch(() => ports.delete(port));
      return pending;
    },
    // Ephemeral boxes reject pause, so the methods are absent with the capability.
    ...(ttl === undefined
      ? {
        pause: (id: string) =>
          safe(async () => {
            detach(id);
            await (await box(id)).pause();
          }, id, false, "pause"),
        resume: (id: string) =>
          safe(async () => {
            const value = await box(id);
            await value.resume();
          }, id, false, "resume"),
      }
      : {}),
    snapshot: (id) =>
      safe(
        async () => {
          const value = await box(id);
          return { id: (await value.snapshot({ name: `sdk-v1-${value.size}-${crypto.randomUUID()}` })).id };
        },
        id,
        false,
        "snapshot",
      ),
    native(id) {
      const value = boxes.get(id);
      if (!value)
        throw new SandboxError(
          "Sandbox is not connected. No native object is cached. Connect first.",
          { code: "not_found", provider: "upstash", sandboxId: id },
        );
      return value;
    },
  };
  return provider;
}
