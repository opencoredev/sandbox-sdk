import { createHash } from "node:crypto";
import {
  SandboxError,
  createDeadline,
  createNativeApi,
  sdkConstruct,
  sdkCall,
  sleep,
  type Provider,
  type NativeApi,
  type NativeSdkBinding,
  type CreateInput,
  type SandboxInfo,
  type Deadline,
  type Labels,
} from "../../provider.js";
import { sdkObject } from "../../native.js";
import { files, python, type Guest } from "../../shared/guest.js";
import { isString, isNumber } from "../../shared/narrow.js";
import { createosApi, sandboxRecord, record, type SandboxRecord } from "./api.js";
import { processes } from "./processes.js";
import { failure } from "./errors.js";
import { snapshots } from "./snapshots.js";

export interface CreateosOptions {
  /** State captured by snapshot(). Default: disk. Full includes VM memory. */
  snapshotType?: "disk" | "full";
  /** Deadline for asynchronous snapshot capture. Default: 300000 ms. */
  snapshotTimeoutMs?: number;
  /** Defaults to CREATEOS_SANDBOX_API_KEY. Read on first use, never at import time. */
  apiKey?: string;
  /** Defaults to CREATEOS_SANDBOX_BASE_URL, then https://api.sb.createos.sh. */
  baseUrl?: string;
  /** Catalog shape when createSandbox does not specify size. Default: s-1vcpu-1gb. */
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Shape is CreateOS's public resource term.
  shape?: string;
  /** Rootfs catalog name or an existing template ID/name. Default: devbox:1. */
  rootfs?: string;
  /** Optional CreateOS region. The API rejects regions it cannot serve. */
  region?: string;
  /** Overall deadline for control calls. Default: 60000 ms. Not a sandbox lifetime. */
  requestTimeoutMs?: number;
}

export interface CreateosSdkModule {
  CreateosSandboxClient: new (options: { apiKey: string; baseUrl: string; timeoutMs: number }) => {
    getSandbox(id: string): Promise<object>;
  };
}

export type CreateosSandboxSdk = <M extends CreateosSdkModule>(
  load: () => Promise<M>,
) => Promise<Awaited<ReturnType<InstanceType<M["CreateosSandboxClient"]>["getSandbox"]>>>;

export type CreateosClientSdk = <M extends CreateosSdkModule>(
  load: () => Promise<M>,
) => Promise<InstanceType<M["CreateosSandboxClient"]>>;

/** Raw native requests return CreateOS's JSend envelope. `{sandboxId}` fills automatically. */
export type CreateosNative = NativeApi<"api", CreateosSandboxSdk>;

type CreateosCapability =
  | "pause"
  | "terminal"
  | "size"
  | "network-policy"
  | "snapshot"
  | "snapshot-delete";

export type CreateosProvider = Provider<CreateosNative, CreateosCapability> & {
  readonly api: NativeApi<"api", CreateosClientSdk>;
};

const root = "/v1/sandboxes";
const path = `${root}/{sandboxId}`;
const keyLabel = "sandbox-sdk-key";
const dead = new Set(["failed", "error", "destroying", "destroyed"]);

const presets = {
  small: { cpu: 1, memoryMb: 1024 },
  medium: { cpu: 2, memoryMb: 2048 },
  large: { cpu: 4, memoryMb: 4096 },
};

function infoOf(box: SandboxRecord): SandboxInfo {
  return {
    id: box.id,
    key: box.labels[keyLabel],
    labels: box.labels,
    createdAt: box.createdAt,
    state:
      box.status === "paused" || box.status === "pausing"
        ? "paused"
        : dead.has(box.status)
          ? "stopped"
          : "running",
  };
}

/** CreateOS's fetch-only provider. */
export function createos(options: CreateosOptions = {}): CreateosProvider {
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;

  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
    throw failure("requestTimeoutMs must be positive milliseconds", "invalid_argument");

  const baseUrl = () =>
    options.baseUrl ?? process.env.CREATEOS_SANDBOX_BASE_URL ?? "https://api.sb.createos.sh";

  const apiKey = () => {
    const key = options.apiKey ?? process.env.CREATEOS_SANDBOX_API_KEY;

    if (!key?.trim()) throw failure("Set CREATEOS_SANDBOX_API_KEY or pass apiKey", "auth");

    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
      throw failure("requestTimeoutMs must be positive milliseconds", "invalid_argument");

    return key;
  };

  const api = createosApi({ baseUrl, apiKey, requestTimeoutMs });
  const commands = processes(api);
  const snapshotTimeoutMs = options.snapshotTimeoutMs ?? 300_000;

  if (!Number.isSafeInteger(snapshotTimeoutMs) || snapshotTimeoutMs <= 0)
    throw failure("snapshotTimeoutMs must be positive milliseconds", "invalid_argument");

  if (options.snapshotType !== undefined && !["disk", "full"].includes(options.snapshotType))
    throw failure("snapshotType must be disk or full", "invalid_argument");
  const snapshot = snapshots(api, options.snapshotType ?? "disk", snapshotTimeoutMs);

  const binding: NativeSdkBinding = {
    package: "@nodeops-createos/sandbox",
    async connect(module, id) {
      const client = sdkConstruct(
        module,
        "CreateosSandboxClient",
        [{ apiKey: apiKey(), baseUrl: baseUrl(), timeoutMs: requestTimeoutMs }],
        this.package,
      );

      return id === undefined
        ? client
        : sdkObject(
            await sdkCall(client, "getSandbox", [id], this.package),
            "Sandbox",
            this.package,
          );
    },
  };

  const get = async (id: string, deadline?: Deadline) =>
    sandboxRecord(
      await api.json({
        method: "GET",
        path,
        sandboxId: id,
        params: { sandboxId: id },
        deadline,
      }),
    );

  async function list(labels: Record<string, string>, deadline = createDeadline(requestTimeoutMs)) {
    const expected = { ...labels, "sandbox-sdk": "1" };

    const rows = await api.pages(
      { method: "GET", path: root, query: { labels: JSON.stringify(expected) }, deadline },
      "sandboxes",
    );

    return rows
      .map(sandboxRecord)
      .filter((box) => Object.entries(expected).every(([key, value]) => box.labels[key] === value));
  }

  async function settled(id: string, state: "running" | "paused", deadline: Deadline) {
    for (;;) {
      const box = await get(id, deadline);

      if (box.status === state) return box;

      if (dead.has(box.status))
        throw failure("Sandbox cannot reach the requested state", "not_found", id);
      await sleep(250, deadline, "createos");
    }
  }

  async function transition(
    id: string,
    operation: "pause" | "resume",
    deadline = createDeadline(requestTimeoutMs),
  ) {
    const desired = operation === "pause" ? "paused" : "running";
    const box = await get(id, deadline);

    if (box.status === desired) return box;

    if (box.status !== (operation === "pause" ? "pausing" : "resuming"))
      await api.json({
        method: "POST",
        path: `${path}/${operation}`,
        sandboxId: id,
        params: { sandboxId: id },
        deadline,
      });

    return settled(id, desired, deadline);
  }

  async function destroy(id: string) {
    commands.close(id);

    try {
      await api.http.request({ method: "DELETE", path, sandboxId: id, params: { sandboxId: id } });
    } catch (cause) {
      if (!(cause instanceof SandboxError && cause.code === "not_found")) throw cause;
    }
  }

  async function resource(size: CreateInput["size"], deadline: Deadline) {
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Wire field defined by CreateOS.
    if (size === undefined) return { shape: options.shape ?? "s-1vcpu-1gb" };
    const requested = isString(size) ? presets[size] : size;

    if (
      !requested ||
      !Number.isSafeInteger(requested.cpu) ||
      requested.cpu <= 0 ||
      !Number.isSafeInteger(requested.memoryMb) ||
      requested.memoryMb <= 0
    )
      throw failure("Size must specify positive integer CPU and memory", "invalid_argument");
    const diskGb = !isString(size) ? size.diskGb : undefined;

    if (diskGb !== undefined && (!Number.isSafeInteger(diskGb) || diskGb <= 0))
      throw failure("diskGb must be a positive integer", "invalid_argument");
    const catalog = await api.pages({ method: "GET", path: "/v1/shapes", deadline }, "shapes");

    const allocation = catalog.find(
      (item) =>
        record(item) &&
        item.vcpu === requested.cpu &&
        item.mem_mib === requested.memoryMb &&
        isString(item.id) &&
        (item.cpu_quota_pct === undefined ||
          item.cpu_quota_pct === 0 ||
          (isNumber(item.cpu_quota_pct) && item.cpu_quota_pct >= requested.cpu * 100)),
    );

    if (!record(allocation) || !isString(allocation.id))
      throw failure(
        "No CreateOS shape matches the requested CPU and memory; choose a catalog shape",
        "unsupported",
      );

    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Wire field defined by CreateOS.
    return { shape: allocation.id, disk_mib: diskGb === undefined ? undefined : diskGb * 1024 };
  }

  async function create(input: CreateInput) {
    if (input.timeoutMs !== undefined)
      throw failure("CreateOS cannot enforce a hard sandbox lifetime", "unsupported");

    if (
      input.network === "none" ||
      (input.network && input.network !== "all" && !input.network.allow.length)
    )
      throw failure(
        "CreateOS cannot express deny-all egress; empty rules allow all traffic",
        "unsupported",
      );
    const egress = input.network && input.network !== "all" ? input.network.allow : undefined;

    if (egress?.some((host) => !/^(\*\.)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)))
      throw failure("Network allow entries must be hostnames or wildcard hostnames", "unsupported");

    const idle =
      input.idleTimeoutMs === undefined ? undefined : Math.ceil(input.idleTimeoutMs / 1000);

    if (idle !== undefined && (!Number.isSafeInteger(idle) || idle < 60 || idle > 86_400))
      throw failure("CreateOS idle auto-pause must be between 60 and 86400 seconds", "unsupported");
    const deadline = createDeadline(requestTimeoutMs, input.signal);

    const resources =
      input.from !== undefined && input.size === undefined && options.shape === undefined
        ? {}
        : await resource(input.size, deadline);

    if (deadline.signal.aborted) throw failure("Creation aborted before submission", "aborted");
    const labels: Labels = { ...input.labels, "sandbox-sdk": "1" };
    delete labels[keyLabel];

    if (input.key) labels[keyLabel] = input.key;

    // The caller may stop waiting, but core needs the late ID to destroy an owned sandbox.
    const created = await api.json({
      method: "POST",
      path: root,
      timeoutMs: Math.max(1, deadline.remaining()),
      body: {
        ...resources,
        labels,
        envs: input.env,
        egress,
        name: input.key
          ? `sdk-${createHash("sha256").update(input.key).digest("hex").slice(0, 18)}`
          : undefined,
        rootfs: input.from === undefined ? (options.rootfs ?? "devbox:1") : undefined,
        snapshot_id: input.from,
        region: options.region,
        ingress_enabled: true,
        auto_pause_after_seconds: idle,
      },
    });

    if (!record(created) || !isString(created.id) || !created.id)
      throw failure(
        "CreateOS create response has no sandbox ID; inspect the account before retrying",
        "outcome_unknown",
      );
    const id = created.id;

    try {
      if (deadline.signal.aborted)
        throw failure("Creation cancelled after submission", "aborted", id);
      // The create response does not guarantee created_at. Read authoritative metadata for reaping.
      const box = await settled(id, "running", deadline);
      await commands.raw(id, "mkdir -p /workspace", undefined, deadline);

      return infoOf(box);
    } catch (cause) {
      await destroy(id);
      throw cause;
    }
  }

  async function safe<T>(id: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (cause) {
      if (cause instanceof SandboxError) throw cause;
      throw failure("CreateOS file operation failed", "provider", id);
    }
  }

  async function transfer<T>(id: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (cause) {
      if (cause instanceof SandboxError && cause.code === "not_found") {
        // A file route's 404 can mean either resource is gone; don't disguise a missing sandbox.
        await get(id);
        throw failure("File does not exist", "file_not_found", id);
      }

      throw cause;
    }
  }

  const guest = async (id: string): Promise<Guest> => ({
    name: "createos",
    raw: (command) => commands.raw(id, command),
    upload: (file, bytes) =>
      transfer(id, async () => {
        await api.http.request({
          method: "PUT",
          path: `${path}/files`,
          sandboxId: id,
          params: { sandboxId: id },
          query: { path: file },
          body: bytes,
          headers: { "content-type": "application/octet-stream" },
        });
      }),
    read: (file, range) =>
      transfer(id, async () => {
        if (range) {
          const deadline = createDeadline(requestTimeoutMs);
          const chunks: Buffer[] = [];
          let offset = range.offset;
          let remaining = range.length;

          do {
            // Base64 plus framing must fit CreateOS's 1 MiB per-process replay buffer.
            const length = Math.min(remaining, 512 * 1024);

            const text = await commands.raw(
              id,
              python(
                "import sys,base64\ntry:\n with open(sys.argv[1],'rb') as f:\n  f.seek(int(sys.argv[2])); print(base64.b64encode(f.read(int(sys.argv[3]))).decode())\nexcept (FileNotFoundError,NotADirectoryError):\n print('missing:')",
                file,
                String(offset),
                String(length),
              ),
              undefined,
              deadline,
            );

            if (text.trim() === "missing:")
              throw failure("File does not exist", "file_not_found", id);
            const chunk = Buffer.from(text.trim(), "base64");
            chunks.push(chunk);
            offset += chunk.length;
            remaining -= chunk.length;

            if (chunk.length < length) break;
          } while (remaining > 0);

          return Buffer.concat(chunks);
        }

        return (
          await api.http.request({
            method: "GET",
            path: `${path}/files`,
            sandboxId: id,
            params: { sandboxId: id },
            query: { path: file },
            maxBytes: 2 ** 32,
          })
        ).body;
      }),
  });

  const provider: CreateosProvider = {
    name: "createos",
    keyMode: "exact",
    capabilities: new Set<CreateosCapability>([
      "pause",
      "terminal",
      "size",
      "network-policy",
      "snapshot",
      "snapshot-delete",
    ]),
    snapshot: snapshot.capture,
    deleteSnapshot: snapshot.remove,
    create,
    async find(key) {
      const deadline = createDeadline(requestTimeoutMs);

      for (const candidate of await list({ [keyLabel]: key }, deadline)) {
        if (candidate.status === "destroyed") continue;

        try {
          // Recheck by immutable ID: a stale list must not delete a recovered sandbox.
          let box = await get(candidate.id, deadline);

          if (box.status === "failed" || box.status === "error") {
            await destroy(box.id);
            box = await get(box.id, deadline);
          }

          while (box.status === "destroying") {
            await sleep(250, deadline, "createos");
            box = await get(box.id, deadline);
          }

          if (box.status !== "destroyed") return await provider.connect(box.id);
        } catch (cause) {
          if (!(cause instanceof SandboxError && cause.code === "not_found")) throw cause;
        }
      }

      return undefined;
    },
    async connect(id) {
      const deadline = createDeadline(requestTimeoutMs);
      const box = await get(id, deadline);

      if (dead.has(box.status)) throw failure("Sandbox no longer exists", "not_found", id);

      if (box.status === "paused" || box.status === "pausing") {
        if (box.status === "pausing") await settled(id, "paused", deadline);

        return infoOf(await transition(id, "resume", deadline));
      }

      return infoOf(box.status === "running" ? box : await settled(id, "running", deadline));
    },
    list: async (labels) => (await list(labels)).filter((box) => !dead.has(box.status)).map(infoOf),
    destroy,
    exec: commands.execute,
    files: files(guest, safe),
    startProcess: commands.start,
    terminal: commands.terminal,
    close: async (id) => commands.close(id),
    pause: async (id) => {
      await transition(id, "pause");
    },
    resume: async (id) => {
      await transition(id, "resume");
    },
    async previewUrl(id, port) {
      const box = await get(id);

      if (!box.ingress)
        throw failure("Sandbox ingress is disabled or not provisioned", "port_not_ready", id);
      const url = new URL(box.ingress.replace("<port>", String(port)));

      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw failure("CreateOS returned an invalid ingress URL", "provider", id);

      return { url: url.toString() };
    },
    native: (id) =>
      createNativeApi<"api", CreateosSandboxSdk>({
        http: api.http,
        placeholder: "sandboxId",
        sandboxId: id,
        sdk: binding,
      }),
    api: createNativeApi<"api", CreateosClientSdk>({
      http: api.http,
      placeholder: "sandboxId",
      sdk: binding,
    }),
  };

  return provider;
}
