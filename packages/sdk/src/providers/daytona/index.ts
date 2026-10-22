import { posix } from "node:path";
import type { Daytona, DaytonaConfig, Sandbox as DaytonaSandbox, CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams } from "@daytonaio/sdk";
import type { Provider, CreateInput, SandboxInfo, FileInfo, Labels } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { daytonaError, unsupported } from "./errors.js";
import { execute, sessionProcess } from "./exec.js";

export interface DaytonaOptions {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  /** An image allows resources to be allocated at creation. Otherwise the
   * default/named snapshot is resized only when its resources differ. */
  image?: string;
  snapshot?: string;
  /** Provider control-plane request deadline, in milliseconds. */
  requestTimeoutMs?: number;
  /** Snapshot completion budget. Default: 600 seconds; maximum: 15 minutes. */
  snapshotTimeoutMs?: number;
}
export type DaytonaCapability = "snapshot" | "size" | "network-policy";
export type DaytonaProvider = Provider<DaytonaSandbox, DaytonaCapability>;
const sdkLabel = { "sandbox-sdk": "1" };
const keyLabel = "sandbox-sdk-key";
const presets = { small: { cpu: 1, memoryMb: 1024, diskGb: 10 }, medium: { cpu: 2, memoryMb: 4096, diskGb: 10 }, large: { cpu: 4, memoryMb: 8192, diskGb: 10 } };
function resources(size: NonNullable<CreateInput["size"]>) {
  const value = typeof size === "string" ? presets[size] : size;
  const diskGb = value?.diskGb ?? 10;
  if (!value || !Number.isInteger(value.cpu) || value.cpu <= 0 || !Number.isInteger(value.memoryMb) || value.memoryMb <= 0 || value.memoryMb % 1024 || !Number.isInteger(diskGb) || diskGb <= 0) unsupported("Size requires positive integer CPUs, whole GiB memory (memoryMb divisible by 1024), and integer diskGb");
  return { cpu: value.cpu, memory: value.memoryMb / 1024, disk: diskGb };
}
function minutes(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) throw new SandboxError("Timeout must be positive. Invalid milliseconds supplied. Use a positive finite duration.", { code: "invalid_argument", provider: "daytona" });
  return Math.ceil(ms / 60_000);
}
function network(input: CreateInput["network"]) {
  if (typeof input !== "object") return { networkBlockAll: input === "none" };
  if (!input.allow.length) return { networkBlockAll: true };
  if (input.allow.some(domain => !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(domain) || domain.length > 253)) unsupported("Network allow entries must be DNS hostnames without schemes, ports, commas, or wildcards");
  return { networkBlockAll: false, domainAllowList: input.allow.join(",") };
}
function info(box: DaytonaSandbox): SandboxInfo {
  const createdAt = Date.parse(box.createdAt ?? "");
  if (!Number.isFinite(createdAt)) throw new SandboxError("Sandbox creation time is missing. Daytona returned incomplete metadata. Refresh the sandbox metadata.", { code: "provider", provider: "daytona", sandboxId: box.id });
  return { id: box.id, key: box.labels[keyLabel], labels: { ...box.labels }, createdAt, state: box.state === "started" ? "running" : box.state === "paused" ? "paused" : "stopped" };
}
type NativeFile = Awaited<ReturnType<DaytonaSandbox["fs"]["getFileDetails"]>>;
function fileInfo(path: string, file: NativeFile): FileInfo {
  return { path, type: file.isDir ? "directory" : file.mode?.startsWith("L") || file.mode?.startsWith("l") ? "symlink" : "file", size: file.size ?? 0, modifiedAt: Date.parse(file.modifiedAt || file.modTime || "") || 0 };
}

/** Direct Daytona adapter. The optional SDK is loaded only on first operation. */
export function daytona(options: DaytonaOptions = {}): DaytonaProvider {
  let client: Promise<Daytona> | undefined;
  const boxes = new Map<string, DaytonaSandbox>();
  const recentCreates = new Map<string, { expiresAt: number }>();
  const deletions = new Map<string, Promise<void>>();
  const monitors = new Map<string, Set<() => void>>();
  async function api() {
    return client ??= (async () => {
      if (!Number.isSafeInteger(options.snapshotTimeoutMs ?? 600_000) || (options.snapshotTimeoutMs ?? 600_000) <= 0 || (options.snapshotTimeoutMs ?? 600_000) > 900_000)
        throw new SandboxError("snapshotTimeoutMs must be an integer from 1 to 900000.", { code: "invalid_argument", provider: "daytona" });
      const config: DaytonaConfig = { apiKey: options.apiKey ?? process.env.DAYTONA_API_KEY, apiUrl: options.apiUrl ?? process.env.DAYTONA_API_URL, target: options.target ?? process.env.DAYTONA_TARGET ?? "us", requestTimeoutMs: options.requestTimeoutMs ?? 30_000 };
      if (!config.apiKey) throw new SandboxError("Daytona API key is missing. Authentication is required. Set DAYTONA_API_KEY or apiKey.", { code: "auth", provider: "daytona" });
      const { Daytona } = await import("@daytonaio/sdk");
      return new Daytona(config);
    })();
  }
  async function safe<T>(action: () => Promise<T>, id?: string, file = false, operation = file ? "files" : "request"): Promise<T> { try { return await action(); } catch (error) { throw daytonaError(error, id, file, operation, options.apiKey ?? process.env.DAYTONA_API_KEY); } }
  async function box(id: string) { const cached = boxes.get(id); if (cached) return cached; const value = await (await api()).get(id); boxes.set(id, value); return value; }
  const onFile = <T>(id: string, action: (value: DaytonaSandbox) => Promise<T>) => safe(async () => action(await box(id)), id, true);
  const provider: DaytonaProvider = {
    name: "daytona", keyMode: "best-effort", capabilities: new Set<DaytonaCapability>(["snapshot", "size", "network-policy"]),
    async create(input) { return safe(async () => {
      if (options.image && options.snapshot) unsupported("Choose either image or snapshot");
      const image = input.from === undefined ? options.image : undefined;
      const allocation = input.size === undefined ? undefined : resources(input.size);
      // Never round a hard maximum upward. Daytona cannot enforce sub-minute TTLs.
      if (input.timeoutMs !== undefined && (input.timeoutMs < 60_000 || !Number.isFinite(input.timeoutMs))) unsupported("Daytona hard lifetime must be at least one minute");
      const labels: Labels = { ...input.labels, ...sdkLabel }; delete labels[keyLabel];
      if (input.key !== undefined) labels[keyLabel] = input.key;
      const base: CreateSandboxFromSnapshotParams = {
        labels, envVars: input.env,
        public: false, ...network(input.network),
        autoStopInterval: input.idleTimeoutMs === undefined ? undefined : minutes(input.idleTimeoutMs), autoPauseInterval: 0,
        ttlMinutes: input.timeoutMs === undefined ? undefined : Math.floor(input.timeoutMs / 60_000),
      };
      const params: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams = image ? { ...base, image, resources: allocation } : { ...base, snapshot: input.from ?? options.snapshot ?? (allocation?.cpu === 4 && allocation.memory === 8 && allocation.disk === 10 ? "daytona-large" : undefined) };
      const value = await (await api()).create(params, { timeout: 60 });
      boxes.set(value.id, value);
      try {
        if (input.signal?.aborted) throw new SandboxError("Creation aborted. The caller cancelled. Retry when ready.", { code: "aborted", provider: "daytona" });
        if (allocation && !image && (allocation.cpu !== value.cpu || allocation.memory !== value.memory || allocation.disk !== value.disk)) {
          if (allocation.disk < value.disk) unsupported("Snapshot disk cannot shrink; choose diskGb at least as large as the snapshot");
          await value.stop(); await value.resize(allocation); await value.start();
        }
        const workspace = await value.process.executeCommand(
          'if [ ! -w /workspace ]; then sudo -n install -d -o "$(id -u)" -g "$(id -g)" -m 755 /workspace; fi; test -w /workspace',
          "/", undefined, 10,
        );
        if (workspace.exitCode !== 0) throw new SandboxError("Workspace is not writable. Guest setup requires passwordless sudo. Use a Daytona runtime with sudo -n access.", { code: "provider", provider: "daytona", sandboxId: value.id });
        recentCreates.set(value.id, { expiresAt: Date.now() + 30_000 });
        return info(value);
      } catch (error) { await value.delete(60, true); boxes.delete(value.id); recentCreates.delete(value.id); throw error; }
    }, undefined, false, input.from ? "restore" : "create"); },
    async list(labels: Labels) { return safe(async () => {
      const requested = { ...labels, ...sdkLabel };
      const matches = (value: DaytonaSandbox) => Object.entries(requested).every(([key, expected]) => value.labels[key] === expected);
      const values = new Map<string, SandboxInfo>();
      for await (const value of (await api()).list({ labels: requested })) {
        if (matches(value)) { boxes.set(value.id, value); values.set(value.id, info(value)); recentCreates.delete(value.id); }
      }
      // Native list can lag behind create/get. Verify only recent local creates
      // omitted by the index; never resurrect a sandbox from stale cached data.
      for (const [id, creation] of recentCreates) {
        if (Date.now() >= creation.expiresAt) { recentCreates.delete(id); continue; }
        const cached = boxes.get(id); if (!cached || !matches(cached)) continue;
        try {
          const value = await (await api()).get(id);
          // Each creation record is an eligibility token. Destroy removes it,
          // so invalidation survives removal of the in-flight deletion entry.
          if (recentCreates.get(id) !== creation || deletions.has(id) || Date.now() >= creation.expiresAt) continue;
          if (matches(value)) { boxes.set(id, value); values.set(id, info(value)); }
        } catch (error) {
          if (daytonaError(error).code !== "not_found") throw error;
          recentCreates.delete(id); boxes.delete(id);
        }
      }
      return [...values.values()];
    }, undefined, false, "list"); },
    async find(key) { return (await provider.list({ [keyLabel]: key }))[0]; },
    async connect(id) { return safe(async () => { const value = await (await api()).get(id); boxes.set(id, value); return info(value); }, id, false, "connect"); },
    async destroy(id) {
      const existing = deletions.get(id); if (existing) return existing;
      const deletion = safe(async () => { try { await (await box(id)).delete(60, true); } catch (error) { if (daytonaError(error).code !== "not_found") throw error; } finally { boxes.delete(id); recentCreates.delete(id); } }, id, false, "destroy");
      deletions.set(id, deletion);
      try { await deletion; } finally { deletions.delete(id); }
    },
    exec: (id, input) => safe(async () => execute(await box(id), input), id, false, "exec"),
    startProcess: (id, input) => safe(async () => {
      const hook = await sessionProcess(await box(id), input);
      let active = monitors.get(id); if (!active) { active = new Set(); monitors.set(id, active); }
      active.add(hook.detach);
      void hook.wait().finally(() => active.delete(hook.detach)).catch(() => {});
      return { pid: hook.pid, wait: () => safe(hook.wait, id, false, "process"), stop: settings => safe(() => hook.stop(settings), id, false, "process") };
    }, id, false, "process"),
    async close(id) { for (const detach of monitors.get(id) ?? []) detach(); monitors.delete(id); },
    files: {
      writeCreatesParents: true,
      read: (id, path) => onFile(id, async value => new Uint8Array(await value.fs.downloadFile(path))),
      write: (id, path, data) => onFile(id, value => value.fs.uploadFile(Buffer.from(data), path)),
      list: (id, path) => onFile(id, async value => (await value.fs.listFiles(path)).map(file => fileInfo(posix.join(path, file.name), file))),
      stat: (id, path) => onFile(id, async value => fileInfo(path, await value.fs.getFileDetails(path))),
      remove: (id, path, settings) => onFile(id, value => value.fs.deleteFile(path, settings.recursive)),
      mkdir: (id, path) => onFile(id, value => value.fs.createFolder(path, "755")),
    },
    previewUrl: (id, port) => safe(async () => { const value = await box(id); const link = await value.getPreviewLink(port); return { url: link.url, ...(value.public ? {} : { headers: { "X-Daytona-Preview-Token": link.token } }) }; }, id, false, "preview"),
    snapshot: id => safe(async () => {
      const name = `sdk-${crypto.randomUUID()}`;
      try { await (await box(id)).createSnapshot(name, (options.snapshotTimeoutMs ?? 600_000) / 1000); }
      catch (error) {
        const mapped = daytonaError(error, id, false, "snapshot", options.apiKey ?? process.env.DAYTONA_API_KEY);
        throw new SandboxError(`Snapshot ${name} did not complete. It may still be creating. Inspect or delete this name with the native snapshot API before retrying.`, { code: mapped.code, cause: mapped.cause, provider: "daytona", sandboxId: id, retryable: false, hint: `Recover snapshot ${name} from source sandbox ${id}.` });
      }
      return { id: name };
    }, id, false, "snapshot"),
    native(id) { const value = boxes.get(id); if (!value) throw new SandboxError("Sandbox is not connected. No local native object exists. Connect the sandbox first.", { code: "not_found", provider: "daytona", sandboxId: id }); return value; },
  };
  return provider;
}
