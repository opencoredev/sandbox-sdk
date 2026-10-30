/** Verified against @boxd-sh/sdk 0.2.17 and https://docs.boxd.sh/reference/typescript-sdk. */
import type {
  Boxd,
  BoxdOptions as BoxdClientOptions,
  CreatedSnapshot,
  ExecBytesResult,
  ExecParams,
  ExecResult,
  ExecStream,
  Machine,
  MachineConfig,
  Machines,
  MachineCreateParams,
  Proxy,
  Snapshot,
  StreamExecParams,
  WaitUntilReadyParams,
} from "@boxd-sh/sdk";
import type { CreateInput, Provider, SandboxInfo } from "../../provider.js";
import { loadPeer } from "../../peer.js";
import { boxdError, failure } from "./errors.js";
import { files, python, type Guest } from "../../shared/guest.js";
import { isString } from "../../shared/narrow.js";
import { quote } from "../../shared/shell.js";
import { execute } from "./execute.js";
import type { FileTransfers } from "./transfers.js";
import { parseMetadata, type MetadataPart } from "../../shared/metadata.js";

// Writes base64 stdin to argv[1], creating its parent directory.
const uploadFile =
  "import os,sys,base64; os.makedirs(os.path.dirname(sys.argv[1]),exist_ok=True); f=open(sys.argv[1],'wb'); f.write(base64.b64decode(sys.stdin.buffer.read())); f.close()";

// Writes argv[3] bytes of argv[1] from offset argv[2] to stdout.
const readRange =
  "import sys; f=open(sys.argv[1],'rb'); f.seek(int(sys.argv[2])); sys.stdout.buffer.write(f.read(int(sys.argv[3])))";

export interface BoxdOptions {
  /** Defaults to BOXD_API_KEY; required on first use. */
  apiKey?: string;
  /** Defaults to BOXD_BASE_URL, then BOXD_API_URL, then https://boxd.sh:9443. */
  baseUrl?: string;
  /** @deprecated Use baseUrl. Removed in 1.0.0. */
  baseURL?: string;
  /** Container image. Defaults to the boxd service image. */
  image?: string;
  /** Default: 30 s for control calls (including create); readiness: 90 s. */
  requestTimeoutMs?: number;
  /** Cancels file transfers; default: no adapter-wide cancellation. */
  fileTransferSignal?: AbortSignal;
  /** Persistent boxd disks to attach to new machines (not restores). Default: none. */
  volumes?: { diskId: string; mountPath: string; readOnly?: boolean }[];
}

export interface BoxdNative {
  machine: Machine;
  client: Boxd;
}

type BoxdCapability = "pause" | "size" | "snapshot" | "network-policy";

export type BoxdProvider = Provider<BoxdNative, BoxdCapability>;

/** The parts of a boxd client the adapter uses. */
export interface BoxdClient {
  machines: {
    create(params: MachineCreateParams): Promise<Machine>;
    get(id: string): Promise<Machine>;
    list(): Promise<Machine[]>;
    delete(id: string): Promise<void>;
    waitUntilReady(id: string, params: WaitUntilReadyParams): Promise<Machine>;
    exec(
      id: string,
      params: ExecParams & { encoding: "buffer" },
    ): Promise<Pick<ExecBytesResult, "stdout" | "exitCode">>;
    exec(id: string, params: ExecParams): Promise<Pick<ExecResult, "stdout" | "exitCode">>;
    streamExec(id: string, params: StreamExecParams): ExecStream;
    setEgressAllow(id: string, entries: string[]): Promise<string[]>;
    setBotProtection(id: string, mode: "off"): Promise<void>;
    pause: Machines["pause"];
    resume: Machines["resume"];
    proxies: {
      list(machine: string): Promise<Pick<Proxy, "domain" | "isDefault">[]>;
      setPort(machine: string, port: number): Promise<void>;
    };
  };
  snapshots: {
    create(machine: string, name: string): Promise<Pick<CreatedSnapshot, "status">>;
    get(name: string): Promise<Pick<Snapshot, "status">>;
    delete(name: string): Promise<void>;
  };
}

/** The parts of the boxd SDK the adapter uses: the real `@boxd-sh/sdk` module, or a test fixture. */
export interface BoxdModule<C extends BoxdClient> {
  Boxd: new (options: BoxdClientOptions) => C;
}

/** Whole-file transfers, which run off the main thread in production. */
export type BoxdTransfers = Pick<
  FileTransfers,
  "upload" | "download" | "closeMachine" | "releaseIdle"
>;

/** Opens the file transfer client for one provider. */
export type OpenTransfers = (options: BoxdClientOptions, signal?: AbortSignal) => BoxdTransfers;

const marker = "/var/lib/sandbox-sdk/metadata.json";

// Each class has fixed 100 GB disk and 4 GiB memory per vCPU.
function vcpuFor(size: CreateInput["size"]): number | undefined {
  if (size === undefined) return undefined;

  if (isString(size)) return { small: 1, medium: 2, large: 4 }[size];

  if (![1, 2, 4, 8].includes(size.cpu))
    throw failure(
      "boxd sizes are 1 vCPU / 4 GiB, 2 / 8, 4 / 16, or 8 / 32, each with 100 GB disk",
      "unsupported",
    );

  if (size.memoryMb !== size.cpu * 4096 || (size.diskGb ?? 100) !== 100)
    throw failure(
      `boxd gives ${size.cpu} vCPU / ${size.cpu * 4} GiB memory / 100 GB disk; CPU and memory cannot be selected independently`,
      "unsupported",
    );

  return size.cpu;
}

function seconds(value: number | undefined, label: string) {
  if (value === undefined) return undefined;

  if (!Number.isSafeInteger(value) || value <= 0)
    throw failure(`${label} must be a positive integer of milliseconds`, "invalid_argument");

  return Math.ceil(value / 1000);
}

/** boxd egress is an allow-list; an empty list means unrestricted, so "none" cannot be expressed. */
function egress(network: CreateInput["network"]): string[] | undefined {
  if (network === undefined || network === "all") return undefined;

  if (network === "none" || !network.allow.length)
    throw failure(
      "boxd cannot block all egress (an empty allow-list means unrestricted); pass network: { allow: [...] } with at least one entry",
      "unsupported",
    );

  for (const entry of network.allow)
    if (
      !/^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|(\*\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)$/.test(
        entry,
      )
    )
      throw failure(
        "Network allow entries must be hostnames, *.wildcards, or public IPv4 addresses and CIDRs",
        "unsupported",
      );

  return [...new Set(network.allow)];
}

/** @internal The adapter behind `boxd()`. `load` imports the boxd SDK and `openTransfers`
 * starts the file transfer client; tests pass local fixtures for both.
 */
export function createBoxdProvider<C extends BoxdClient>(
  options: BoxdOptions,
  load: () => Promise<BoxdModule<C>>,
  openTransfers: OpenTransfers,
): Provider<{ machine: Machine; client: C }, BoxdCapability> {
  let client: Promise<C> | undefined;
  let current: C | undefined;
  let webClient: BoxdTransfers | undefined;
  const boxes = new Map<string, Machine>();

  async function api() {
    return (client ??= (async () => {
      if (
        options.requestTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
      )
        throw failure("requestTimeoutMs must be a positive integer", "invalid_argument");
      const apiKey = options.apiKey ?? process.env.BOXD_API_KEY;

      if (!apiKey?.trim())
        throw failure(
          "boxd API key is missing. Authentication is required. Set BOXD_API_KEY or pass apiKey.",
          "auth",
        );
      const { Boxd } = await loadPeer("@boxd-sh/sdk", "boxd", load);

      return (current = new Boxd({
        apiKey,
        baseURL: options.baseUrl ?? options.baseURL,
        timeout: options.requestTimeoutMs ?? 30000,
        maxRetries: 0,
      }));
    })());
  }

  async function fileApi() {
    await api();

    return (webClient ??= openTransfers(
      {
        apiKey: options.apiKey ?? process.env.BOXD_API_KEY,
        baseURL: options.baseUrl ?? options.baseURL,
        timeout: options.requestTimeoutMs ?? 30000,
        maxRetries: 0,
      },
      options.fileTransferSignal,
    ));
  }

  async function safe<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw boxdError(error, id);
    }
  }

  const pending = new Map<string, string>();

  function preparation(metadata: string) {
    return (
      'if ! mkdir -p /workspace /var/lib/sandbox-sdk 2>/dev/null || [ ! -w /workspace ] || [ ! -w /var/lib/sandbox-sdk ]; then sudo -n install -d -o "$(id -u)" -g "$(id -g)" /workspace /var/lib/sandbox-sdk; fi && test -w /workspace && test -w /var/lib/sandbox-sdk && mkdir -p /tmp/.sandbox-sdk && ' +
      `printf %s ${quote(metadata)} > ${quote(marker)} && `
    );
  }

  function setup(id: string) {
    return pending.get(id) ?? "";
  }

  async function guest(id: string): Promise<Guest> {
    const c = await api();

    return {
      name: "boxd",
      raw: async (command) => {
        const prefix = setup(id);
        const ack = "SDK_PREPARED:";

        const r = await c.machines.exec(id, {
          command: prefix ? prefix + `printf %s ${quote(ack)} && ` + command : command,
          timeout: options.requestTimeoutMs ?? 30000,
        });

        const prepared = prefix && r.stdout.startsWith(ack);

        if (prepared) pending.delete(id);

        if (r.exitCode !== 0) throw failure("Guest operation failed", "provider", id);

        return prepared ? r.stdout.slice(ack.length) : r.stdout;
      },
      upload: async (path, bytes) => {
        const prefix = setup(id);

        if (prefix) {
          const result = await execute(
            c,
            id,
            {
              command: python(uploadFile, path),
              cwd: "/",
              env: {},
              stdin: Buffer.from(bytes).toString("base64"),
              timeoutMs: options.requestTimeoutMs ?? 30000,
              onChunk() {},
            },
            prefix,
            () => pending.delete(id),
          );

          if (result.exitCode !== 0) throw failure("File upload failed", "provider", id);

          return;
        }

        if ((await (await fileApi()).upload(id, path, bytes)) !== bytes.length)
          throw failure("Incomplete file upload", "provider", id);
      },
      read: async (path, range) => {
        if (!range) return (await fileApi()).download(id, path);

        // Tail readers request a bounded range. Seek in the guest rather than
        // downloading a growing log in full for each page.
        const result = await c.machines.exec(id, {
          command: python(readRange, path, String(range.offset), String(range.length)),
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
    let text: string;
    let deferred = false;

    try {
      text = new TextDecoder().decode(await (await fileApi()).download(m.id, marker));
    } catch (error) {
      if (!["not_found", "file_not_found"].includes(boxdError(error).code)) throw error;
      const parts = m.name.split("-");

      if (parts[1] !== "v2" || !["0", "1"].includes(parts[2] ?? ""))
        throw failure("SDK metadata is missing", "not_found", m.id);
      const createdAt = Number.parseInt(parts[3] ?? "", 36);

      if (!Number.isFinite(createdAt) || createdAt <= 0)
        throw failure("Invalid SDK metadata", "not_found", m.id);
      text = JSON.stringify({
        key: null,
        labels: parts[2] === "1" ? { "sandbox-sdk": "1" } : {},
        createdAt,
      });
      deferred = true;
    }

    const invalid: (part: MetadataPart) => never = (part) => {
      throw failure(`Invalid SDK ${part}`, "not_found", m.id);
    };

    const value = parseMetadata(text, invalid);
    // The marker always stores its key (null for none) and creation time.
    const createdAt = value.createdAt ?? invalid("metadata");

    if (value.key === undefined) invalid("metadata");

    if (deferred && !pending.has(m.id)) pending.set(m.id, preparation(text));

    return {
      id: m.id,
      key: value.key ?? undefined,
      labels: value.labels,
      createdAt: m.createdAt?.getTime() ?? createdAt,
      state:
        m.status === "running"
          ? "running"
          : ["suspended", "hibernated"].includes(m.status)
            ? "paused"
            : "stopped",
    };
  }

  const provider: Provider<{ machine: Machine; client: C }, BoxdCapability> = {
    name: "boxd",
    keyMode: "best-effort",
    inlineActivity: true,
    capabilities: new Set(["pause", "size", "snapshot", "network-policy"]),
    create: (input) =>
      safe(undefined, async () => {
        const allow = egress(input.network);
        const deleteAfter = seconds(input.timeoutMs, "timeoutMs");
        const autoSuspendTimeout = seconds(input.idleTimeoutMs, "idleTimeoutMs") ?? 0;

        if (input.from !== undefined && !input.from.trim())
          throw failure(
            "Snapshot restore requires a nonempty snapshot ID or name",
            "invalid_argument",
          );

        if (
          input.from !== undefined &&
          (input.size !== undefined ||
            Object.keys(input.env ?? {}).length > 0 ||
            options.image !== undefined ||
            options.volumes?.length)
        )
          throw failure(
            "boxd snapshot restore inherits size, image, volumes and environment; overrides are not supported",
            "unsupported",
          );
        const vcpu = vcpuFor(input.size);

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        const c = await api();
        const createdAt = Date.now();

        const metadata = JSON.stringify({
          key: input.key ?? null,
          labels: input.labels,
          createdAt,
        });

        const nativeOwnership =
          input.key === undefined &&
          Object.keys(input.labels).every(
            (key) => key === "sandbox-sdk" && input.labels[key] === "1",
          ) &&
          input.from === undefined;

        let m: Machine;

        try {
          const name = nativeOwnership
            ? `sbxsdk-v2-${input.labels["sandbox-sdk"] === "1" ? "1" : "0"}-${createdAt.toString(36)}-${crypto.randomUUID()}`
            : `sbxsdk-${crypto.randomUUID()}`;

          const config: MachineConfig =
            input.from !== undefined
              ? { autoSuspendTimeout }
              : { autoSuspendTimeout, autoDestroyTimeout: 0, vcpu };

          if (input.from === undefined && options.volumes?.length) config.volumes = options.volumes;

          const params: MachineCreateParams =
            input.from !== undefined
              ? { name, fromSnapshot: input.from, isolated: true, config }
              : { name, image: options.image, env: input.env, isolated: true, config };

          if (deleteAfter !== undefined) params.deleteAfter = deleteAfter;
          m = await c.machines.create(params);
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
          if (input.signal?.aborted) throw failure("Creation aborted", "aborted");

          if (m.status !== "running")
            m = await c.machines.waitUntilReady(m.id, {
              timeout: options.requestTimeoutMs ?? 90000,
            });

          const id = m.id;

          const value: SandboxInfo = {
            id,
            key: input.key,
            labels: input.labels,
            createdAt: m.createdAt?.getTime() ?? createdAt,
            state: "running",
          };

          pending.set(id, preparation(metadata));
          boxes.set(id, m);

          // Confirmed before return, so no user command runs under a wider list. The metadata write is a
          // fixed SDK command that opens no connection, so the two independent round trips overlap.
          const steps = await Promise.allSettled([
            allow &&
              c.machines.setEgressAllow(id, allow).then((actual) => {
                if (
                  actual.length !== allow.length ||
                  allow.some((entry) => !actual.includes(entry))
                )
                  throw failure(
                    "boxd did not confirm the requested egress allow-list",
                    "unsupported",
                    id,
                  );
              }),
            // Labels, keys and restores live only in the guest file; write it before another client can look.
            !nativeOwnership && guest(id).then((g) => g.raw("true")),
          ]);

          for (const step of steps) if (step.status === "rejected") throw step.reason;

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
        pending.delete(id);
        await webClient?.closeMachine(id);

        if (!boxes.size) await webClient?.releaseIdle();
      }),
    async close(id) {
      boxes.delete(id);
      await webClient?.closeMachine(id);

      if (!boxes.size) await webClient?.releaseIdle();
    },
    exec: (id, input) =>
      safe(id, async () => {
        const prefix = setup(id);
        const result = await execute(await api(), id, input, prefix, () => pending.delete(id));

        return result;
      }),
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
    snapshot: (id, snapshotOptions) =>
      safe(id, async () => {
        if (snapshotOptions?.expiresInMs)
          throw failure(
            "boxd keeps snapshots until they are deleted; omit expiresInMs",
            "unsupported",
            id,
          );
        const c = await api();
        const name = `sbxsdk-${crypto.randomUUID()}`;
        const deadline = Date.now() + (options.requestTimeoutMs ?? 90000);

        try {
          await c.snapshots.create(id, name);

          while (Date.now() < deadline) {
            const snapshot = await c.snapshots.get(name);

            if (snapshot.status === "ready") return { id: name };

            if (snapshot.status === "failed")
              throw failure("boxd snapshot capture failed", "provider", id);
            await new Promise((resolve) => setTimeout(resolve, 250));
          }

          throw failure("boxd snapshot did not become ready", "timeout", id);
        } catch (error) {
          // The API has no core snapshot-delete hook. Remove failed captures here
          // so retries cannot leave untracked, billable artifacts behind.
          try {
            await c.snapshots.delete(name);
          } catch (cleanupError) {
            if (boxdError(cleanupError, id).code !== "not_found")
              throw failure(
                `Snapshot ${name} cleanup is unconfirmed after ${boxdError(error, id).code}; inspect and remove it before retrying`,
                "outcome_unknown",
                id,
              );
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
