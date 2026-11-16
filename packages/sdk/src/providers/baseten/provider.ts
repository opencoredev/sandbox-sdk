/** Verified against @basetenlabs/sandbox 0.5.0 (https://github.com/basetenlabs/baseten-js). */
import { createHash } from "node:crypto";
import type {
  Sandbox,
  SandboxClient,
  SandboxClientOptions,
  SandboxCreateRequest,
  SandboxInfo as BasetenInfo,
  SandboxLifecycle,
} from "@basetenlabs/sandbox";
import type { CreateInput, Labels, Provider, SandboxInfo } from "../../provider.js";
import { loadPeer } from "../../peer.js";
import { files, python, type Guest } from "../../shared/guest.js";
import { isString } from "../../shared/narrow.js";
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
  /** How long create waits for a sandbox to deploy. Default: 120 s. */
  readyTimeoutMs?: number;
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

  /** A sandbox's previews, through the control plane only, so a record without an execution URL works too. */
  async function previewsOf(c: SandboxClient, id: string) {
    const known = boxes.get(id);

    if (known) return known.previews;
    const info = await c.getInfo({ name: id });

    // Previews never use the execution URL; a pending record has none yet.
    return (await c.get({ info: { ...info, url: info.url ?? "https://pending.invalid" } }))
      .previews;
  }

  async function api() {
    return (client ??= (async () => {
      const apiKey = options.apiKey ?? process.env.BASETEN_API_KEY;

      if (!apiKey?.trim())
        throw failure(
          "Baseten API key is missing. Authentication is required. Set BASETEN_API_KEY or pass apiKey.",
          "auth",
        );
      const { SandboxClient } = await loadPeer("@basetenlabs/sandbox", "baseten", load);

      return (current = new SandboxClient({ apiKey, teamId: options.teamId }));
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
    const info = await c.getInfo({ name: id });

    if (!toInfo(info)) throw failure("Sandbox not found", "not_found", id);
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
        const memory = memoryFor(input.size);

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        const c = await api();

        const attempt = crypto.randomUUID();

        const request: SandboxCreateRequest = {
          name: input.key === undefined ? `${prefix}${crypto.randomUUID()}` : keyedName(input.key),
          image: options.image,
          memory,
          region: options.region,
          envs: Object.fromEntries(
            Object.entries(input.env ?? {}).map(([name, value]) => [name, { value, secret: true }]),
          ),
          labels: { ...input.labels, [attemptLabel]: attempt },
          externalId: input.key,
          lifecycle: lifecycle(input),
          callOptions: { signal: input.signal },
        };

        let created;

        try {
          created = await c.create(request);
        } catch (error) {
          const mapped = basetenError(error);

          // Only an HTTP rejection proves Baseten made nothing. Any other failure may follow an
          // accepted create: a lost or aborted response, or the SDK throwing on the response
          // itself (0.5.0 throws when it has no URL yet). Delete the sandbox under this name only
          // when it carries this attempt's ID: absence, or another attempt's sandbox, settles
          // that this one made nothing.
          if (rejected(error) === undefined || ["unavailable", "timeout"].includes(mapped.code)) {
            const name = request.name ?? "";

            // Only an explicit other marker proves another attempt made it: labels can be
            // replaced wholesale by update(), so a missing marker leaves the outcome unknown.
            const cleaned = await c.getInfo({ name }).then(
              (found) => {
                const marker = found.labels[attemptLabel];

                if (marker === undefined) return false;

                if (marker !== attempt) return true;

                return c.delete({ name }).then(
                  () => true,
                  (cause: unknown) => basetenError(cause).code === "not_found",
                );
              },
              (cause: unknown) => basetenError(cause).code === "not_found",
            );

            if (!cleaned)
              throw failure(
                `Sandbox creation outcome is unknown; delete ${request.name ?? "it"} if it exists before retrying`,
                "outcome_unknown",
              );

            if (mapped.code === "aborted") throw failure("Creation aborted", "aborted");
          }

          throw mapped;
        }

        try {
          const info = await ready(c, created.info);
          boxes.set(info.name, info === created.info ? created : await c.get({ info }));
          const value = toInfo(info);

          if (!value) throw failure("Created sandbox is not usable", "provider", info.name);

          return value;
        } catch (error) {
          boxes.delete(created.name);

          // The sandbox exists and is billed: settle the failure only once it is gone.
          const cleaned = await c.delete({ name: created.name }).then(
            () => true,
            (cause: unknown) => basetenError(cause).code === "not_found",
          );

          if (!cleaned)
            throw failure(
              `Sandbox ${created.name} did not become usable and could not be deleted; delete it before retrying`,
              "outcome_unknown",
              created.name,
            );
          throw basetenError(error, created.name);
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
