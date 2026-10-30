import { isObject, isString } from "../../shared/narrow.js";
import { posix } from "node:path";
import type { Provider, CreateInput, SandboxInfo, FileInfo, Labels } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { createDeadline } from "../../http.js";
import {
  createNativeApi,
  sdkCall,
  sdkConstruct,
  type NativeApi,
  type NativeSdkBinding,
  sdkObject,
} from "../../native.js";
import { daytonaError, unsupported } from "./errors.js";
import {
  daytonaHttp,
  type Credentials,
  type DaytonaControl,
  type DaytonaPlane,
  type FileDto,
  type SandboxDto,
} from "./api.js";
import { execute, sessionProcess, workspaceCommand, quote } from "./exec.js";

export type { DaytonaPlane } from "./api.js";

/** A Daytona volume to mount. */
export type DaytonaVolume = {
  volumeId: string;
  mountPath: string;
  subpath?: string;
};

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
  volumes?: DaytonaVolume[];
  /** Route the sandbox's HTTP(S) traffic through this proxy with HTTP(S)_PROXY. Not a security boundary on its own. */
  outboundProxyUrl?: string;
}

export type DaytonaCapability = "snapshot" | "size" | "network-policy";

/** What `native.sdk(load)` needs from `@daytonaio/sdk`: the `Daytona` client class and its `get`. */
export interface DaytonaSdkModule {
  Daytona: new (config: {
    apiKey?: string;
    jwtToken?: string;
    organizationId?: string;
    apiUrl?: string;
    target?: string;
  }) => { get(sandboxIdOrName: string): Promise<object> };
}

/** `box.native.sdk`: the `Sandbox` of the `@daytonaio/sdk` you imported. */
export type DaytonaSandboxSdk = <M extends DaytonaSdkModule>(
  load: () => Promise<M>,
) => Promise<Awaited<ReturnType<InstanceType<M["Daytona"]>["get"]>>>;

/** `provider.api.sdk`: a `Daytona` client of the `@daytonaio/sdk` you imported. */
export type DaytonaClientSdk = <M extends DaytonaSdkModule>(
  load: () => Promise<M>,
) => Promise<InstanceType<M["Daytona"]>>;

/**
 * `box.native` for Daytona. Planes: `"api"` (default), the control plane at `baseUrl`, and `"toolbox"`, the
 * sandbox's file and process daemon. `{sandboxId}` fills itself from the sandbox; toolbox paths are already
 * scoped to it (`"/files"`, `"/process/execute"`).
 */
export type DaytonaNative = NativeApi<DaytonaPlane, DaytonaSandboxSdk>;

export type DaytonaProvider = Provider<DaytonaNative, DaytonaCapability> & {
  /** Account-level calls to Daytona's control plane, bound to no sandbox. `api.sdk(load)` returns a `Daytona` client. */
  readonly api: NativeApi<DaytonaPlane, DaytonaClientSdk>;
};

const sdkLabel = { "sandbox-sdk": "1" };
const keyLabel = "sandbox-sdk-key";

/** Finds a sandbox whose create request was lost before Daytona answered. */
const createLabel = "sandbox-sdk-create";

/** Daytona's code runner reads this; the official SDK always sets it. */
const languageLabel = "code-toolbox-language";

/** SDK bookkeeping and Daytona's language label. Labels show only the caller's labels and `sandbox-sdk`. */
const internal = new Set([keyLabel, createLabel, languageLabel]);

/** How long a failed create may spend deleting what it left behind before the error reaches the caller. */
const abandonMs = 10_000;

const presets = {
  small: { cpu: 1, memoryMb: 1024, diskGb: 10 },
  medium: { cpu: 2, memoryMb: 4096, diskGb: 10 },
  large: { cpu: 4, memoryMb: 8192, diskGb: 10 },
};

function resources(size: NonNullable<CreateInput["size"]>) {
  const value = isString(size) ? presets[size] : size;
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
  if (!isObject(input)) return { networkBlockAll: input === "none" };

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

function info(box: SandboxDto, fallbackCreatedAt?: number): SandboxInfo {
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

/** Races `work` against the abandon bound, so cleanup never holds a create error back for long. */
async function bounded(work: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, abandonMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}

/**
 * A create whose request was lost (`outcome_unknown`) may still have made a sandbox. Look for it by its
 * per-request label, best effort and bounded: Daytona's list can lag behind create by a few seconds.
 */
async function abandonLost(control: DaytonaControl, nonce: string): Promise<boolean> {
  let stop = false;
  let deleted = false;
  await bounded(
    (async () => {
      for (let attempt = 0; attempt < 5 && !stop; attempt++) {
        for await (const value of control.list({ [createLabel]: nonce })) {
          await control.cleanup(value.id);
          deleted = true;

          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    })(),
  );
  stop = true;

  return deleted;
}

function fileInfo(path: string, file: FileDto): FileInfo {
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

/** Direct Daytona adapter over HTTP. Nothing is sent and no credentials are read until the first operation. */
export function daytona(options: DaytonaOptions = {}): DaytonaProvider {
  // Keep values across operations and concurrent creates, including env overrides.
  // Connect-time core secrets are not exposed at this boundary; only values the
  // adapter sees can be denied here. Strict evidence shapes also apply below.
  const knownSecrets = new Set<string>();

  const rememberEnv = (env: Record<string, string> = {}) => {
    for (const value of Object.values(env)) if (value) knownSecrets.add(value);
  };

  const boxes = new Map<string, SandboxDto>();
  const natives = new Map<string, DaytonaNative>();
  const unprepared = new Set<string>();
  const workspace = workspaceCommand;
  const recentCreates = new Map<string, { expiresAt: number }>();
  const deletions = new Map<string, Promise<void>>();
  const monitors = new Map<string, Set<() => void>>();

  for (const secret of [options.jwtToken, process.env.DAYTONA_JWT_TOKEN])
    if (secret) knownSecrets.add(secret);

  const baseUrl = () =>
    options.baseUrl ??
    options.apiUrl ??
    process.env.DAYTONA_API_URL ??
    process.env.DAYTONA_SERVER_URL ??
    "https://app.daytona.io/api";

  const target = () => options.target ?? process.env.DAYTONA_TARGET ?? "us";
  let resolved: Credentials | undefined;

  /** Read once, on first use. An explicit jwtToken wins over the API key environment variable. */
  function credentials(): Credentials {
    if (resolved) return resolved;
    const apiKey = options.apiKey ?? (options.jwtToken ? undefined : process.env.DAYTONA_API_KEY);
    const jwtToken = apiKey ? undefined : (options.jwtToken ?? process.env.DAYTONA_JWT_TOKEN);
    const organizationId = options.organizationId ?? process.env.DAYTONA_ORGANIZATION_ID;

    if (jwtToken && !organizationId)
      throw new SandboxError(
        "Daytona organization is missing. JWT authentication needs an organization ID. Set DAYTONA_ORGANIZATION_ID or pass organizationId.",
        { code: "auth", provider: "daytona" },
      );

    if (!apiKey && !jwtToken)
      throw new SandboxError(
        "Daytona API key is missing. Authentication is required. Set DAYTONA_API_KEY or pass apiKey.",
        { code: "auth", provider: "daytona" },
      );

    return (resolved = apiKey ? { apiKey } : { jwtToken, organizationId });
  }

  const { http, control, toolbox } = daytonaHttp({
    baseUrl,
    credentials,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    secrets: () => knownSecrets,
  });

  let checked = false;

  /** Validates options and credentials before the first adapter operation. */
  function ready() {
    if (checked) return;

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
    credentials();
    checked = true;
  }

  const sdk: NativeSdkBinding = {
    package: "@daytonaio/sdk",
    async connect(module, sandboxId) {
      const { apiKey, jwtToken, organizationId } = credentials();

      const client = sdkConstruct(
        module,
        "Daytona",
        [
          {
            ...(apiKey ? { apiKey } : { jwtToken, organizationId }),
            apiUrl: baseUrl(),
            target: target(),
          },
        ],
        "@daytonaio/sdk",
      );

      return sandboxId === undefined
        ? client
        : sdkObject(
            await sdkCall(client, "get", [sandboxId], "@daytonaio/sdk"),
            "Daytona.get",
            "@daytonaio/sdk",
          );
    },
  };

  async function safe<T>(
    action: () => Promise<T>,
    id?: string,
    file = false,
    operation = file ? "files" : "request",
  ): Promise<T> {
    try {
      ready();

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
    const value = await control.get(id);
    boxes.set(id, value);
    unprepared.add(id);

    return value;
  }

  const onFile = <T>(id: string, action: (value: ReturnType<typeof toolbox>) => Promise<T>) =>
    safe(
      async () => {
        await box(id);

        return action(toolbox(id));
      },
      id,
      true,
    );

  const provider: DaytonaProvider = {
    name: "daytona",
    inlineActivity: true,
    keyMode: "best-effort",
    capabilities: new Set<DaytonaCapability>(["snapshot", "size", "network-policy"]),
    api: createNativeApi<DaytonaPlane, DaytonaClientSdk>({ http, placeholder: "sandboxId", sdk }),
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
          const nonce = crypto.randomUUID();
          const labels: Labels = { ...input.labels, ...sdkLabel };
          delete labels[keyLabel];

          if (input.key !== undefined) labels[keyLabel] = input.key;
          labels[createLabel] = nonce;
          labels[languageLabel] = "python";

          const snapshot = image
            ? undefined
            : (input.from ??
              options.snapshot ??
              (allocation?.cpu === 4 && allocation.memory === 8 && allocation.disk === 10
                ? "daytona-large"
                : undefined));

          // The official SDK's request body for the same parameters.
          const body = {
            ...(snapshot === undefined ? undefined : { snapshot }),
            ...(image
              ? { buildInfo: { dockerfileContent: `FROM ${image}\n` }, ...allocation }
              : undefined),
            env: input.env ?? {},
            labels,
            public: options.public ?? false,
            target: target(),
            ...network(input.network),
            autoStopInterval:
              input.idleTimeoutMs === undefined ? undefined : minutes(input.idleTimeoutMs),
            autoPauseInterval: 0,
            ...(options.autoArchiveMs === undefined
              ? undefined
              : { autoArchiveInterval: minutes(options.autoArchiveMs) }),
            ...(options.autoDeleteMs === undefined
              ? undefined
              : { autoDeleteInterval: minutes(options.autoDeleteMs, true) }),
            ...(options.volumes === undefined ? undefined : { volumes: options.volumes }),
            ...(options.outboundProxyUrl === undefined
              ? undefined
              : { outboundProxyUrl: options.outboundProxyUrl }),
            ttlMinutes:
              input.timeoutMs === undefined ? undefined : Math.floor(input.timeoutMs / 60_000),
          };

          const createdAt = Date.now();
          const budgetMs = options.createTimeoutMs ?? 60_000;
          // The create request ignores the caller's signal: aborting it mid-flight could leave a sandbox nobody
          // knows about. An abort is honoured once Daytona answers, by deleting what it made.
          const deadline = createDeadline(budgetMs);
          let value: SandboxDto;

          try {
            value = await control.create(body, deadline);
          } catch (error) {
            if (
              !(error instanceof SandboxError) ||
              error.code !== "outcome_unknown" ||
              !(await abandonLost(control, nonce))
            )
              throw error;
            // The lost request did make a sandbox, and it is deleted now, so the outcome is known.
            throw new SandboxError(
              `Sandbox creation did not answer within ${Math.ceil(budgetMs / 1000)} seconds. The sandbox it made was deleted. Retry, or raise createTimeoutMs.`,
              { code: "timeout", provider: "daytona", retryable: true },
            );
          }

          try {
            if (value.state !== "started") {
              try {
                value =
                  (await control.waitFor(
                    value.id,
                    (state) => state === "started",
                    createDeadline(deadline.remaining(), input.signal),
                    "start",
                  )) ?? value;
              } catch (error) {
                if (!(error instanceof SandboxError) || error.code !== "timeout") throw error;
                throw new SandboxError(
                  `Sandbox did not start within ${Math.ceil(budgetMs / 1000)} seconds. It was deleted. Retry, or raise createTimeoutMs.`,
                  { code: "timeout", provider: "daytona", sandboxId: value.id, retryable: true },
                );
              }
            }

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
              if (allocation.disk < (value.disk ?? 0))
                unsupported(
                  "Snapshot disk cannot shrink; choose diskGb at least as large as the snapshot",
                );
              await control.stop(value.id);
              await control.resize(value.id, allocation);
              await control.start(value.id);
              value = await control.get(value.id);
            }

            boxes.set(value.id, value);
            unprepared.add(value.id);
            recentCreates.set(value.id, { expiresAt: Date.now() + 30_000 });

            return info(value, createdAt);
          } catch (error) {
            // Daytona made the sandbox, so a failed create must not leave it running.
            await bounded(control.remove(value.id, true));
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

          const matches = (value: SandboxDto) =>
            Object.entries(requested).every(([key, expected]) => value.labels[key] === expected);

          const values = new Map<string, SandboxInfo>();

          for await (const value of control.list(requested)) {
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
              const value = await control.get(id);

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
          const value = await control.get(id);
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
            await control.remove(id, true);
          } catch (error) {
            if (daytonaError(error).code !== "not_found") throw error;
          } finally {
            boxes.delete(id);
            natives.delete(id);
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
        async () => {
          await box(id);

          return execute(toolbox(id), input, unprepared.has(id) ? workspace : "", () =>
            unprepared.delete(id),
          );
        },
        id,
        false,
        "exec",
      );
    },
    startProcess: (id, input) => {
      rememberEnv(input.env);

      return safe(
        async () => {
          await box(id);

          const hook = await sessionProcess(
            toolbox(id),
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
      read: (id, path) => onFile(id, (value) => value.fs.download(path)),
      write: (id, path, data, settings) =>
        onFile(id, async (value) => {
          const mode = settings?.mode;

          if (!unprepared.has(id)) {
            await value.fs.upload(data, path);

            if (mode !== undefined) await value.fs.setFilePermissions(path, mode.toString(8));

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
              modifiedAt: Date.parse(boxes.get(id)?.createdAt ?? "") || Date.now(),
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
          const link = await control.previewLink(id, port);

          return {
            url: link.url,
            ...(value.public ? undefined : { headers: { "X-Daytona-Preview-Token": link.token } }),
          };
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
          await box(id);

          try {
            await control.snapshot(id, name, options.snapshotTimeoutMs ?? 600_000);
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
      if (!boxes.has(id))
        throw new SandboxError(
          "Sandbox is not connected. No local native object exists. Connect the sandbox first.",
          { code: "not_found", provider: "daytona", sandboxId: id },
        );
      let value = natives.get(id);

      if (!value) {
        value = createNativeApi<DaytonaPlane, DaytonaSandboxSdk>({
          http,
          placeholder: "sandboxId",
          sandboxId: id,
          sdk,
        });
        natives.set(id, value);
      }

      return value;
    },
  };

  return provider;
}
