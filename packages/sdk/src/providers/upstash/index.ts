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
import type { Box, BoxConfig, BoxData, BoxSize, EphemeralBoxConfig, FileStat, NetworkPolicy } from "@upstash/box";
import { loadPeer } from "../../peer.js";
import type {
  Provider,
  SandboxInfo,
  Labels,
  FileInfo,
  CreateInput,
  Preview,
} from "../../provider.js";
import { Redactor, SandboxError } from "../../errors.js";
import { defaults, quote } from "../../run.js";
import { bufferedExecute } from "./buffered.js";
import { upstashError, unsupported } from "./errors.js";
import { execute, startProcess } from "./exec.js";
import { listDirectory, readFile, writeFile } from "./files.js";

type CommonOptions = {
  /** Defaults to UPSTASH_BOX_API_KEY; required on first use. */
  apiKey?: BoxConfig["apiKey"];
  /** Defaults to UPSTASH_BOX_BASE_URL, then https://us-east-1.box.upstash.com. */
  baseUrl?: BoxConfig["baseUrl"];
  /** Runtime; default: the Upstash service default. */
  runtime?: BoxConfig["runtime"];
  /** Native telemetry; default: true, overridden by UPSTASH_DISABLE_TELEMETRY. */
  enableTelemetry?: BoxConfig["enableTelemetry"];
  /** Native SDK operation timeout, not a sandbox lifetime. Default: 600 s; snapshot listing: 30 s. */
  requestTimeoutMs?: number;
  /** Public previews. Default: false (previews require a bearer token). */
  public?: boolean;
  /** Headers the box's egress proxy adds to outbound HTTPS requests, keyed by host pattern such as `"api.stripe.com"` or `"*.example.com"`. Values never enter the box. */
  attachHeaders?: BoxConfig["attachHeaders"];
};
/** Durable Box: pauses when idle and keeps its files until destroyed. */
export type UpstashBoxOptions = CommonOptions & {
  /** Durable mode. Default: false. */
  ephemeral?: false;
  /** Keep the box running instead of pausing it when idle. Default: false. */
  keepAlive?: boolean;
  /** Provision a headless Chromium, reachable through `box.native.browser`. Default: false. */
  browser?: boolean;
};
/** Ephemeral Box: ready on create, cannot pause, and Upstash deletes it after its TTL. */
export type UpstashEphemeralOptions = CommonOptions & {
  /** Select ephemeral mode; required for ephemeral options. Default: false. */
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
const metadataEnv = "SANDBOX_SDK_UPSTASH_METADATA";
const workspace = `if ! mkdir -p /workspace 2>/dev/null || [ ! -w /workspace ]; then sudo -n install -d -o "$(id -u)" -g "$(id -g)" -m 755 /workspace; fi && test -w /workspace`;
const metadataPath = "/tmp/.sandbox-sdk/upstash.json";
// Upstash reruns initCommand on automatic as well as explicit resume. Disk
// snapshots retain process records, but cannot restore those OS processes.
const initCommand = `for d in /tmp/.sandbox-sdk/procs/*; do [ -f "$d/spec.json" ] && [ ! -f "$d/exit" ] && printf 137 > "$d/exit"; done; rm -rf /tmp/.sandbox-sdk/upstash-runs; true`;
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
  const unprepared = new Set<string>();
  const nativeFactories = new Map<string, () => Box>();
  const environments = new Map<string, Record<string, string>>();
  let module: Promise<typeof import("@upstash/box")> | undefined;
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
        "Upstash Box API key is missing. Authentication is required. Set UPSTASH_BOX_API_KEY or pass apiKey.",
        { code: "auth", provider: "upstash" },
      );
    redactor.add([apiKey]);
    return { apiKey, baseUrl: options.baseUrl, enableTelemetry: options.enableTelemetry };
  };
  const sdk = async () => {
    const config = connection();
    const { Box, EphemeralBox } = await (module ??= loadPeer("@upstash/box", "upstash", () => import("@upstash/box")));
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
    const lazy = nativeFactories.get(id);
    if (lazy) { const value = lazy(); boxes.set(id, value); nativeFactories.delete(id); return value; }
    const cached = boxes.get(id);
    if (cached) return cached;
    const { Box, config } = await sdk();
    const value = await Box.get(id, { ...config, timeout: options.requestTimeoutMs });
    boxes.set(id, value); unprepared.add(id);
    return value;
  }
  const onFile = <T>(id: string, operation: string, action: (value: Box) => Promise<T>) =>
    safe(async () => action(await box(id)), id, true, `files.${operation}`);
  const readMetadata = async (value: Box) => {
    const result = await value.exec.command(`if [ -n "$${metadataEnv}" ]; then printf %s "$${metadataEnv}"; else cat ${quote(metadataPath)}; fi`);
    if (result.exitCode !== 0) throw new SandboxError("SDK metadata was not found", { code: "not_found", provider: "upstash", sandboxId: value.id });
    return metadata(result.stdout);
  };
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
  const provider: UpstashProvider = {
    name: "upstash",
    keyMode: "best-effort",
    // Sessions share the container's PID namespace as boxuser; root-owned init processes are read through sudo.
    procActivity: true,
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
        if (input.env && metadataEnv in input.env)
          throw new SandboxError(`${metadataEnv} is reserved for SDK discovery metadata. Choose another environment variable name.`, { code: "invalid_argument", provider: "upstash" });
        redactor.add(Object.values(input.env ?? {}));
        redactor.add(Object.values(options.attachHeaders ?? {}).flatMap(headers => Object.values(headers)));
        const policy = network(input.network);
        const { Box, EphemeralBox, config } = await sdk();
        const meta: Metadata = { version: 1, key: input.key, labels: { ...input.labels, "sandbox-sdk": "1" } };
        const params = {
          ...config,
          runtime: options.runtime,
          size: input.size ?? (input.from === undefined ? undefined : await snapshotSize(input.from)),
          // Native create-time env; values never enter command text.
          env: { ...input.env, [metadataEnv]: JSON.stringify(meta) },
          labels: [marker],
          networkPolicy: policy,
          timeout: options.requestTimeoutMs,
          ...(options.attachHeaders === undefined ? {} : { attachHeaders: options.attachHeaders }),
        } satisfies BoxConfig & EphemeralBoxConfig;
        // Durable-only settings; the ephemeral option type has no such fields.
        const durable = options.ephemeral ? {} : { ...(options.keepAlive === undefined ? {} : { keepAlive: options.keepAlive }), ...(options.browser === undefined ? {} : { browser: options.browser }) } satisfies BoxConfig;
        const createdAt = Date.now();
        const created = ttl === undefined
          ? input.from === undefined ? await Box.create({ ...params, ...durable, initCommand }) : await Box.fromSnapshot(input.from, { ...params, ...durable, initCommand })
          : input.from === undefined ? await EphemeralBox.create({ ...params, ttl }) : await EphemeralBox.fromSnapshot(input.from, { ...params, ttl });
        try {
          if (input.signal?.aborted)
            throw new SandboxError("Creation aborted. The caller cancelled. Retry when ready.", {
              code: "aborted",
              provider: "upstash",
            });
          if (created instanceof Box) boxes.set(created.id, created);
          else {
            // native() is synchronous. The public Box constructor attaches a fully
            // typed handle without fetching metadata the create call already fixed.
            nativeFactories.set(created.id, () => new Box({
              id: created.id, status: "running", created_at: createdAt / 1000, updated_at: createdAt / 1000,
              size: params.size ?? "small", labels: [marker],
              network_policy: { mode: policy.mode, ...("allowedDomains" in policy ? { allowed_domains: policy.allowedDomains } : {}) },
            }, {
              baseUrl: (config.baseUrl ?? process.env.UPSTASH_BOX_BASE_URL ?? "https://us-east-1.box.upstash.com").replace(/\/$/, ""),
              headers: { "X-Box-Api-Key": config.apiKey }, timeout: options.requestTimeoutMs ?? 600_000, debug: false,
            }));
          }
          if (ttl !== undefined && input.from !== undefined && (await created.exec.command(initCommand)).exitCode !== 0)
            throw new SandboxError("Restored process records could not be invalidated", { code: "provider", provider: "upstash", sandboxId: created.id });
          environments.set(created.id, { ...input.env, ...defaults });
          unprepared.add(created.id);
          return { id: created.id, key: meta.key, labels: meta.labels, createdAt, state: "running" };
        } catch (error) {
          await created.delete();
          boxes.delete(created.id); nativeFactories.delete(created.id); unprepared.delete(created.id); environments.delete(created.id);
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
        const value = await box(id); unprepared.add(id);
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
          environments.delete(id); nativeFactories.delete(id); unprepared.delete(id);
        }
      }, id, false, "destroy"),
    exec: (id, input) => safe(async () => {
      const value = await box(id);
      const env: Record<string, string> = environments.get(id) ?? defaults;
      if (input.streaming !== true && input.stdin === undefined &&
        input.timeoutMs + 15_000 <= (options.requestTimeoutMs ?? 600_000) &&
        Object.entries(input.env).every(([key, item]) => env[key] === item)) {
        const result = await bufferedExecute(value, input, unprepared.has(id) ? workspace : undefined);
        if (result) { if (!result.timedOut) unprepared.delete(id); return result; }
      }
      const result = await execute(value, input, unprepared.has(id) ? workspace : undefined, () => unprepared.delete(id));
      return result;
    }, id, false, "exec"),
    startProcess: (id, input) =>
      safe(async () => {
        const value = await box(id);
        // Ephemeral boxes cannot pause; kill the launcher's group, found by its private run path.
        const halt = ttl === undefined
          ? () => value.pause()
          : (dir: string) => value.exec.command(
            `for p in $(pgrep -f ${quote(`[${dir[1]}]${dir.slice(2)}/`)}); do kill -KILL -$p 2>/dev/null; done; true`,
          );
        const hook = await startProcess(value, input, halt, unprepared.has(id) ? workspace : undefined);
        unprepared.delete(id);
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
      environments.delete(id); nativeFactories.delete(id); unprepared.delete(id);
    },
    files: {
      writeCreatesParents: true,
      editInGuest: true,
      // Upstash's own step history, written into the workspace by the platform.
      internal: [".step-git"],
      read: (id, path) => onFile(id, "read", value => readFile(value, path)),
      readRange: (id, path, range) => onFile(id, "readRange", value => readFile(value, path, range)),
      write: (id, path, data) => onFile(id, "write", value => writeFile(value, path, data, unprepared.has(id) ? workspace : undefined).then(() => { unprepared.delete(id); })),
      list: (id, path) =>
        onFile(id, "list", async (value) => {
          const entries = await listDirectory(value, path, unprepared.has(id) ? workspace : undefined);
          if (entries) {
            unprepared.delete(id);
            return entries.map((entry) => {
              if (entry.type === "other") unsupported("Special filesystem entries are not supported");
              return { path: posix.join(path, entry.name), type: entry.type, size: entry.size, modifiedAt: entry.modifiedAt };
            });
          }
          return Promise.all(
            (await value.files.list(path)).map(async (entry) => {
              const full = posix.join(path, entry.name);
              return fileInfo(full, await value.files.stat(full));
            }),
          );
        }),
      stat: (id, path) => onFile(id, "stat", async (value) => {
        try { return fileInfo(path, await value.files.stat(path)); }
        catch (error) { if (path !== "/workspace" || !unprepared.has(id) || upstashError(error, id, true).code !== "file_not_found") throw error; return { path, type: "directory", size: 0, modifiedAt: Date.now() }; }
      }),
      remove: (id, path, settings) => onFile(id, "remove", async value => {
        try { await value.files.remove(path, settings); }
        catch (error) { if (path !== "/workspace" || !unprepared.has(id) || upstashError(error, id, true).code !== "file_not_found") throw error; }
        if (path === "/workspace") unprepared.delete(id);
      }),
      mkdir: (id, path) => onFile(id, "mkdir", async value => {
        if (!unprepared.has(id)) return value.files.mkdir(path, { parents: true });
        const result = await value.exec.command(`${workspace} && mkdir -p ${quote(path)}`);
        if (result.exitCode !== 0) throw new SandboxError("Directory creation failed. Check guest permissions.", { code: "provider", provider: "upstash", sandboxId: id });
        unprepared.delete(id);
      }),
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
    snapshot: (id, settings) =>
      safe(
        async () => {
          if (settings?.expiresInMs) unsupported("Snapshot expiry is unavailable; Upstash keeps snapshots until you delete them. Omit expiresInMs, or pass 0");
          const value = await box(id);
          return { id: (await value.snapshot({ name: `sdk-v1-${value.size}-${crypto.randomUUID()}` })).id };
        },
        id,
        false,
        "snapshot",
      ),
    native(id) {
      const lazy = nativeFactories.get(id);
      if (lazy) { const value = lazy(); boxes.set(id, value); nativeFactories.delete(id); return value; }
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
