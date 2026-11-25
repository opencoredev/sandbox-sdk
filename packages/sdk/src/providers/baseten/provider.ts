/** Verified against @basetenlabs/sandbox 0.5.0 (https://github.com/basetenlabs/baseten-js). */
import { createHash } from "node:crypto";
import type {
  Sandbox,
  SandboxClient,
  SandboxClientOptions,
  SandboxCreateRequest,
  SandboxCreateResult,
  SandboxInfo as BasetenInfo,
  SandboxLifecycle,
  VolumeInfo,
} from "@basetenlabs/sandbox";
import type { CreateInput, Labels, Provider, SandboxInfo } from "../../provider.js";
import { loadPeer } from "../../peer.js";
import { files, python, type Guest } from "../../shared/guest.js";
import { isString } from "../../shared/narrow.js";
import type { SandboxError } from "../../errors.js";
import { basetenError, failure, nativeStatus as rejected } from "./errors.js";
import { execute } from "./execute.js";

export interface BasetenOptions {
  /** Defaults to BASETEN_API_KEY. */
  apiKey?: string;
  /** Team to act in. Unset uses the key's only team. */
  teamId?: string;
  /** Image reference with its tag. Defaults to Baseten's `baseten/base-image:latest`. */
  image?: string;
  /** Region to run in. Unset lets Baseten pick the closest. */
  region?: string;
  /** How long create waits for a sandbox (and its volume) to deploy. Default: 120 s. */
  readyTimeoutMs?: number;
  /**
   * A persistent volume made for each sandbox, mounted at `mountPath` and deleted with the
   * sandbox. Baseten holds a sandbox's files in its memory, so a large workspace competes with
   * processes for RAM; a volume puts those files on disk. Not available with `key`.
   */
  volume?: BasetenVolume;
}

export interface BasetenVolume {
  /** Whole GiB. Baseten caps the size per account (8 GiB on the bench's account, 2026-11-16). */
  sizeGiB: number;
  /** Absolute path the volume is mounted at. */
  mountPath: string;
}

/** The options that choose which Baseten account and team an adapter acts in. */
export type BasetenConnection = Pick<BasetenOptions, "apiKey" | "teamId">;

/** What a Baseten adapter builds its client with, in the shape `new SandboxClient(config)` takes. */
export interface BasetenConfig {
  readonly apiKey: string;
  /** `undefined` acts in the key's only team. */
  readonly teamId: string | undefined;
}

/**
 * The key and team `baseten(options)` builds its `SandboxClient` with, read from `options` and the
 * environment as the adapter reads them. Throws `auth` when the key is missing, as the adapter does.
 * It holds the credentials: never log, print or store it.
 */
export function resolveConfig(options: BasetenConnection = {}): BasetenConfig {
  const apiKey = options.apiKey ?? process.env.BASETEN_API_KEY;

  if (!apiKey?.trim())
    throw failure(
      "Baseten API key is missing. Authentication is required. Set BASETEN_API_KEY or pass apiKey.",
      "auth",
    );

  return { apiKey, teamId: options.teamId };
}

export interface BasetenNative {
  sandbox: Sandbox;
  client: SandboxClient;
}

type BasetenCapability = "size";

export type BasetenProvider = Provider<BasetenNative, BasetenCapability>;

/** The `@basetenlabs/sandbox` module, or a test fixture with the same shape. */
export interface BasetenModule {
  SandboxClient: new (options: SandboxClientOptions) => SandboxClient;
}

const prefix = "sbxsdk-";

// Baseten sets CPU from memory: 2 GiB per vCPU up to 4 vCPUs, as `nproc` shows in the sandbox.
const memoryPerCpu = 2048;

function memoryFor(size: CreateInput["size"]): number | undefined {
  if (size === undefined) return undefined;

  if (isString(size)) return { small: 2048, medium: 4096, large: 8192 }[size];

  // Checked live: 2048, 4096 and 8192 MiB give 1, 2 and 4 vCPUs, but 16384 MiB gives 6, not 8.
  // Larger sizes stay unsupported until their CPU count is known.
  if (![1, 2, 4].includes(size.cpu) || size.memoryMb !== size.cpu * memoryPerCpu)
    throw failure(
      `Baseten sets CPU from memory; the sizes known to match are 1 vCPU / ${memoryPerCpu} MiB, 2 / ${2 * memoryPerCpu} and 4 / ${4 * memoryPerCpu}`,
      "unsupported",
    );

  if (size.diskGb !== undefined)
    throw failure("Baseten keeps files in memory and has no disk size option", "unsupported");

  return size.memoryMb;
}

/** The volume made for a sandbox: named after it, so any client can find and delete it. */
const volumeOf = (sandbox: string) => `${sandbox}-v`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A keyed sandbox's native name, so Baseten's unique names make the key exact. */
function keyedName(key: string) {
  return `${prefix}k${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

function lifecycle(input: CreateInput): SandboxLifecycle | undefined {
  const policies: NonNullable<SandboxLifecycle["expirationPolicies"]> = [];

  if (input.timeoutMs !== undefined)
    policies.push({ type: "TTL_MAX_AGE", afterMs: input.timeoutMs });

  if (input.idleTimeoutMs !== undefined)
    policies.push({ type: "TTL_IDLE", afterMs: input.idleTimeoutMs });

  return policies.length ? { expirationPolicies: policies } : undefined;
}

const gone = new Set(["FAILED", "DELETING", "TERMINATED", "DEACTIVATING"]);

function state(status: string): SandboxInfo["state"] | undefined {
  if (gone.has(status)) return undefined;

  if (["DEACTIVATED", "ARCHIVING", "ARCHIVED"].includes(status)) return "paused";

  return "running";
}

// Each create stamps its own attempt ID, so cleanup after an ambiguous create deletes only a
// sandbox this attempt made, never a keyed sandbox another client won. Never shown as a label.
const attemptLabel = "sandbox-sdk-attempt";

function toInfo(native: BasetenInfo): SandboxInfo | undefined {
  if (!native.name.startsWith(prefix)) return undefined;
  const value = state(native.status);

  if (value === undefined) return undefined;
  const { [attemptLabel]: _attempt, ...labels } = native.labels;

  return {
    id: native.name,
    key: native.externalId || undefined,
    labels,
    state: value,
    createdAt: native.createdAt.getTime(),
  };
}

function matches(info: SandboxInfo, labels: Labels) {
  return Object.entries(labels).every(([key, value]) => info.labels[key] === value);
}

// Writes argv[3] bytes of argv[1] from offset argv[2] to stdout, base64 encoded.
const readRange =
  "import sys,base64; f=open(sys.argv[1],'rb'); f.seek(int(sys.argv[2])); sys.stdout.write(base64.b64encode(f.read(int(sys.argv[3]))).decode())";

/** @internal The adapter behind `baseten()`. `load` imports the Baseten SDK; tests pass a fixture. */
export function createBasetenProvider(
  options: BasetenOptions,
  load: () => Promise<BasetenModule>,
): BasetenProvider {
  let client: Promise<SandboxClient> | undefined;
  let current: SandboxClient | undefined;
  const boxes = new Map<string, Sandbox>();
  /**
   * Sandboxes this client created without a volume. Destroy deletes `<id>-v` for every other
   * sandbox, including connected ones and retries after the sandbox is gone; a missing volume is
   * not an error, so only these skip that request.
   */
  const madeWithoutVolume = new Set<string>();

  /** A sandbox's previews, through the control plane only, so a record without an execution URL works too. */
  async function previewsOf(c: SandboxClient, id: string) {
    const known = boxes.get(id);

    if (known) return known.previews;

    // Previews never use the execution URL: a pending record has none yet, and Baseten keeps a
    // sandbox's previews after its own record expires, so a missing record still lists them.
    let info: BasetenInfo;

    try {
      info = await c.getInfo({ name: id });
    } catch (error) {
      if (basetenError(error, id).code !== "not_found") throw error;
      info = {
        name: id,
        status: "TERMINATED",
        envs: {},
        labels: {},
        ports: [],
        volumes: [],
        createdAt: new Date(0),
      };
    }

    return (await c.get({ info: { ...info, url: info.url ?? "https://pending.invalid" } }))
      .previews;
  }

  async function api() {
    return (client ??= (async () => {
      const config = resolveConfig(options);
      const { SandboxClient } = await loadPeer("@basetenlabs/sandbox", "baseten", load);

      const clientOptions: SandboxClientOptions = { ...config };

      // @basetenlabs/sandbox 0.5.0 loads its optional undici through
      // createRequire(import.meta.url). A CommonJS bundle empties import.meta, so that throws on
      // the first request and every later one. The bundle empties this module's import.meta too:
      // when it is empty, send requests with the global fetch instead.
      if (!isString(import.meta.url)) clientOptions.nodeUndici = false;

      return (current = new SandboxClient(clientOptions));
    })());
  }

  async function safe<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw basetenError(error, id);
    }
  }

  async function sandbox(id: string): Promise<Sandbox> {
    const known = boxes.get(id);

    if (known) return known;
    const c = await api();
    const found = await c.getInfo({ name: id });

    if (!toInfo(found)) throw failure("Sandbox not found", "not_found", id);
    // Another client may still be deploying it: wait for its URL. Never deletes, unlike create.
    const info = await ready(c, found);
    const value = await c.get({ info });
    boxes.set(id, value);

    return value;
  }

  async function guest(id: string): Promise<Guest> {
    const box = await sandbox(id);

    return {
      name: "baseten",
      raw: async (command) => {
        const result = await box.process.exec({
          command,
          waitForCompletion: true,
          timeoutMs: 60_000,
        });

        if (result.exitCode !== 0) throw failure("Guest operation failed", "provider", id);

        return result.stdout;
      },
      upload: async (path, bytes) => {
        await box.fs.writeBytes({ path, content: bytes });
      },
      read: async (path, range) => {
        if (!range) {
          try {
            return await box.fs.readBytes({ path });
          } catch (error) {
            const mapped = basetenError(error, id);

            if (mapped.code === "not_found")
              throw failure("File does not exist", "file_not_found", id);

            // 0.5.0 takes any JSON response for a directory listing, and Baseten serves .json
            // files as JSON. Read through the guest, which fails for a real directory.
            if (!(error instanceof Error && error.message.endsWith("is a directory, not a file")))
              throw mapped;
          }
        }

        const result = await box.process.exec({
          command: python(readRange, path, String(range?.offset ?? 0), String(range?.length ?? -1)),
          waitForCompletion: true,
          timeoutMs: 60_000,
        });

        if (result.exitCode !== 0) throw failure("File does not exist", "file_not_found", id);

        return new Uint8Array(Buffer.from(result.stdout, "base64"));
      },
    };
  }

  async function lookup(id: string): Promise<SandboxInfo | undefined> {
    try {
      const c = await api();
      const native = await c.getInfo({ name: id });
      const value = toInfo(native);

      if (value && native.url) boxes.set(id, await c.get({ info: native }));

      return value;
    } catch (error) {
      if (basetenError(error, id).code === "not_found") return undefined;
      throw error;
    }
  }

  async function ready(c: SandboxClient, info: BasetenInfo): Promise<BasetenInfo> {
    const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
    let current = info;

    while (current.status !== "DEPLOYED" || !current.url) {
      if (gone.has(current.status))
        throw failure(`Sandbox did not deploy (${current.status})`, "provider", info.name);

      if (Date.now() > deadline) throw failure("Sandbox did not deploy in time", "timeout");
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = await c.getInfo({ name: info.name });
    }

    return current;
  }

  /** Waits for a volume to deploy; it must, before a sandbox can mount it. */
  async function volumeReady(c: SandboxClient, info: VolumeInfo, signal?: AbortSignal) {
    const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
    let current = info;

    while (current.status !== "DEPLOYED") {
      if (["FAILED", "DELETING"].includes(current.status))
        throw failure(`Volume did not deploy (${current.status})`);

      if (Date.now() > deadline) throw failure("Volume did not deploy in time", "timeout");

      if (signal?.aborted) throw failure("Creation aborted", "aborted");
      await sleep(250);
      current = await c.volumes.getInfo({ name: info.name });
    }

    return current;
  }

  /**
   * Deletes a volume, true once it is gone. Baseten refuses (409) while the sandbox that mounted
   * it is still shutting down, a few seconds after its delete returns, so that is retried.
   */
  async function dropVolume(c: SandboxClient, name: string): Promise<boolean> {
    const deadline = Date.now() + 120_000;

    for (;;) {
      try {
        await c.volumes.delete({ name });

        return true;
      } catch (error) {
        const { code } = basetenError(error);

        if (code === "not_found") return true;

        // 409 while the sandbox shuts down; 5xx and network failures may pass too.
        const retryable =
          rejected(error) === 409 ||
          (rejected(error) ?? 0) >= 500 ||
          ["unavailable", "timeout"].includes(code);

        if (!retryable || Date.now() > deadline) return false;
      }

      await sleep(1000);
    }
  }

  const provider: BasetenProvider = {
    name: "baseten",
    keyMode: "exact",
    inlineActivity: true,
    capabilities: new Set(["size"]),
    create: (input) =>
      safe(undefined, async () => {
        if (input.from !== undefined)
          throw failure("Baseten adapter has no snapshot restore", "unsupported");

        if (input.network !== undefined && input.network !== "all")
          throw failure("Baseten adapter has no network policy", "unsupported");

        // A keyed create can race another client for the name, and the volume would race too.
        if (options.volume && input.key !== undefined)
          throw failure("Baseten volumes cannot be combined with a key", "unsupported");
        const memory = memoryFor(input.size);

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        const c = await api();

        const attempt = crypto.randomUUID();

        const name =
          input.key === undefined ? `${prefix}${crypto.randomUUID()}` : keyedName(input.key);

        // The volume comes first: a sandbox mounts it at creation, in the volume's region.
        let volume: VolumeInfo | undefined;

        if (options.volume) {
          const volumeName = volumeOf(name);

          try {
            volume = await volumeReady(
              c,
              await c.volumes.create({
                name: volumeName,
                size: `${options.volume.sizeGiB}Gi`,
                region: options.region,
                callOptions: { signal: input.signal },
              }),
              input.signal,
            );
          } catch (error) {
            // A lost response may still have made it; the name is this attempt's alone.
            if (!(await dropVolume(c, volumeName)))
              throw failure(
                `Volume ${volumeName} may exist and could not be deleted; delete it before retrying`,
                "outcome_unknown",
              );
            throw basetenError(error);
          }
        }

        /** Settles a failure once the sandbox is known gone: its volume goes too. */
        const withoutVolume = async (error: SandboxError) => {
          if (volume && !(await dropVolume(c, volume.name)))
            return failure(
              `Sandbox creation failed and volume ${volume.name} could not be deleted; delete it`,
              "outcome_unknown",
            );

          return error;
        };

        const request: SandboxCreateRequest = {
          name,
          image: options.image,
          memory,
          region: volume?.region ?? options.region,
          envs: Object.fromEntries(
            Object.entries(input.env ?? {}).map(([key, value]) => [key, { value, secret: true }]),
          ),
          labels: { ...input.labels, [attemptLabel]: attempt },
          externalId: input.key,
          lifecycle: lifecycle(input),
          callOptions: { signal: input.signal },
        };

        if (volume && options.volume)
          request.volumes = [{ name: volume.name, mountPath: options.volume.mountPath }];

        // The record to wait on, and the handle create returned when it returned one.
        let record: BasetenInfo;
        let handle: SandboxCreateResult | undefined;

        try {
          handle = await c.create(request);
          record = handle.info;
        } catch (error) {
          const mapped = basetenError(error);

          // Only an HTTP rejection proves Baseten made nothing. Any other failure may follow an
          // accepted create: a lost response, or the SDK throwing on the response itself (0.5.0
          // throws when it has no URL yet). A sandbox under this name with this attempt's ID is
          // this create's: unless the caller aborted, wait for it like any other. Absence, or
          // another attempt's sandbox, settles that this one made nothing.
          if (rejected(error) === undefined || ["unavailable", "timeout"].includes(mapped.code)) {
            const found = await c.getInfo({ name }).catch((cause: unknown) => {
              if (basetenError(cause).code === "not_found") return undefined;
              throw failure(
                `Sandbox creation outcome is unknown; delete ${name}${volume ? ` and volume ${volume.name}` : ""} if they exist before retrying`,
                "outcome_unknown",
              );
            });

            const marker = found?.labels[attemptLabel];
            const aborted = mapped.code === "aborted" || input.signal?.aborted === true;

            if (found && marker === attempt && !aborted && !gone.has(found.status)) record = found;
            else {
              // Only an explicit other marker proves another attempt made it: labels can be
              // replaced wholesale by update(), so a missing marker leaves the outcome unknown.
              const cleaned =
                found === undefined ||
                (marker !== undefined &&
                  (marker !== attempt ||
                    (await c.delete({ name }).then(
                      () => true,
                      (cause: unknown) => basetenError(cause).code === "not_found",
                    ))));

              if (!cleaned)
                throw failure(
                  `Sandbox creation outcome is unknown; delete ${name}${volume ? ` and volume ${volume.name}` : ""} if they exist before retrying`,
                  "outcome_unknown",
                );

              throw await withoutVolume(aborted ? failure("Creation aborted", "aborted") : mapped);
            }
          } else throw await withoutVolume(mapped);
        }

        try {
          const info = await ready(c, record);
          boxes.set(info.name, handle && info === record ? handle : await c.get({ info }));
          const value = toInfo(info);

          if (!value) throw failure("Created sandbox is not usable", "provider", info.name);

          if (!volume) madeWithoutVolume.add(info.name);

          return value;
        } catch (error) {
          boxes.delete(name);

          // The sandbox exists and is billed: settle the failure only once it is gone.
          const cleaned = await c.delete({ name }).then(
            () => true,
            (cause: unknown) => basetenError(cause).code === "not_found",
          );

          if (!cleaned)
            throw failure(
              `Sandbox ${name} did not become usable and could not be deleted; delete it${volume ? ` and volume ${volume.name}` : ""} before retrying`,
              "outcome_unknown",
              name,
            );
          throw await withoutVolume(basetenError(error, name));
        }
      }),
    find: (key) => safe(undefined, () => lookup(keyedName(key))),
    connect: (id) =>
      safe(id, async () => {
        if (!id.startsWith(prefix)) throw failure("Not an SDK sandbox", "not_found", id);
        const value = await lookup(id);

        if (!value) throw failure("Sandbox not found", "not_found", id);

        return value;
      }),
    list: (labels) =>
      safe(undefined, async () => {
        const result: SandboxInfo[] = [];

        for await (const native of (await api()).list({}))
          if (native.name.startsWith(prefix)) {
            const value = toInfo(native);

            if (value && matches(value, labels)) result.push(value);
          }

        return result;
      }),
    destroy: (id) =>
      safe(id, async () => {
        const c = await api();

        // Baseten keeps a preview, and its slot in the account's preview quota, after the sandbox
        // is deleted, so delete every preview first, whichever client made it.
        try {
          const previews = await previewsOf(c, id);

          for await (const preview of previews.list()) {
            try {
              await previews.delete({ name: preview.name });
            } catch (error) {
              // Expired, or deleted by another caller meanwhile.
              if (basetenError(error, id).code !== "not_found") throw error;
            }
          }
        } catch (error) {
          if (basetenError(error, id).code !== "not_found") throw error;
        }

        try {
          await c.delete({ name: id });
        } catch (error) {
          if (basetenError(error, id).code !== "not_found") throw error;
        }

        boxes.delete(id);

        // After the sandbox, which must be gone first. A retry after a failed volume delete finds
        // the sandbox gone and comes back here.
        if (!madeWithoutVolume.has(id) && !(await dropVolume(c, volumeOf(id))))
          throw failure(`Volume ${volumeOf(id)} could not be deleted; delete it`, "provider", id);
        madeWithoutVolume.delete(id);
      }),
    async close(id) {
      boxes.delete(id);
    },
    exec: (id, input) =>
      safe(id, async () => {
        const box = await sandbox(id);

        return execute({
          processes: box.process,
          sandboxId: id,
          input,
          uploadSpec: async (spec, signal) => {
            const path = `/tmp/.sandbox-sdk/spec-${crypto.randomUUID()}.json`;

            await box.fs.writeBytes({
              path,
              content: new TextEncoder().encode(spec),
              callOptions: { signal },
            });

            return path;
          },
          removeSpec: async (path) => {
            await box.fs.remove({ path });
          },
        });
      }),
    files: files(guest, safe),
    previewUrl: (id, port) =>
      safe(id, async () => {
        const preview = await (
          await sandbox(id)
        ).previews.create({
          port,
          name: `port-${port}`,
          createIfNotExists: true,
          public: true,
        });

        return { url: preview.url };
      }),
    native(id) {
      const box = boxes.get(id);

      if (!box) throw failure("Connect the sandbox first", "not_found", id);

      if (!current) throw failure("Client is detached", "not_found", id);

      return { sandbox: box, client: current };
    },
  };

  return provider;
}
