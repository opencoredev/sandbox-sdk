import { posix } from "node:path";
import type {
  DaytonaConfig,
  Sandbox as DaytonaSandbox,
  CreateSandboxBaseParams,
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
} from "@daytonaio/sdk";
import type {
  Provider,
  CreateInput,
  SandboxInfo,
  FileInfo,
  Labels,
  Preview,
} from "../../provider.js";
import { loadPeer } from "../../peer.js";
import { SandboxError } from "../../errors.js";
import { daytonaError, unsupported } from "./errors.js";
import { download, upload } from "./transfer.js";
import { quote } from "../../shared/shell.js";
import { execute, sessionProcess, workspaceCommand } from "./exec.js";
import type { DaytonaBox, DaytonaClient, DaytonaModule } from "./native.js";

export interface DaytonaOptions {
  /** Defaults to DAYTONA_API_KEY; required on first use unless jwtToken is set. */
  apiKey?: string;
  /** JWT authentication instead of an API key. Defaults to DAYTONA_JWT_TOKEN; needs organizationId. */
  jwtToken?: string;
  /** Organization for JWT authentication. Defaults to DAYTONA_ORGANIZATION_ID. */
  organizationId?: string;
  /** Defaults to DAYTONA_API_URL, then DAYTONA_SERVER_URL, then https://app.daytona.io/api. */
  baseUrl?: string;
  /** @deprecated Use baseUrl. Removed in 1.0.0. */
  apiUrl?: string;
  /** Defaults to DAYTONA_TARGET, then us. */
  target?: string;
  /** Container image; default: use the default or named snapshot. */
  image?: string;
  /** Snapshot name; default: the Daytona service default snapshot. */
  snapshot?: string;
  /** Control-plane deadline. Default: 30 s. */
  requestTimeoutMs?: number;
  /** Snapshot completion budget. Default: 600 seconds; maximum: 15 minutes. */
  snapshotTimeoutMs?: number;
  /** Creation budget, including any image build. Default: 60 s. */
  createTimeoutMs?: number;
  /** Serve preview URLs without the preview token. Default: false. */
  public?: boolean;
  /** Archive a stopped sandbox after this long, rounded up to whole minutes. Default: Daytona's 7 days. */
  autoArchiveMs?: number;
  /** Delete a stopped sandbox after this long, rounded up to whole minutes. `0` deletes it as soon as it stops. Default: never. */
  autoDeleteMs?: number;
  /** Daytona volumes to mount, such as `[{ volumeId: "my-volume", mountPath: "/data" }]`. */
  volumes?: CreateSandboxBaseParams["volumes"];
  /** Route the sandbox's HTTP(S) traffic through this proxy with HTTP(S)_PROXY. Not a security boundary on its own. */
  outboundProxyUrl?: string;
}

export type DaytonaCapability = "snapshot" | "size" | "network-policy";

export type DaytonaProvider = Provider<DaytonaSandbox, DaytonaCapability>;

const sdkLabel = { "sandbox-sdk": "1" };
const keyLabel = "sandbox-sdk-key";

/** SDK bookkeeping and the Daytona SDK's own label. Labels show only the caller's labels and `sandbox-sdk`. */
const internal = new Set([keyLabel, "code-toolbox-language"]);

const presets = {
  small: { cpu: 1, memoryMb: 1024, diskGb: 10 },
  medium: { cpu: 2, memoryMb: 4096, diskGb: 10 },
  large: { cpu: 4, memoryMb: 8192, diskGb: 10 },
};

type Size = NonNullable<CreateInput["size"]>;

function isPreset(size: Size): size is keyof typeof presets {
  return typeof size === "string";
}

function resources(size: Size) {
  // A preset name from untyped callers may still be unknown, so value can be undefined.
  const value = isPreset(size) ? presets[size] : size;
  const diskGb = value?.diskGb ?? 10;

  if (
    !value ||
    !Number.isInteger(value.cpu) ||
    value.cpu <= 0 ||
    !Number.isInteger(value.memoryMb) ||
    value.memoryMb <= 0 ||
    value.memoryMb % 1024 ||
    !Number.isInteger(diskGb) ||
    diskGb <= 0
  )
    unsupported(
      "Size requires positive integer CPUs, whole GiB memory (memoryMb divisible by 1024), and integer diskGb",
    );

  return { cpu: value.cpu, memory: value.memoryMb / 1024, disk: diskGb };
}

function minutes(ms: number, allowZero = false) {
  if (!Number.isFinite(ms) || ms < 0 || (ms === 0 && !allowZero))
    throw new SandboxError(
      `Timeout must be ${allowZero ? "zero or positive" : "positive"}. Invalid milliseconds supplied. Use a ${allowZero ? "non-negative" : "positive"} finite duration.`,
      { code: "invalid_argument", provider: "daytona" },
    );

  return Math.ceil(ms / 60_000);
}

function network(input: CreateInput["network"]) {
  if (input === undefined || input === "all" || input === "none")
    return { networkBlockAll: input === "none" };

  if (!input.allow.length) return { networkBlockAll: true };

  if (
    input.allow.some(
      (domain) =>
        !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(
          domain,
        ) || domain.length > 253,
    )
  )
    unsupported(
      "Network allow entries must be DNS hostnames without schemes, ports, commas, or wildcards",
    );

  return { networkBlockAll: false, domainAllowList: input.allow.join(",") };
}

function info(box: DaytonaBox, fallbackCreatedAt?: number): SandboxInfo {
  const createdAt = Date.parse(box.createdAt ?? "") || fallbackCreatedAt;

  if (createdAt === undefined || !Number.isFinite(createdAt))
    throw new SandboxError(
      "Sandbox creation time is missing. Daytona returned incomplete metadata. Refresh the sandbox metadata.",
      { code: "provider", provider: "daytona", sandboxId: box.id },
    );

  return {
    id: box.id,
    key: box.labels[keyLabel],
    labels: Object.fromEntries(Object.entries(box.labels).filter(([key]) => !internal.has(key))),
    createdAt,
    state: box.state === "started" ? "running" : box.state === "paused" ? "paused" : "stopped",
  };
}

/**
 * Since 0.227, a create that times out after Daytona made the sandbox names it on the error, and Daytona
 * leaves it running. Delete it, best effort and bounded, so the timeout still reaches the caller promptly.
 */
function hasSandboxId(cause: unknown): cause is { sandboxId: string } {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "sandboxId" in cause &&
    typeof cause.sandboxId === "string"
  );
}

async function abandon(client: DaytonaClient<DaytonaBox>, cause: unknown) {
  if (!hasSandboxId(cause)) return;
  const id = cause.sandboxId;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const removal = (async () => {
    await (await client.get(id)).delete(60, false);
  })().catch(() => {});

  await Promise.race([
    removal,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 10_000);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}

type NativeFile = Awaited<ReturnType<DaytonaBox["fs"]["getFileDetails"]>>;

function fileInfo(path: string, file: NativeFile): FileInfo {
  return {
    path,
    type: file.isDir
      ? "directory"
      : file.mode?.startsWith("L") || file.mode?.startsWith("l")
        ? "symlink"
        : "file",
    size: file.size ?? 0,
    modifiedAt: Date.parse(file.modifiedAt || file.modTime || "") || 0,
  };
}

/** @internal The adapter behind `daytona()`. `load` imports the Daytona SDK; tests pass a fixture. */
export function createDaytonaProvider<B extends DaytonaBox>(
  options: DaytonaOptions,
  load: () => Promise<DaytonaModule<B>>,
): Provider<B, DaytonaCapability> {
  let client: Promise<DaytonaClient<B>> | undefined;
  // Keep values across operations and concurrent creates, including env overrides.
  // Connect-time core secrets are not exposed at this boundary; only values the
  // adapter sees can be denied here. Strict evidence shapes also apply below.
  const knownSecrets = new Set<string>();

  const rememberEnv = (env: Record<string, string> = {}) => {
    for (const value of Object.values(env)) if (value) knownSecrets.add(value);
  };

  const boxes = new Map<string, B>();
  const unprepared = new Set<string>();
  const workspace = workspaceCommand;
  const recentCreates = new Map<string, { expiresAt: number }>();
  const deletions = new Map<string, Promise<void>>();
  const monitors = new Map<string, Set<() => void>>();

  async function api() {
    return (client ??= (async () => {
      if (
        !Number.isSafeInteger(options.snapshotTimeoutMs ?? 600_000) ||
        (options.snapshotTimeoutMs ?? 600_000) <= 0 ||
        (options.snapshotTimeoutMs ?? 600_000) > 900_000
      )
        throw new SandboxError("snapshotTimeoutMs must be an integer from 1 to 900000.", {
          code: "invalid_argument",
          provider: "daytona",
        });

      if (
        options.createTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.createTimeoutMs) || options.createTimeoutMs <= 0)
      )
        throw new SandboxError("createTimeoutMs must be a positive integer.", {
          code: "invalid_argument",
          provider: "daytona",
        });
      // An explicit jwtToken wins over the API key environment variable.
      const apiKey = options.apiKey ?? (options.jwtToken ? undefined : process.env.DAYTONA_API_KEY);
      const jwtToken = apiKey ? undefined : (options.jwtToken ?? process.env.DAYTONA_JWT_TOKEN);

      const config: DaytonaConfig = {
        apiUrl: options.baseUrl ?? options.apiUrl ?? process.env.DAYTONA_API_URL,
        target: options.target ?? process.env.DAYTONA_TARGET ?? "us",
        requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
        ...(jwtToken
          ? {
              jwtToken,
              organizationId: options.organizationId ?? process.env.DAYTONA_ORGANIZATION_ID,
            }
          : { apiKey }),
      };

      if (config.jwtToken && !config.organizationId)
        throw new SandboxError(
          "Daytona organization is missing. JWT authentication needs an organization ID. Set DAYTONA_ORGANIZATION_ID or pass organizationId.",
          { code: "auth", provider: "daytona" },
        );

      if (!config.apiKey && !config.jwtToken)
        throw new SandboxError(
          "Daytona API key is missing. Authentication is required. Set DAYTONA_API_KEY or pass apiKey.",
          { code: "auth", provider: "daytona" },
        );

      const { Daytona } = await loadPeer("@daytonaio/sdk", "daytona", load);

      return new Daytona(config);
    })());
  }

  for (const secret of [options.jwtToken, process.env.DAYTONA_JWT_TOKEN])
    if (secret) knownSecrets.add(secret);

  async function safe<T>(
    action: () => Promise<T>,
    id?: string,
    file = false,
    operation = file ? "files" : "request",
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw daytonaError(
        error,
        id,
        file,
        operation,
        options.apiKey ?? process.env.DAYTONA_API_KEY,
        knownSecrets,
      );
    }
  }

  async function box(id: string) {
    const cached = boxes.get(id);

    if (cached) return cached;
    const value = await (await api()).get(id);
    boxes.set(id, value);
    unprepared.add(id);

    return value;
  }

  const onFile = <T>(id: string, action: (value: B) => Promise<T>) =>
    safe(async () => action(await box(id)), id, true);

  const provider: Provider<B, DaytonaCapability> = {
    name: "daytona",
    inlineActivity: true,
    keyMode: "best-effort",
    capabilities: new Set<DaytonaCapability>(["snapshot", "size", "network-policy"]),
    async create(input) {
      rememberEnv(input.env);

      return safe(
        async () => {
          if (options.image && options.snapshot) unsupported("Choose either image or snapshot");
          const image = input.from === undefined ? options.image : undefined;
          const allocation = input.size === undefined ? undefined : resources(input.size);

          // Never round a hard maximum upward. Daytona cannot enforce sub-minute TTLs.
          if (
            input.timeoutMs !== undefined &&
            (input.timeoutMs < 60_000 || !Number.isFinite(input.timeoutMs))
          )
            unsupported("Daytona hard lifetime must be at least one minute");
          const labels: Labels = { ...input.labels, ...sdkLabel };
          delete labels[keyLabel];

          if (input.key !== undefined) labels[keyLabel] = input.key;

          const base: CreateSandboxFromSnapshotParams = {
            labels,
            envVars: input.env,
            public: options.public ?? false,
            ...network(input.network),
            autoStopInterval:
              input.idleTimeoutMs === undefined ? undefined : minutes(input.idleTimeoutMs),
            autoPauseInterval: 0,
            ttlMinutes:
              input.timeoutMs === undefined ? undefined : Math.floor(input.timeoutMs / 60_000),
          };

          if (options.autoArchiveMs !== undefined)
            base.autoArchiveInterval = minutes(options.autoArchiveMs);

          if (options.autoDeleteMs !== undefined)
            base.autoDeleteInterval = minutes(options.autoDeleteMs, true);

          if (options.volumes !== undefined) base.volumes = options.volumes;

          if (options.outboundProxyUrl !== undefined)
            base.outboundProxyUrl = options.outboundProxyUrl;

          const params: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams = image
            ? { ...base, image, resources: allocation }
            : {
                ...base,
                snapshot:
                  input.from ??
                  options.snapshot ??
                  (allocation?.cpu === 4 && allocation.memory === 8 && allocation.disk === 10
                    ? "daytona-large"
                    : undefined),
              };

          const createdAt = Date.now();
          const client = await api();

          const value = await client
            .create(params, { timeout: Math.ceil((options.createTimeoutMs ?? 60_000) / 1000) })
            .catch(async (cause: unknown) => {
              await abandon(client, cause);
              throw cause;
            });

          boxes.set(value.id, value);

          try {
            if (input.signal?.aborted)
              throw new SandboxError("Creation aborted. The caller cancelled. Retry when ready.", {
                code: "aborted",
                provider: "daytona",
              });

            if (
              allocation &&
              !image &&
              (allocation.cpu !== value.cpu ||
                allocation.memory !== value.memory ||
                allocation.disk !== value.disk)
            ) {
              if (allocation.disk < value.disk)
                unsupported(
                  "Snapshot disk cannot shrink; choose diskGb at least as large as the snapshot",
                );
              await value.stop();
              await value.resize(allocation);
              await value.start();
            }

            unprepared.add(value.id);
            recentCreates.set(value.id, { expiresAt: Date.now() + 30_000 });

            return info(value, createdAt);
          } catch (error) {
            await value.delete(60, true);
            boxes.delete(value.id);
            recentCreates.delete(value.id);
            throw error;
          }
        },
        undefined,
        false,
        input.from ? "restore" : "create",
      );
    },
    async list(labels: Labels) {
      return safe(
        async () => {
          const requested = { ...labels, ...sdkLabel };

          const matches = (value: B) =>
            Object.entries(requested).every(([key, expected]) => value.labels[key] === expected);

          const values = new Map<string, SandboxInfo>();

          for await (const value of (await api()).list({ labels: requested })) {
            if (matches(value)) {
              if (!boxes.has(value.id)) unprepared.add(value.id);
              boxes.set(value.id, value);
              values.set(value.id, info(value));
              recentCreates.delete(value.id);
            }
          }

          // Native list can lag behind create/get. Verify only recent local creates
          // omitted by the index; never resurrect a sandbox from stale cached data.
          for (const [id, creation] of recentCreates) {
            if (Date.now() >= creation.expiresAt) {
              recentCreates.delete(id);
              continue;
            }

            const cached = boxes.get(id);

            if (!cached || !matches(cached)) continue;

            try {
              const value = await (await api()).get(id);

              // Each creation record is an eligibility token. Destroy removes it,
              // so invalidation survives removal of the in-flight deletion entry.
              if (
                recentCreates.get(id) !== creation ||
                deletions.has(id) ||
                Date.now() >= creation.expiresAt
              )
                continue;

              if (matches(value)) {
                boxes.set(id, value);
                values.set(id, info(value));
              }
            } catch (error) {
              if (daytonaError(error).code !== "not_found") throw error;
              recentCreates.delete(id);
              boxes.delete(id);
            }
          }

          return [...values.values()];
        },
        undefined,
        false,
        "list",
      );
    },
    async find(key) {
      return (await provider.list({ [keyLabel]: key }))[0];
    },
    async connect(id) {
      return safe(
        async () => {
          const value = await (await api()).get(id);
          boxes.set(id, value);
          unprepared.add(id);

          return info(value);
        },
        id,
        false,
        "connect",
      );
    },
    async destroy(id) {
      const existing = deletions.get(id);

      if (existing) return existing;

      const deletion = safe(
        async () => {
          try {
            await (await box(id)).delete(60, true);
          } catch (error) {
            if (daytonaError(error).code !== "not_found") throw error;
          } finally {
            boxes.delete(id);
            recentCreates.delete(id);
            unprepared.delete(id);
          }
        },
        id,
        false,
        "destroy",
      );

      deletions.set(id, deletion);

      try {
        await deletion;
      } finally {
        deletions.delete(id);
      }
    },
    exec: (id, input) => {
      rememberEnv(input.env);

      return safe(
        async () =>
          execute(await box(id), input, unprepared.has(id) ? workspace : "", () =>
            unprepared.delete(id),
          ),
        id,
        false,
        "exec",
      );
    },
    startProcess: (id, input) => {
      rememberEnv(input.env);

      return safe(
        async () => {
          const hook = await sessionProcess(
            await box(id),
            input,
            undefined,
            unprepared.has(id) ? workspace : "",
          );

          if (hook.pid > 0) unprepared.delete(id);
          let active = monitors.get(id);

          if (!active) {
            active = new Set();
            monitors.set(id, active);
          }

          active.add(hook.detach);
          // Bookkeeping only: the caller sees the process's failure through wait() below.
          void hook
            .wait()
            .finally(() => active.delete(hook.detach))
            .catch(() => {});

          return {
            pid: hook.pid,
            wait: () => safe(hook.wait, id, false, "process"),
            stop: (settings) => safe(() => hook.stop(settings), id, false, "process"),
          };
        },
        id,
        false,
        "process",
      );
    },
    async close(id) {
      for (const detach of monitors.get(id) ?? []) detach();
      monitors.delete(id);
    },
    files: {
      writeCreatesParents: true,
      writeSupportsMode: true,
      read: (id, path) => onFile(id, async (value) => download(value, path)),
      write: (id, path, data, settings) =>
        onFile(id, async (value) => {
          const mode = settings?.mode;

          if (!unprepared.has(id)) {
            await upload(value, data, path);

            if (mode !== undefined)
              await value.fs.setFilePermissions(path, { mode: mode.toString(8) });

            return;
          }

          // Code is a request body, so even a large first write avoids argv limits.
          const result = await value.process.codeRun(
            `import os,base64,subprocess
subprocess.run(["sh","-c",${JSON.stringify(workspace)}],check=True)
p=${JSON.stringify(path)}
os.makedirs(os.path.dirname(p),exist_ok=True)
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,${mode ?? 0o666})${
              mode === undefined
                ? ""
                : `
os.fchmod(fd,${mode})`
            }
with os.fdopen(fd,"wb") as f: f.write(base64.b64decode(${JSON.stringify(Buffer.from(data).toString("base64"))}))`,
            undefined,
            120,
          );

          if (result.exitCode !== 0)
            throw new SandboxError(
              "File write failed. Workspace setup or the native code operation failed. Check guest permissions.",
              { code: "provider", provider: "daytona", sandboxId: id },
            );
          unprepared.delete(id);
        }),
      list: (id, path) =>
        onFile(id, async (value) => {
          try {
            return (await value.fs.listFiles(path)).map((file) =>
              fileInfo(posix.join(path, file.name), file),
            );
          } catch (error) {
            if (
              path !== "/workspace" ||
              !unprepared.has(id) ||
              daytonaError(error, id, true).code !== "file_not_found"
            )
              throw error;

            return [];
          }
        }),
      stat: (id, path) =>
        onFile(id, async (value) => {
          try {
            return fileInfo(path, await value.fs.getFileDetails(path));
          } catch (error) {
            if (
              path !== "/workspace" ||
              !unprepared.has(id) ||
              daytonaError(error, id, true).code !== "file_not_found"
            )
              throw error;

            return {
              path,
              type: "directory",
              size: 0,
              modifiedAt: Date.parse(value.createdAt ?? "") || Date.now(),
            };
          }
        }),
      remove: (id, path, settings) =>
        onFile(id, async (value) => {
          try {
            await value.fs.deleteFile(path, settings.recursive);
          } catch (error) {
            if (
              path !== "/workspace" ||
              !unprepared.has(id) ||
              daytonaError(error, id, true).code !== "file_not_found"
            )
              throw error;
          }

          if (path === "/workspace") unprepared.delete(id);
        }),
      mkdir: (id, path) =>
        onFile(id, async (value) => {
          if (!unprepared.has(id)) return value.fs.createFolder(path, "755");

          const result = await value.process.executeCommand(
            `${workspace} && mkdir -p ${quote(path)}`,
            "/",
            undefined,
            10,
          );

          if (result.exitCode !== 0)
            throw new SandboxError("Directory creation failed. Check guest permissions.", {
              code: "provider",
              provider: "daytona",
              sandboxId: id,
            });
          unprepared.delete(id);
        }),
    },
    previewUrl: (id, port) =>
      safe(
        async () => {
          const value = await box(id);
          const link = await value.getPreviewLink(port);
          const preview: Preview = { url: link.url };

          if (!value.public) preview.headers = { "X-Daytona-Preview-Token": link.token };

          return preview;
        },
        id,
        false,
        "preview",
      ),
    snapshot: (id, settings) =>
      safe(
        async () => {
          if (settings?.expiresInMs)
            unsupported(
              "Snapshot expiry is unavailable; Daytona keeps snapshots until you delete them. Omit expiresInMs, or pass 0",
            );
          const name = `sdk-${crypto.randomUUID()}`;

          try {
            await (
              await box(id)
            ).createSnapshot(name, (options.snapshotTimeoutMs ?? 600_000) / 1000);
          } catch (error) {
            const mapped = daytonaError(
              error,
              id,
              false,
              "snapshot",
              options.apiKey ?? process.env.DAYTONA_API_KEY,
              knownSecrets,
            );

            throw new SandboxError(
              `Snapshot ${name} did not complete. It may still be creating. Inspect or delete this name with the native snapshot API before retrying.`,
              {
                code: mapped.code,
                cause: mapped.cause,
                provider: "daytona",
                sandboxId: id,
                retryable: false,
                hint: `Recover snapshot ${name} from source sandbox ${id}.`,
              },
            );
          }

          return { id: name };
        },
        id,
        false,
        "snapshot",
      ),
    native(id) {
      const value = boxes.get(id);

      if (!value)
        throw new SandboxError(
          "Sandbox is not connected. No local native object exists. Connect the sandbox first.",
          { code: "not_found", provider: "daytona", sandboxId: id },
        );

      return value;
    },
  };

  return provider;
}
