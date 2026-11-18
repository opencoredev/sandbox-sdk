/** Verified against @beamcloud/beam-js 1.1.6 and Beam's gateway on 2026-11-18. */
import type { CreateInput, Labels, Provider, SandboxInfo } from "../../provider.js";
import { files, type Guest } from "../../shared/guest.js";
import { isNumber, isObject, isString, isStringRecord } from "../../shared/narrow.js";
import { createGateway, type BeamContainer, type BeamGateway } from "./api.js";
import { beamError, failure } from "./errors.js";
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
  /** Per gateway request. Default: 30 s. */
  requestTimeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

export interface BeamNative {
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

/** One sandbox configuration. Beam prepares its stub on the first create and reuses it after. */
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
  /** Sets beam-js's one global configuration, read when its HTTP client is first made. */
  configure(settings: { token: string; workspaceId: string; gatewayUrl: string }): void;
  template(config: BeamTemplateConfig): BeamTemplate;
  restore(snapshotId: string): Promise<BeamMade>;
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

/**
 * `@beamcloud/beam-js` prints its build and create progress with console.log. Creates run with
 * those calls dropped; other output passes through. Counted, so overlapping creates restore once.
 */
let quiet = 0;
let saved: { log: typeof console.log; info: typeof console.info } | undefined;

async function silently<T>(action: () => Promise<T>): Promise<T> {
  if (quiet++ === 0) {
    saved = { log: console.log, info: console.info };
    console.log = () => {};

    console.info = () => {};
  }

  try {
    return await action();
  } finally {
    if (--quiet === 0 && saved) {
      console.log = saved.log;
      console.info = saved.info;
      saved = undefined;
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

  function api(): BeamGateway {
    return (gateway ??= createGateway({
      token: credentials().token,
      url: gatewayUrl,
      fetch: options.fetch ?? fetch,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    }));
  }

  async function sdk(): Promise<BeamModule> {
    const { token: t, workspaceId: w } = credentials();

    return (module ??= load().then((m) => {
      m.configure({ token: t, workspaceId: w, gatewayUrl });

      return m;
    }));
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

    for (;;) {
      if (signal?.aborted) throw failure("Command aborted", "aborted", id);

      if (Date.now() > deadline) {
        await g.kill(id, started.pid).catch(() => {});
        throw failure("Guest command timed out", "timeout", id);
      }

      const code = await g.status(id, started.pid, signal);

      if (code >= 0) {
        if (code !== 0) throw failure("Guest operation failed", "provider", id);

        return g.stdout(id, started.pid, signal);
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
      upload: (path, bytes) => api().upload(id, path, bytes, 0o600),
      read: (path, range, signal) => readRange(id, path, range, signal),
    };
  }

  /** The guest the shared file operations run through. */
  function fileGuest(id: string): Guest {
    return {
      name: "beam",
      raw: (command) => shell(id, command, 120_000),
      upload: (path, bytes, mode) => api().upload(id, path, bytes, mode ?? 0o644),
      read: async (path, range) => {
        if (range) return readRange(id, path, range);
        const bytes = await api().download(id, path);

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

  const provider: BeamProvider = {
    name: "beam",
    keyMode: "best-effort",
    inlineActivity: true,
    capabilities: new Set(["size", "snapshot"]),
    create: (input) =>
      safe(undefined, async () => {
        if (input.network !== undefined && input.network !== "all")
          throw failure("Beam adapter has no network policy", "unsupported");
        const size = sizeOf(input.size);

        const ttl =
          input.timeoutMs === undefined
            ? (options.keepWarmSeconds ?? 3600)
            : Math.max(1, Math.ceil(input.timeoutMs / 1000));

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        const m = await sdk();
        let made: BeamMade;

        try {
          if (input.from !== undefined) {
            const from = input.from;
            made = await silently(() => m.restore(from));
          } else {
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
            made = await silently(() => chosen.create());
          }
        } catch (error) {
          // beam-js throws its own errors for a refused create and axios errors for HTTP
          // failures. A create the gateway accepted but whose connect then failed leaves a
          // container behind without a marker; Beam stops it when its lifetime ends.
          const mapped = beamError(error);

          throw ["auth", "quota", "invalid_argument"].includes(mapped.code)
            ? mapped
            : failure(
                `Sandbox creation failed; a sandbox may be left running until its ${ttl} s lifetime ends`,
                "outcome_unknown",
              );
        }

        const id = made.containerId;
        stubs.set(id, made.stubId);
        const createdAt = Date.now();

        try {
          const g = api();

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
          await stop(id).catch(() => {});
          throw beamError(error, id);
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
    snapshot: (id) => safe(id, async () => ({ id: await api().snapshot(id, await stubOf(id)) })),
    native(id) {
      const stubId = stubs.get(id) ?? containerPattern.exec(id)?.[1];

      if (!stubId) throw failure("Connect the sandbox first", "not_found", id);

      return { containerId: id, stubId };
    },
  };

  return provider;
}

/** One POSIX shell word, for Beam's exec, which splits the command like a shell. */
function quoteWord(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
