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
import { boxdError, failure, type BoxdCall } from "./errors.js";
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

/** A suspended or hibernated SDK machine whose labels are only in its guest, so `list()` leaves it out. */
export interface BoxdSleepingMachine {
  id: string;
  name: string;
  state: "paused" | "stopped";
  createdAt: number | null;
}

export interface BoxdExtras {
  /**
   * The sleeping SDK machines `list()` leaves out, read from boxd's machine list only, so none is
   * woken. `connect(id)` reads one's labels and key, which wakes it.
   */
  listSleeping(): Promise<BoxdSleepingMachine[]>;
}

export type BoxdProvider = Provider<BoxdNative, BoxdCapability> & BoxdExtras;

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

/** Keyless machines with only the SDK's own label are named `sbxsdk-v2-<0|1>-<createdAt base 36>-<uuid>`. */
function isNameOwned(name: string): boolean {
  const parts = name.split("-");

  return parts[1] === "v2" && ["0", "1"].includes(parts[2] ?? "");
}

/** The marker a v2 name stands for, or null for an older name, whose metadata is only in the guest. */
function nameMetadata(m: Pick<Machine, "id" | "name">): string | null {
  if (!isNameOwned(m.name)) return null;
  const parts = m.name.split("-");
  const createdAt = Number.parseInt(parts[3] ?? "", 36);

  if (!Number.isFinite(createdAt) || createdAt <= 0)
    throw failure("Invalid SDK metadata", "not_found", m.id);

  return JSON.stringify({
    key: null,
    labels: parts[2] === "1" ? { "sandbox-sdk": "1" } : {},
    createdAt,
  });
}

/** Whether reading the machine's metadata would wake it: it sleeps, and its name doesn't carry it. */
function wakes(m: Pick<Machine, "name" | "status">): boolean {
  return m.status !== "running" && !isNameOwned(m.name);
}

function sleepState(status: Machine["status"]): BoxdSleepingMachine["state"] {
  return ["suspended", "hibernated"].includes(status) ? "paused" : "stopped";
}

function machineState(status: Machine["status"]): SandboxInfo["state"] {
  return status === "running" ? "running" : sleepState(status);
}

function missing(id: string): never {
  throw failure("SDK metadata is missing", "not_found", id);
}

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
): Provider<{ machine: Machine; client: C }, BoxdCapability> & BoxdExtras {
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
      throw boxdError(error, { sandboxId: id }, [options.apiKey]);
    }
  }

  /** Runs one boxd control-plane call, so a failure names the call and keeps boxd's status and message. */
  async function control<T>(
    context: { call: BoxdCall; sandboxId?: string; machineId?: string },
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw boxdError(error, context, [options.apiKey]);
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

  /**
   * Reading the guest marker of a machine that isn't running wakes it, and boxd bills the woken
   * machine. A v2 name carries all of its metadata, so a v2 machine is never read, in any state,
   * and a machine that falls asleep mid-listing can't be woken by it. Any other machine is read
   * from its guest, which wakes it if it sleeps: callers that must not wake one check `wakes` first,
   * though one that falls asleep between boxd's listing and the read is still woken. Only `attach`
   * (connecting to use it) queues the guest preparation, so listing keeps no per-machine state.
   */
  async function info(m: Machine, { attach }: { attach: boolean }): Promise<SandboxInfo> {
    if (!m.name.startsWith("sbxsdk-")) throw failure("Not an SDK machine", "not_found", m.id);
    const named = () => nameMetadata(m) ?? missing(m.id);
    let text: string;
    let deferred = false;

    if (isNameOwned(m.name)) {
      text = named();
      deferred = true;
    } else {
      try {
        text = new TextDecoder().decode(await (await fileApi()).download(m.id, marker));
      } catch (error) {
        if (!["not_found", "file_not_found"].includes(boxdError(error).code)) throw error;
        text = named();
        deferred = true;
      }
    }

    const invalid: (part: MetadataPart) => never = (part) => {
      throw failure(`Invalid SDK ${part}`, "not_found", m.id);
    };

    const value = parseMetadata(text, invalid);
    // The marker always stores its key (null for none) and creation time.
    const createdAt = value.createdAt ?? invalid("metadata");

    if (value.key === undefined) invalid("metadata");

    if (attach && deferred && !pending.has(m.id)) pending.set(m.id, preparation(text));

    return {
      id: m.id,
      key: value.key ?? undefined,
      labels: value.labels,
      createdAt: m.createdAt?.getTime() ?? createdAt,
      state: machineState(m.status),
    };
  }

  /** A machine's info, or null when it isn't a readable SDK machine (corrupt or vanished marker). */
  async function readable(m: Machine) {
    try {
      return await info(m, { attach: false });
    } catch (error) {
      if (boxdError(error).code !== "not_found") throw error;

      return null;
    }
  }

  /** Every SDK machine read without waking any, and apart, those that can't be. */
  async function scan(): Promise<{ known: SandboxInfo[]; asleep: Machine[] }> {
    try {
      const known: SandboxInfo[] = [];
      const asleep: Machine[] = [];

      for (const m of await (await api()).machines.list()) {
        if (!m.name.startsWith("sbxsdk-") || m.status === "destroyed") continue;

        if (wakes(m)) {
          asleep.push(m);
          continue;
        }

        const v = await readable(m);

        if (v !== null) known.push(v);
      }

      return { known, asleep };
    } finally {
      // A listing-only adapter has no handle that will later call close().
      if (!boxes.size) await webClient?.releaseIdle();
    }
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
          const mapped = boxdError(error, { call: "machines.create" }, [options.apiKey]);

          if (mapped.code === "unavailable" || mapped.code === "timeout")
            throw failure(
              "Machine creation outcome is unknown; inspect the account before retrying",
              "outcome_unknown",
              undefined,
              mapped.cause,
            );
          throw mapped;
        }

        try {
          if (input.signal?.aborted) throw failure("Creation aborted", "aborted");

          const created = m;

          if (created.status !== "running")
            m = await control({ call: "machines.waitUntilReady", machineId: created.id }, () =>
              c.machines.waitUntilReady(created.id, {
                timeout: options.requestTimeoutMs ?? 90000,
              }),
            );

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

          // Confirmed before return, so no user command runs under a wider list.
          if (allow) {
            const actual = await control({ call: "machines.setEgressAllow", machineId: id }, () =>
              c.machines.setEgressAllow(id, allow),
            );

            if (actual.length !== allow.length || allow.some((entry) => !actual.includes(entry)))
              throw failure(
                "boxd did not confirm the requested egress allow-list",
                "unsupported",
                id,
              );
          }

          // Labels, keys and restores live only in the guest file, which makes the machine findable:
          // write it before another client can look, and only once any allow-list is confirmed.
          if (!nativeOwnership) await (await guest(id)).raw("true");

          return value;
        } catch (error) {
          // The failed machine is not this client's, whether or not the delete goes through.
          try {
            await c.machines.delete(m.id);
          } finally {
            boxes.delete(m.id);
            pending.delete(m.id);
            await webClient?.closeMachine(m.id);

            if (!boxes.size) await webClient?.releaseIdle();
          }

          throw error;
        }
      }),
    // Listing never wakes a machine: a suspended or hibernated one whose labels live only in its
    // guest (keyed, custom-labelled or restored) is left out until it runs again.
    list: (labels) =>
      safe(undefined, async () =>
        (await scan()).known.filter((v) =>
          Object.entries(labels).every(([k, vv]) => v.labels[k] === vv),
        ),
      ),
    // A key lives only in the guest, so a paused machine is read (and woken) only when no machine
    // that can be read without waking has the key, and the search stops at the first match.
    find: (key) =>
      safe(undefined, async () => {
        const { known, asleep } = await scan();
        let found = known.find((v) => v.key === key);

        try {
          for (const m of asleep) {
            if (found) break;
            const v = await readable(m);

            if (v?.key === key) found = v;
          }
        } finally {
          if (!boxes.size) await webClient?.releaseIdle();
        }

        return found ? provider.connect(found.id) : undefined;
      }),
    connect: (id) =>
      safe(id, async () => {
        try {
          const c = await api();

          const m = await control({ call: "machines.get", sandboxId: id }, () =>
            c.machines.get(id),
          );

          // Connecting is for use, so a paused machine may be woken to read its metadata.
          const value = await info(m, { attach: true });
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
          const mapped = boxdError(error, { call: "machines.delete", sandboxId: id }, [
            options.apiKey,
          ]);

          if (mapped.code !== "not_found") throw mapped;
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
        const c = await api();
        await control({ call: "machines.pause", sandboxId: id }, () => c.machines.pause(id));
      }),
    resume: (id) =>
      safe(id, async () => {
        const c = await api();
        await control({ call: "machines.resume", sandboxId: id }, () => c.machines.resume(id));
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
          await control({ call: "snapshots.create", sandboxId: id }, () =>
            c.snapshots.create(id, name),
          );

          while (Date.now() < deadline) {
            const snapshot = await control({ call: "snapshots.get", sandboxId: id }, () =>
              c.snapshots.get(name),
            );

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
            const cleanup = boxdError(cleanupError, { call: "snapshots.delete", sandboxId: id }, [
              options.apiKey,
            ]);

            if (cleanup.code !== "not_found")
              throw failure(
                `Snapshot ${name} cleanup is unconfirmed after ${boxdError(error, { sandboxId: id }).code}; inspect and remove it before retrying`,
                "outcome_unknown",
                id,
                cleanup.cause,
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

  // boxd's machine list only, never a guest, so no machine is woken even if it falls asleep now.
  const listSleeping = () =>
    safe(undefined, async () =>
      (await control({ call: "machines.list" }, async () => (await api()).machines.list()))
        .filter((m) => m.name.startsWith("sbxsdk-") && m.status !== "destroyed" && wakes(m))
        .map((m) => ({
          id: m.id,
          name: m.name,
          state: sleepState(m.status),
          createdAt: m.createdAt?.getTime() ?? null,
        })),
    );

  return Object.assign(provider, { listSleeping });
}
