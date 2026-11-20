/** Verified against @beamcloud/beam-js 1.1.6 and Beam's gateway on 2026-11-18. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createNativeApi, type NativeApi } from "../../native.js";
import type { CreateInput, Labels, Provider, SandboxInfo } from "../../provider.js";
import { files, python, type Guest } from "../../shared/guest.js";
import { isNumber, isObject, isString, isStringRecord } from "../../shared/narrow.js";
import { quote } from "../../shared/shell.js";
import {
  createGateway,
  createGatewayClient,
  type BeamContainer,
  type BeamGateway,
  type BeamPlane,
} from "./api.js";
import { beamError, failure, maybeSent } from "./errors.js";
import { execute, rangeCommand, type BeamGuest } from "./execute.js";

export interface BeamOptions {
  /** Defaults to BEAM_TOKEN. */
  token?: string;
  /** Defaults to BEAM_WORKSPACE_ID. */
  workspaceId?: string;
  /** Registry image for fresh sandboxes. Default: `node:22-bookworm`. */
  image?: string;
  /**
   * Lifetime in seconds when a create gives no `timeoutMs`. Beam stops a sandbox when it runs out,
   * counted from creation. Default: 3600. Beam's own default, 60 s, is too short to use.
   */
  keepWarmSeconds?: number;
  /** Gateway URL. Default: `https://app.beam.cloud`. */
  gatewayUrl?: string;
  /**
   * Per gateway request, retries included. Default: 30 s. beam-js's own create requests follow it
   * too, except image builds, which beam-js gives 10 minutes. beam-js keeps one client per process,
   * made with the timeout of the provider whose create first uses it; a client that code using
   * beam-js directly made first keeps that code's timeout.
   */
  requestTimeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

export type { BeamPlane } from "./api.js";

/**
 * `box.native`: Beam's gateway with this adapter's token, bound to the container (the
 * `{containerId}` placeholder fills itself), and the container's IDs.
 */
export interface BeamNative extends NativeApi<BeamPlane> {
  containerId: string;
  stubId: string;
}

type BeamCapability = "size" | "snapshot";

export type BeamProvider = Provider<BeamNative, BeamCapability>;

/** A sandbox Beam made: its container, and the stub (prepared configuration) it runs. */
export interface BeamMade {
  containerId: string;
  stubId: string;
}

/**
 * One sandbox configuration. Beam prepares its stub on the first create and reuses it after.
 * `create` returns once Beam allocated the container, without waiting for it to accept commands,
 * so the adapter holds its ID before anything else can fail.
 */
export interface BeamTemplate {
  create(): Promise<BeamMade>;
}

export interface BeamTemplateConfig {
  cpu: number;
  memoryMb: number;
  image: string;
  keepWarmSeconds: number;
}

/** What the adapter needs from `@beamcloud/beam-js` (see index.ts), or a test fixture. */
export interface BeamModule {
  /**
   * Sets beam-js's one global configuration, read when its HTTP client is first made, after
   * checking it was not set up for another account. Called before every fresh create.
   */
  configure(settings: {
    token: string;
    workspaceId: string;
    gatewayUrl: string;
    requestTimeoutMs: number;
  }): void;
  template(config: BeamTemplateConfig): BeamTemplate;
}

const defaultImage = "node:22-bookworm";

// Beam's TypeScript SDK defaults (1 CPU, 128 MiB), which `nproc` and the cgroup confirm.
interface BeamSize {
  cpu: number;
  memoryMb: number;
}

const defaultSize: BeamSize = { cpu: 1, memoryMb: 128 };

const presets = {
  small: { cpu: 1, memoryMb: 2048 },
  medium: { cpu: 2, memoryMb: 4096 },
  large: { cpu: 4, memoryMb: 8192 },
} satisfies Record<string, BeamSize>;

function sizeOf(size: CreateInput["size"]): BeamSize {
  if (size === undefined) return defaultSize;

  if (isString(size)) return presets[size];

  if (size.diskGb !== undefined)
    throw failure("Beam sandboxes have no disk size option", "unsupported");

  if (!Number.isInteger(size.cpu) || size.cpu < 1 || !Number.isInteger(size.memoryMb))
    throw failure("Beam sizes take whole vCPUs and whole MiB", "unsupported");

  return { cpu: size.cpu, memoryMb: size.memoryMb };
}

/**
 * Beam keeps no labels or names on a container, so the adapter writes them into the sandbox at
 * create: `{ key, labels }`. A container without the file is not the SDK's.
 */
const markerPath = "/var/lib/sandbox-sdk/beam.json";
const envFile = "/var/lib/sandbox-sdk-env.json";

interface Marker {
  key?: string;
  labels: Labels;
  createdAt: number;
}

function parseMarker(bytes: Uint8Array): Marker | undefined {
  let value: unknown;

  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }

  if (!isObject(value) || !("labels" in value) || !isStringRecord(value.labels)) return undefined;
  const key = "key" in value && isString(value.key) ? value.key : undefined;

  const createdAt = "createdAt" in value && isNumber(value.createdAt) ? value.createdAt : 0;

  return { key, labels: { ...value.labels }, createdAt };
}

// Container statuses that still hold a sandbox; STOPPED, ERROR, TIMEOUT and COMPLETE do not.
const live = new Set(["PENDING", "RUNNING"]);

// `sandbox-<stub UUID>-<suffix>`, as Beam names sandbox containers.
const containerPattern =
  /^sandbox-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9a-f]+$/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Beam's gateway refuses (HTTP 429) an upload of 10 MiB (8 MiB passes) and a download of 4 MiB or
// more: the download travels as one gRPC message, capped at 4 MiB (measured 2026-11-18). Larger
// files move in pieces of these sizes.
const uploadPieceBytes = 4 * 1024 * 1024;
const downloadPieceBytes = 3 * 1024 * 1024;

// Prints the size of argv[1].
const sizeProgram = "import os,sys; print(os.path.getsize(sys.argv[1]))";

// Copies argv[4] bytes of argv[1] from offset argv[3] into a new file argv[2], making its directory.
const pieceProgram =
  "import os,sys; os.makedirs(os.path.dirname(sys.argv[2]),exist_ok=True); f=open(sys.argv[1],'rb'); f.seek(int(sys.argv[3])); open(sys.argv[2],'wb').write(f.read(int(sys.argv[4])))";

/** @internal The guest command that copies one piece of a file aside for download. */
export const pieceCommand = (path: string, piece: string, offset: number, length: number) =>
  python(pieceProgram, path, piece, String(offset), String(length));

/**
 * `@beamcloud/beam-js` prints build and create progress with console.log and logs raw HTTP errors,
 * which carry the request's Authorization header, with console.error. While a create runs, console
 * calls made inside it are filtered: log and info are dropped, and warn and error pass only text
 * with the token removed (an error object becomes its name). Calls from anywhere else in the
 * process pass through unchanged.
 *
 * Every copy of the SDK in the process (an ESM and a CommonJS build, two versions) shares one
 * filter, counted, so overlapping creates install it once and remove it once. On removal, a method
 * someone replaced in the meantime is left as they set it. Such a replacement is not filtered: a
 * console method replaced while a create runs gets beam-js's output from then on unchanged.
 */
interface QuietConsole {
  depth: number;
  inCreate: AsyncLocalStorage<true>;
  secrets: Set<string>;
  /** While installed: the methods it replaced, and its own. */
  installed?: { saved: ConsoleMethods; wrappers: ConsoleMethods };
}

type ConsoleMethods = Pick<typeof console, "log" | "info" | "warn" | "error">;

const consoleMethods = ["log", "info", "warn", "error"] as const;

const quietKey = Symbol.for("@opencoredev/sandbox-sdk/beam-quiet-console/1");

function isQuietConsole(value: unknown): value is QuietConsole {
  return (
    isObject(value) &&
    "depth" in value &&
    isNumber(value.depth) &&
    "inCreate" in value &&
    value.inCreate instanceof AsyncLocalStorage &&
    "secrets" in value &&
    value.secrets instanceof Set
  );
}

function quietConsole(): QuietConsole {
  // Every copy of the SDK uses this versioned key for this shape; it is still checked before use.
  const holder: Record<symbol, QuietConsole | undefined> = globalThis;
  const existing = holder[quietKey];

  if (isQuietConsole(existing)) return existing;
  const made: QuietConsole = { depth: 0, inCreate: new AsyncLocalStorage(), secrets: new Set() };

  holder[quietKey] = made;

  return made;
}

function scrubbed(secrets: Set<string>, args: unknown[]): string[] {
  // One pass, longest first, so no secret is replaced inside another's replacement.
  const list = [...secrets].sort((a, b) => b.length - a.length);

  const pattern = new RegExp(
    list.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );

  return args.map((arg) => {
    if (!isString(arg)) return arg instanceof Error ? `[${arg.name}]` : "[omitted]";

    return list.length ? arg.replace(pattern, "[redacted]") : arg;
  });
}

async function silently<T>(token: string, action: () => Promise<T>): Promise<T> {
  const quiet = quietConsole();
  const { inCreate } = quiet;

  // Real tokens are long; a short one would only mangle unrelated text.
  if (token.length >= 8) quiet.secrets.add(token);

  if (quiet.depth++ === 0) {
    const saved: ConsoleMethods = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };

    const wrappers: ConsoleMethods = {
      log: (...args: unknown[]) => {
        if (!inCreate.getStore()) saved.log(...args);
      },
      info: (...args: unknown[]) => {
        if (!inCreate.getStore()) saved.info(...args);
      },
      warn: (...args: unknown[]) =>
        inCreate.getStore() ? saved.warn(...scrubbed(quiet.secrets, args)) : saved.warn(...args),
      error: (...args: unknown[]) =>
        inCreate.getStore() ? saved.error(...scrubbed(quiet.secrets, args)) : saved.error(...args),
    };

    quiet.installed = { saved, wrappers };
    Object.assign(console, wrappers);
  }

  try {
    return await inCreate.run(true, action);
  } finally {
    if (--quiet.depth === 0 && quiet.installed) {
      const { saved, wrappers } = quiet.installed;

      for (const name of consoleMethods)
        if (console[name] === wrappers[name]) console[name] = saved[name];
      quiet.installed = undefined;
    }
  }
}

/** @internal The adapter behind `beam()`. `load` imports the Beam SDK; tests pass a fixture. */
export function createBeamProvider(
  options: BeamOptions,
  load: () => Promise<BeamModule>,
): BeamProvider {
  const token = options.token ?? process.env.BEAM_TOKEN;
  const workspaceId = options.workspaceId ?? process.env.BEAM_WORKSPACE_ID;
  const gatewayUrl = options.gatewayUrl ?? "https://app.beam.cloud";

  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  let gateway: BeamGateway | undefined;
  let module: Promise<BeamModule> | undefined;
  /** One beam-js Sandbox per configuration, so its prepared stub is reused across creates. */
  const templates = new Map<string, BeamTemplate>();
  /** Stub IDs by container, from create or the container list. */
  const stubs = new Map<string, string>();

  function credentials() {
    if (!token?.trim())
      throw failure(
        "Beam token is missing. Authentication is required. Set BEAM_TOKEN or pass token.",
        "auth",
      );

    if (!workspaceId?.trim())
      throw failure(
        "Beam workspace ID is missing. Set BEAM_WORKSPACE_ID or pass workspaceId.",
        "auth",
      );

    return { token: token.trim(), workspaceId: workspaceId.trim() };
  }

  /** The gateway's transport, for the adapter and `box.native`: retries, error mapping, redaction. */
  const http = createGatewayClient({
    token: () => credentials().token,
    url: gatewayUrl,
    fetch: options.fetch,
    requestTimeoutMs,
  });

  function api(): BeamGateway {
    credentials();

    return (gateway ??= createGateway(http));
  }

  const natives = new Map<string, BeamNative>();

  /** beam-js. Its global configuration is checked in the same turn as each create (see create). */
  async function sdk(): Promise<BeamModule> {
    credentials();

    return (module ??= load());
  }

  async function safe<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw beamError(error, id);
    }
  }

  async function shell(id: string, script: string, timeoutMs: number, signal?: AbortSignal) {
    const g = api();
    const deadline = Date.now() + timeoutMs;
    const started = await g.exec(id, `sh -c ${quoteWord(script)}`, signal);

    if (started.done) {
      if (started.exitCode !== 0) throw failure("Guest operation failed", "provider", id);

      return started.stdout ?? "";
    }

    // The command runs now, so a read lost past the client's own retries is tried again until the
    // deadline; after it, the command's result is unknown rather than failed.
    async function follow<T>(read: () => Promise<T>): Promise<T> {
      for (;;) {
        try {
          return await read();
        } catch (error) {
          const code = beamError(error, id).code;

          if (signal?.aborted || (code !== "unavailable" && code !== "timeout")) throw error;

          if (Date.now() > deadline) {
            await g.kill(id, started.pid).catch(() => {});
            throw failure(
              "The command started but its result could not be read; check the sandbox's state before running it again",
              "outcome_unknown",
              id,
            );
          }

          await sleep(250);
        }
      }
    }

    for (;;) {
      if (signal?.aborted) throw failure("Command aborted", "aborted", id);

      if (Date.now() > deadline) {
        await g.kill(id, started.pid).catch(() => {});
        throw failure("Guest command timed out", "timeout", id);
      }

      const code = await follow(() => g.status(id, started.pid, signal));

      if (code >= 0) {
        if (code !== 0) throw failure("Guest operation failed", "provider", id);

        return follow(() => g.stdout(id, started.pid, signal));
      }

      await sleep(50);
    }
  }

  /** Reads a byte range through the guest, which also reads what the download route refuses. */
  async function readRange(
    id: string,
    path: string,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ) {
    let output: string;

    try {
      output = await shell(id, rangeCommand(path, range.offset, range.length), 120_000, signal);
    } catch (error) {
      if (beamError(error, id).code === "provider")
        throw failure("File does not exist", "file_not_found", id);
      throw error;
    }

    return new Uint8Array(Buffer.from(output, "base64"));
  }

  /** The guest the paged exec runs through. */
  function execGuest(id: string): BeamGuest {
    return {
      id,
      shell: (script, timeoutMs, signal) => shell(id, script, timeoutMs, signal),
      raw: (command) => shell(id, command, 120_000),
      upload: (path, bytes) => upload(id, path, bytes, 0o600),
      read: (path, range, signal) => readRange(id, path, range, signal),
    };
  }

  /** Uploads a file, in pieces joined in the guest when it is too large for one request. */
  async function upload(id: string, path: string, bytes: Uint8Array, mode: number) {
    if (bytes.length <= uploadPieceBytes) return api().upload(id, path, bytes, mode);

    const stem = `/tmp/.sandbox-sdk/up-${crypto.randomUUID()}`;
    const pieces: string[] = [];

    try {
      for (let offset = 0; offset < bytes.length; offset += uploadPieceBytes) {
        const piece = `${stem}.${pieces.length}`;

        pieces.push(piece);
        await api().upload(id, piece, bytes.subarray(offset, offset + uploadPieceBytes), 0o600);
      }

      await shell(
        id,
        `mkdir -p -- "$(dirname -- ${quote(path)})" && cat ${pieces.map(quote).join(" ")} >${quote(path)} && chmod ${mode.toString(8)} ${quote(path)}`,
        120_000,
      );
    } finally {
      await shell(id, `rm -f -- ${pieces.map(quote).join(" ")}`, 60_000).catch(() => {});
    }
  }

  /** Downloads a file, in pieces copied aside in the guest when it is too large for one response. */
  async function download(id: string, path: string): Promise<Uint8Array | undefined> {
    try {
      return await api().download(id, path);
    } catch (error) {
      if (beamError(error, id).code !== "quota") throw error;
    }

    const size = Number((await shell(id, python(sizeProgram, path), 60_000)).trim());
    const result = new Uint8Array(size);
    const piece = `/tmp/.sandbox-sdk/down-${crypto.randomUUID()}`;

    try {
      for (let offset = 0; offset < size; offset += downloadPieceBytes) {
        const length = Math.min(downloadPieceBytes, size - offset);

        await shell(id, pieceCommand(path, piece, offset, length), 60_000);

        const bytes = await api().download(id, piece);

        if (bytes?.length !== length)
          throw failure("File changed while it was read", "provider", id);
        result.set(bytes, offset);
      }
    } finally {
      await shell(id, `rm -f -- ${quote(piece)}`, 60_000).catch(() => {});
    }

    return result;
  }

  /** The guest the shared file operations run through. */
  function fileGuest(id: string): Guest {
    return {
      name: "beam",
      raw: (command) => shell(id, command, 120_000),
      upload: (path, bytes, mode) => upload(id, path, bytes, mode ?? 0o644),
      read: async (path, range) => {
        if (range) return readRange(id, path, range);
        const bytes = await download(id, path);

        if (bytes === undefined) throw failure("File does not exist", "file_not_found", id);

        return bytes;
      },
    };
  }

  async function container(id: string): Promise<BeamContainer | undefined> {
    const found = (await api().containers()).find((c) => c.containerId === id);

    if (found) stubs.set(id, found.stubId);

    return found && live.has(found.status) ? found : undefined;
  }

  async function infoOf(c: BeamContainer): Promise<SandboxInfo | undefined> {
    let bytes: Uint8Array | undefined;

    try {
      bytes = await api().download(c.containerId, markerPath);
    } catch (error) {
      // Stopped between the listing and this read.
      if (beamError(error, c.containerId).code === "not_found" || !(await alive(c.containerId)))
        return undefined;
      throw error;
    }

    const marker = bytes && parseMarker(bytes);

    if (!marker) return undefined;
    const started = Date.parse(c.startedAt ?? c.scheduledAt ?? "");

    return {
      id: c.containerId,
      key: marker.key,
      labels: marker.labels,
      state: "running",
      createdAt: marker.createdAt || (Number.isNaN(started) ? 0 : started),
    };
  }

  async function stubOf(id: string): Promise<string> {
    const known = stubs.get(id);

    if (known) return known;
    const fromName = containerPattern.exec(id)?.[1];

    if (fromName) return fromName;
    const found = await container(id);

    if (!found) throw failure("Sandbox not found", "not_found", id);

    return found.stubId;
  }

  /** Whether Beam still lists the container as pending or running. */
  async function alive(id: string) {
    return (await api().containers()).some((c) => c.containerId === id && live.has(c.status));
  }

  async function stop(id: string) {
    try {
      // Beam answers ok for a container that is already gone.
      await api().stop(id);
    } catch (error) {
      // It refuses a second stop while the first is still stopping the container.
      if (await alive(id)) throw error;
    }

    stubs.delete(id);
  }

  /**
   * After a create got a container but could not finish it: stop the container and keep the
   * original failure, or, when the stop is not confirmed, fail as outcome_unknown with its ID.
   */
  async function abandon(id: string, cause: unknown): Promise<never> {
    const confirmed = await stop(id).then(
      () => true,
      () => false,
    );

    if (!confirmed)
      throw failure(
        `Sandbox ${id} did not finish creating and could not be confirmed stopped; stop it before retrying`,
        "outcome_unknown",
        id,
      );
    throw beamError(cause, id);
  }

  const provider: BeamProvider = {
    name: "beam",
    keyMode: "best-effort",
    inlineActivity: true,
    capabilities: new Set(["size", "snapshot"]),
    create: (input) =>
      safe(undefined, async () => {
        if (input.network !== undefined && input.network !== "all")
          throw failure("Beam adapter has no network policy", "unsupported");

        if (input.idleTimeoutMs !== undefined)
          throw failure("Beam sandboxes have no idle timeout; use timeoutMs", "unsupported");

        // A restore runs at the snapshot's size; Beam takes no size for it.
        if (input.from !== undefined && input.size !== undefined)
          throw failure("Beam restores a snapshot at its own size", "unsupported");
        const size = sizeOf(input.size);

        const ttl =
          input.timeoutMs === undefined
            ? (options.keepWarmSeconds ?? 3600)
            : Math.max(1, Math.ceil(input.timeoutMs / 1000));

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        let made: BeamMade;

        try {
          // Not the caller's signal: once sent, the answer names the container to stop, so it is
          // read to the gateway's deadline even after an abort. An abort then stops it below.
          if (input.from !== undefined) made = await api().restore(input.from);
          else {
            const m = await sdk();
            const configKey = JSON.stringify([size.cpu, size.memoryMb, ttl]);
            let template = templates.get(configKey);

            if (!template)
              templates.set(
                configKey,
                (template = m.template({
                  cpu: size.cpu,
                  memoryMb: size.memoryMb,
                  image: options.image ?? defaultImage,
                  keepWarmSeconds: ttl,
                })),
              );
            const chosen = template;
            const { token: t, workspaceId: w } = credentials();

            // In the same synchronous turn as the create, so code using beam-js directly cannot
            // switch its account in between: configure checks the account and makes beam-js's
            // client, which keeps that token for the requests this create makes.
            m.configure({ token: t, workspaceId: w, gatewayUrl, requestTimeoutMs });
            made = await silently(t, () => chosen.create());
          }
        } catch (error) {
          // A refusal (an HTTP status, or Beam's ok:false) made nothing. Without an answer, the
          // allocation may have happened, and nothing names the container to stop.
          if (!maybeSent(error)) throw beamError(error);
          throw failure(
            `Sandbox creation outcome is unknown; a sandbox may be left running until its ${ttl} s lifetime ends`,
            "outcome_unknown",
          );
        }

        const id: unknown = made.containerId;

        // Beam accepted the create without naming its container: one may exist, unreachable.
        if (!isString(id) || !id)
          throw failure(
            `Sandbox creation outcome is unknown: Beam named no container, and a sandbox may be left running until its ${ttl} s lifetime ends`,
            "outcome_unknown",
          );

        if (isString(made.stubId) && made.stubId) stubs.set(id, made.stubId);
        const createdAt = Date.now();

        try {
          const g = api();

          await g.connect(id, input.signal);

          // A restored sandbox keeps the marker and env of the sandbox it was snapshotted from;
          // both are rewritten for this one.
          await g.upload(
            id,
            markerPath,
            new TextEncoder().encode(
              JSON.stringify({ key: input.key, labels: input.labels, createdAt }),
            ),
            0o600,
          );

          if (input.from !== undefined || Object.keys(input.env ?? {}).length)
            await g.upload(
              id,
              envFile,
              new TextEncoder().encode(JSON.stringify(input.env ?? {})),
              0o600,
            );

          // A restore keeps the source's remaining lifetime; give this sandbox its own.
          if (input.from !== undefined) await g.ttl(id, ttl);

          if (input.signal?.aborted) throw failure("Creation aborted", "aborted", id);
        } catch (error) {
          return abandon(id, error);
        }

        return { id, key: input.key, labels: { ...input.labels }, state: "running", createdAt };
      }),
    find: (key) =>
      safe(undefined, async () => (await provider.list({})).find((info) => info.key === key)),
    connect: (id) =>
      safe(id, async () => {
        const found = await container(id);
        const value = found && (await infoOf(found));

        if (!value) throw failure("Sandbox not found", "not_found", id);

        return value;
      }),
    list: (labels) =>
      safe(undefined, async () => {
        const result: SandboxInfo[] = [];
        const candidates = (await api().containers()).filter((c) => live.has(c.status));

        for (const c of candidates) stubs.set(c.containerId, c.stubId);

        // Eight marker reads at a time.
        for (let i = 0; i < candidates.length; i += 8) {
          const infos = await Promise.all(candidates.slice(i, i + 8).map(infoOf));

          for (const info of infos)
            if (info && Object.entries(labels).every(([k, v]) => info.labels[k] === v))
              result.push(info);
        }

        return result;
      }),
    destroy: (id) => safe(id, () => stop(id)),
    async close() {},
    exec: (id, input) => safe(id, () => execute(execGuest(id), input)),
    files: files(async (id) => fileGuest(id), safe),
    previewUrl: (id, port) =>
      safe(id, async () => ({ url: await api().expose(id, await stubOf(id), port) })),
    snapshot: (id, options) =>
      safe(id, async () => {
        // Beam keeps a memory snapshot with no expiry and has no call to delete one.
        if (options?.expiresInMs)
          throw failure("Beam snapshots do not expire and cannot be deleted", "unsupported", id);

        return { id: await api().snapshot(id, await stubOf(id)) };
      }),
    native(id) {
      const stubId = stubs.get(id) ?? containerPattern.exec(id)?.[1];

      if (!stubId) throw failure("Connect the sandbox first", "not_found", id);
      let value = natives.get(id);

      if (value?.stubId !== stubId) {
        value = {
          ...createNativeApi<BeamPlane>({ http, placeholder: "containerId", sandboxId: id }),
          containerId: id,
          stubId,
        };
        natives.set(id, value);
      }

      return value;
    },
  };

  return provider;
}

/** One POSIX shell word, for Beam's exec, which splits the command like a shell. */
function quoteWord(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
