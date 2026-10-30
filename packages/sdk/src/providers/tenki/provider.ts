/** Official API sources (checked against @tenkicloud/sandbox 1.4.1 types):
 * https://tenki.cloud/docs/sandbox/sdk.md
 * https://tenki.cloud/docs/sandbox/sessions.md
 * https://tenki.cloud/docs/sandbox/snapshots.md
 * https://tenki.cloud/docs/sandbox/base-image.md
 * https://www.npmjs.com/package/@tenkicloud/sandbox
 */
import type {
  ClientOptions,
  CreateOptions,
  CreateSnapshotOptions,
  ListOptions,
  Session as NativeSession,
  SessionFs,
  Snapshot,
} from "@tenkicloud/sandbox";
import type { ErrorCode } from "../../errors.js";
import { loadPeer } from "../../peer.js";
import { isObject, isString } from "../../shared/narrow.js";
import type { Provider, CreateInput, Labels, SandboxInfo } from "../../provider.js";
import { deadline } from "./deadline.js";
import { waitReady } from "./ready.js";
import { execute, raw } from "./exec.js";
import { files } from "./files.js";
import {
  tenkiError,
  failure,
  createError,
  type CreateStage,
  type TenkiOperation,
} from "./errors.js";

export interface TenkiOptions {
  /** Defaults to TENKI_AUTH_TOKEN, then TENKI_API_KEY; required on first use. */
  apiKey?: string;
  /** @deprecated Use apiKey. Removed in 1.0.0. */
  authToken?: string;
  /** Defaults to TENKI_API_ENDPOINT, then TENKI_API_URL, then https://api.tenki.cloud. */
  baseUrl?: string;
  /** Base image; default: the Tenki service default image. */
  image?: string;
  /** Control-plane deadline. Default: 30 s. */
  requestTimeoutMs?: number;
  /** Readiness budget, 1–900000 ms. Default: 180 s; snapshots: 300 s. */
  waitTimeoutMs?: number;
  /** Resume RPC deadline, separate from readiness. Default: 180 seconds; maximum: 15 minutes. */
  resumeTimeoutMs?: number;
  /** How long Tenki keeps a paused sandbox before deleting it. Default: Tenki's retention. */
  pauseRetentionMs?: number;
  /** Tenki volumes to mount, such as `[{ volumeId: "vol_123", mountPath: "/data" }]`. */
  volumes?: CreateOptions["volumes"];
  /** Workspace for service credentials that span workspaces. Workspace API keys infer it. */
  workspaceId?: string;
  /** Lifetime of each preview URL. Default: Tenki's preview TTL. */
  previewTtlMs?: number;
}

export type TenkiCapability = "pause" | "snapshot" | "size" | "network-policy";

export type TenkiProvider = Provider<NativeSession, TenkiCapability>;

type DataPlaneClient = Awaited<ReturnType<NativeSession["requireDataPlane"]>>;

type NativeRun = DataPlaneClient["run"];

/** True when `T` is `any`, which is what an uninstalled optional peer's types resolve to. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** A request frame for the data-plane `run` stream. */
export type TenkiRunRequest = Parameters<NativeRun>[0] extends AsyncIterable<infer T> ? T : never;

// Without the peer installed, the derived frame types stay `any` instead of collapsing to
// `unknown`, so a consumer's typecheck reports only the missing module.
type NativeRunResponse =
  IsAny<NativeRun> extends true
    ? any
    : ReturnType<NativeRun> extends AsyncIterable<infer T>
      ? T
      : never;

type NativeRunOptions =
  IsAny<NativeRun> extends true ? { signal?: AbortSignal } : NonNullable<Parameters<NativeRun>[1]>;

type NativeRunPayload = NonNullable<NativeRunResponse["frame"]>["payload"];

type NativeRunVariant<Case extends NativeRunPayload["case"]> = Extract<
  NativeRunPayload,
  { case: Case }
>;

/** A response frame from the data-plane `run` stream. Each variant keeps only the
 * fields the adapter reads, so the native frames satisfy it and test fixtures can
 * build it without protobuf message metadata.
 */
export interface TenkiRunResponse {
  frame?: {
    payload:
      | NativeRunVariant<"stdout" | "stderr">
      | { case: "exit"; value: Pick<NativeRunVariant<"exit">["value"], "exitCode"> }
      | { case: Exclude<NativeRunPayload["case"], "stdout" | "stderr" | "exit"> };
  };
}

/** The data-plane client calls the adapter makes. */
export interface TenkiDataPlane {
  run(
    requests: AsyncIterable<TenkiRunRequest>,
    options: Required<Pick<NativeRunOptions, "signal">>,
  ): AsyncIterable<TenkiRunResponse>;
}

/** The parts of a Tenki session the adapter uses. The data-plane entry points are
 * optional: without them, commands fall back to buffered `run()` pages.
 */
export type TenkiSession = Pick<
  NativeSession,
  | "id"
  | "state"
  | "metadata"
  | "cpuCores"
  | "memoryMb"
  | "diskSizeGb"
  | "outboundEnabled"
  | "egress"
  | "run"
  | "readFile"
  | "writeFile"
  | "writeFileStream"
  | "waitReady"
  | "waitPaused"
  | "waitResumed"
  | "refresh"
  | "pause"
  | "resume"
  | "close"
  | "exposePort"
  | "reauthOnUnauthenticated"
> & {
  fs: Pick<SessionFs, "stat" | "list">;
  dataPlaneRPC?(): TenkiDataPlane | undefined;
  requireDataPlane?(verifyServing?: boolean): Promise<TenkiDataPlane>;
  dataPlaneProvisioningPending(plane: TenkiDataPlane): boolean;
  markDataPlaneServing(plane: TenkiDataPlane): void;
  refreshHintedDataPlane(plane: TenkiDataPlane): Promise<boolean>;
};

/** A session whose client streams commands over the data plane. */
export type StreamingSession = TenkiSession & Required<Pick<TenkiSession, "requireDataPlane">>;

type Session = TenkiSession;

/** The parts of a Tenki client the adapter uses. */
export interface TenkiClient<S extends TenkiSession> {
  create(options: CreateOptions): Promise<S>;
  get(id: string): Promise<S>;
  list(options: ListOptions | undefined): Promise<S[]>;
  createSnapshot(id: string, options: CreateSnapshotOptions): Promise<Pick<Snapshot, "id">>;
  waitSnapshotReady(
    id: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Pick<Snapshot, "id">>;
}

/** The parts of the Tenki SDK the adapter uses: the real `@tenkicloud/sandbox` module, or a test fixture. */
export interface TenkiModule<S extends TenkiSession> {
  TenkiSandbox: new (options: ClientOptions) => TenkiClient<S>;
}

const keyTag = "sandbox-sdk-key";
const createdTag = "sandbox-sdk-created-at";

/** SDK bookkeeping and Tenki's own metadata. Labels show only the caller's labels and `sandbox-sdk`. */
const internal = new Set([keyTag, createdTag, "enable_opencode"]);

const presets = {
  small: { cpu: 1, memoryMb: 1024, diskGb: 10 },
  medium: { cpu: 2, memoryMb: 4096, diskGb: 20 },
  large: { cpu: 4, memoryMb: 8192, diskGb: 40 },
};

function size(input: CreateInput["size"]) {
  if (input === undefined) return {};
  const value = isString(input) ? presets[input] : input;
  const diskGb = value?.diskGb ?? 5;

  if (
    !value ||
    !Number.isInteger(value.cpu) ||
    value.cpu < 1 ||
    value.cpu > 128 ||
    !Number.isInteger(value.memoryMb) ||
    value.memoryMb < 128 ||
    value.memoryMb > 524288 ||
    value.memoryMb % 2 ||
    !Number.isInteger(diskGb) ||
    diskGb < 5 ||
    diskGb > 100
  )
    throw failure(
      "Size requires 1–128 CPUs, even memoryMb from 128–524288, and 5–100 diskGb",
      "unsupported",
    );

  return { cpuCores: value.cpu, memoryMb: value.memoryMb, diskSizeGb: diskGb };
}

function info(value: Session): SandboxInfo {
  const createdAt = Number(value.metadata[createdTag]);

  if (!Number.isFinite(createdAt) || createdAt <= 0 || value.metadata["sandbox-sdk"] !== "1")
    throw failure("Session was not created by Sandbox SDK or its metadata is missing", "not_found");

  return {
    id: value.id,
    key: value.metadata[keyTag],
    labels: Object.fromEntries(
      Object.entries(value.metadata).filter(([key]) => !internal.has(key)),
    ),
    createdAt,
    state:
      value.state === "RUNNING"
        ? "running"
        : ["PAUSED", "PAUSING", "RESUMING"].includes(value.state)
          ? "paused"
          : "stopped",
  };
}

// Tenki clears /tmp on pause. The canonical SDK path is a link into durable disk;
// recreate it before process reattachment, including after snapshot restoration.
const prepare = [
  "sh",
  "-c",
  "set -e; mkdir -p /home/tenki/.sandbox-sdk /tmp; exec 9>/home/tenki/.sandbox-sdk/setup.lock; flock -x 9; if [ ! -e /workspace ]; then mkdir -p /home/tenki/workspace; ln -s /home/tenki/workspace /workspace; elif [ ! -L /workspace ] && [ ! -e /home/tenki/workspace ]; then mv /workspace /home/tenki/workspace; ln -s /home/tenki/workspace /workspace; fi; flock -u 9; if [ ! -e /tmp/.sandbox-sdk ]; then ln -s /home/tenki/.sandbox-sdk /tmp/.sandbox-sdk; fi; test -L /tmp/.sandbox-sdk; command -v python3 git tar nohup setsid >/dev/null; readlink -f /workspace",
];

/** @internal The adapter behind `tenki()`. `load` imports the Tenki SDK; tests pass a fixture. */
export function createTenkiProvider<S extends TenkiSession>(
  options: TenkiOptions,
  load: () => Promise<TenkiModule<S>>,
): Provider<S, TenkiCapability> {
  let client: Promise<TenkiClient<S>> | undefined;

  const boxes = new Map<string, S>();
  const destroying = new Map<string, Promise<void>>();
  const workspaceRoots = new WeakMap<Session, string>();

  const workspaceStates = new Map<
    string,
    { active: number; revision: number; overlap: boolean; untracked: boolean }
  >();

  function workspaceState(value: Session) {
    let state = workspaceStates.get(value.id);

    if (!state) {
      state = { active: 0, revision: 0, overlap: false, untracked: false };
      workspaceStates.set(value.id, state);
    }

    return state;
  }

  function invalidateWorkspace(value: Session) {
    workspaceRoots.delete(value);
    workspaceState(value).revision++;
  }

  function setWorkspaceRoot(value: Session, root: string) {
    const state = workspaceState(value);

    if (
      !state.active &&
      !state.untracked &&
      (root === "/home/tenki" || root.startsWith("/home/tenki/"))
    )
      workspaceRoots.set(value, root);
  }

  async function prepareBox(value: Session) {
    invalidateWorkspace(value);
    const revision = workspaceState(value).revision;
    const root = (await raw(value, prepare)).replace(/\n$/, "");

    if (revision === workspaceState(value).revision) setWorkspaceRoot(value, root);
  }

  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const resumeTimeoutMs = options.resumeTimeoutMs ?? 180_000;

  const request = <T>(action: () => Promise<T>, signal?: AbortSignal) =>
    deadline(action, requestTimeoutMs, signal);

  const wait = (
    action: (signal: AbortSignal) => Promise<void>,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => deadline(action, timeoutMs, signal);

  async function api() {
    return (client ??= (async () => {
      if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
        throw failure("requestTimeoutMs must be a positive integer", "invalid_argument");

      if (
        !Number.isSafeInteger(resumeTimeoutMs) ||
        resumeTimeoutMs <= 0 ||
        resumeTimeoutMs > 900_000
      )
        throw failure("resumeTimeoutMs must be an integer from 1 to 900000", "invalid_argument");

      if (
        options.waitTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.waitTimeoutMs) ||
          options.waitTimeoutMs <= 0 ||
          options.waitTimeoutMs > 900_000)
      )
        throw failure("waitTimeoutMs must be an integer from 1 to 900000", "invalid_argument");

      const authToken =
        options.apiKey ??
        options.authToken ??
        (process.env.TENKI_AUTH_TOKEN?.trim() || process.env.TENKI_API_KEY?.trim());

      if (!authToken)
        throw failure(
          "Tenki API key is missing. Authentication is required. Set TENKI_API_KEY or TENKI_AUTH_TOKEN or pass apiKey.",
          "auth",
        );

      const { TenkiSandbox } = await loadPeer("@tenkicloud/sandbox", "tenki", load);

      return new TenkiSandbox({
        authToken,
        baseUrl: options.baseUrl,
      });
    })());
  }

  async function safe<T>(
    operation: TenkiOperation,
    id: string | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw tenkiError(error, id, operation, [options.apiKey ?? options.authToken ?? ""]);
    }
  }

  async function box(id: string) {
    const found = boxes.get(id);

    if (found) return found;
    await provider.connect(id);
    const value = boxes.get(id);

    if (!value) throw failure("Session is detached", "not_found");

    return value;
  }

  const provider: Provider<S, TenkiCapability> = {
    name: "tenki",
    keyMode: "best-effort",
    inlineActivity: true,
    processRecordRoot: "/home/tenki/.sandbox-sdk/procs",
    capabilities: new Set<TenkiCapability>(["pause", "snapshot", "size", "network-policy"]),
    create: (input) =>
      safe("create", undefined, async () => {
        if (input.idleTimeoutMs !== undefined)
          throw failure(
            "Tenki no longer auto-pauses on idle; idleTimeoutMs is unavailable",
            "unsupported",
          );

        if (
          input.timeoutMs !== undefined &&
          (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
        )
          throw failure("timeoutMs must be a positive integer", "invalid_argument");

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        const allocation = size(input.size);
        const domains = isObject(input.network) ? input.network.allow : undefined;

        if (
          domains?.some(
            (domain) =>
              domain.length > 253 ||
              !/^(\*\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(
                domain,
              ),
          )
        )
          throw failure(
            "Network allow entries must be DNS hostnames or leading wildcard domains",
            "unsupported",
          );

        const metadata: Labels = {
          ...input.labels,
          "sandbox-sdk": "1",
          [createdTag]: String(Date.now()),
        };

        delete metadata[keyTag];

        if (input.key !== undefined) metadata[keyTag] = input.key;

        const params: CreateOptions = {
          ...allocation,
          metadata,
          env: input.env,
          sticky: false,
          maxDurationMs: input.timeoutMs,
          allowInbound: true,
          allowOutbound: input.network !== "none" && domains?.length !== 0,
          allowDomains: domains,
          waitReady: false,
        };

        if (input.from) params.snapshotId = input.from;
        else params.image = options.image;

        if (options.pauseRetentionMs !== undefined)
          params.pauseRetentionMs = options.pauseRetentionMs;

        if (options.volumes !== undefined) params.volumes = options.volumes;

        if (options.workspaceId !== undefined) params.workspaceId = options.workspaceId;

        // Admit without waiting so every subsequent failure has an ID to clean up.
        const client = await api();
        // create() has no AbortSignal in Tenki 1.4.1. Keep observing its result
        // after the caller's deadline so a late allocation can still be closed.
        const pending = client.create(params);
        let value: S;

        try {
          value = await request(() => pending, input.signal);
        } catch (error) {
          // Best effort: close a session that arrives after the caller gave up.
          void pending.then((late) => request(() => late.close())).catch(() => {});
          throw error;
        }

        boxes.set(value.id, value);
        let stage: CreateStage = "waitReady";

        try {
          const timeoutMs = options.waitTimeoutMs ?? 180_000;
          await waitReady(value, timeoutMs, input.signal);
          stage = "validate";

          if (input.signal?.aborted) throw failure("Creation aborted", "aborted");

          if (
            allocation.cpuCores !== undefined &&
            (value.cpuCores !== allocation.cpuCores ||
              value.memoryMb !== allocation.memoryMb ||
              value.diskSizeGb !== allocation.diskSizeGb)
          )
            throw failure("Tenki returned different resources than requested", "unsupported");

          if (
            value.outboundEnabled !== params.allowOutbound ||
            (domains?.length &&
              (domains.some((domain) => !value.egress.allowDomains.includes(domain)) ||
                value.egress.allowDomains.some((domain) => !domains.includes(domain)) ||
                value.egress.allowCidrs.length))
          )
            throw failure("Tenki did not confirm the requested network policy", "unsupported");

          return info(value);
        } catch (error) {
          const context = { id: value.id, state: value.state, stage };
          let cleanupCode: ErrorCode | undefined;

          try {
            await provider.destroy(value.id);
          } catch (cleanupError) {
            cleanupCode = tenkiError(cleanupError).code;
          }

          throw createError(
            input.signal?.aborted ? failure("Creation aborted", "aborted") : error,
            context,
            [options.apiKey ?? options.authToken ?? ""],
            cleanupCode,
          );
        }
      }),
    list: (labels) =>
      safe("list", undefined, async () =>
        (
          await request(async () =>
            (await api()).list(
              options.workspaceId === undefined ? undefined : { workspaceId: options.workspaceId },
            ),
          )
        )
          .filter(
            (value) =>
              value.state !== "TERMINATED" &&
              value.state !== "TERMINATING" &&
              Object.entries({ ...labels, "sandbox-sdk": "1" }).every(
                ([key, expected]) => value.metadata[key] === expected,
              ),
          )
          .flatMap((value) => {
            try {
              return [info(value)];
            } catch (error) {
              if (tenkiError(error).code !== "not_found") throw error;

              return [];
            }
          }),
      ),
    async find(key) {
      const found = (await provider.list({ [keyTag]: key }))[0];

      return found ? provider.connect(found.id) : undefined;
    },
    connect: (id) =>
      safe("connect", id, async () => {
        const value = await request(async () => (await api()).get(id));
        const result = info(value);

        if (["TERMINATED", "TERMINATING"].includes(value.state))
          throw failure("Session has terminated", "not_found");

        if (result.state === "running") await prepareBox(value);
        boxes.set(id, value);

        return result;
      }),
    destroy(id) {
      const pending = destroying.get(id);

      if (pending) return pending;

      const operation = safe("destroy", id, async () => {
        let terminated = false;

        try {
          await request(async () => (await box(id)).close());
          terminated = true;
        } catch (error) {
          if (tenkiError(error).code !== "not_found") throw error;
          terminated = true;
        } finally {
          boxes.delete(id);

          if (terminated) workspaceStates.delete(id);
        }
      }).finally(() => destroying.delete(id));

      destroying.set(id, operation);

      return operation;
    },
    async close(id) {
      boxes.delete(id);
    },
    exec: (id, input) =>
      safe("exec", id, async () => {
        const value = await box(id);
        // Commands can replace the workspace alias. While one runs, use the
        // original guest path; its completion refreshes the cache without an RPC.
        invalidateWorkspace(value);
        const state = workspaceState(value);
        const revision = state.revision;
        state.active++;

        if (state.active > 1) state.overlap = true;
        let root: string | undefined;

        try {
          return await execute(value, input, (resolved, stable) => {
            if (!stable) state.untracked = true;
            root = resolved;
          });
        } finally {
          // Without a completion snapshot, detached work may have survived.
          if (root === undefined) state.untracked = true;
          state.active--;

          if (!state.overlap && revision === state.revision && root !== undefined)
            setWorkspaceRoot(value, root);

          if (!state.active) state.overlap = false;
        }
      }),
    files: files(
      box,
      (id, action) => safe("files", id, action),
      (value) => {
        const state = workspaceState(value);

        return state.active || state.untracked ? undefined : workspaceRoots.get(value);
      },
      invalidateWorkspace,
    ),
    previewUrl: (id, port) =>
      safe("preview", id, async () => {
        const current = await box(id);

        const value = await request(() =>
          current.exposePort(
            port,
            options.previewTtlMs === undefined ? undefined : { ttlMs: options.previewTtlMs },
          ),
        );

        return { url: value.previewUrl, expiresAt: value.expiresAt?.getTime() };
      }),
    pause: (id) =>
      safe("pause", id, async () => {
        const value = await box(id);
        const timeoutMs = options.waitTimeoutMs ?? 180_000;
        await deadline(() => value.pause(), timeoutMs);
        await wait((signal) => value.waitPaused(timeoutMs, signal), timeoutMs);
      }),
    resume: (id) =>
      safe("resume", id, async () => {
        const value = await box(id);
        await deadline(() => value.resume(), resumeTimeoutMs);
        const timeoutMs = options.waitTimeoutMs ?? 180_000;
        await wait((signal) => value.waitResumed(timeoutMs, signal), timeoutMs);
        await prepareBox(value);
      }),
    snapshot: (id, settings) =>
      safe("snapshot", id, async () => {
        const expiresInMs = settings?.expiresInMs;

        if (expiresInMs !== undefined && (!Number.isSafeInteger(expiresInMs) || expiresInMs < 0))
          throw failure("expiresInMs must be a non-negative integer", "invalid_argument");
        const client = await api();

        // 0 keeps the snapshot: Tenki applies no expiry when expiresAt is absent.
        const snapshot = await request(() =>
          client.createSnapshot(
            id,
            expiresInMs
              ? { async: true, expiresAt: new Date(Date.now() + expiresInMs) }
              : { async: true },
          ),
        );

        const timeoutMs = options.waitTimeoutMs ?? 300_000;

        const result = await deadline(
          (signal) => client.waitSnapshotReady(snapshot.id, timeoutMs, signal),
          timeoutMs,
        );

        return { id: result.id };
      }),
    native(id) {
      const value = boxes.get(id);

      if (!value) throw failure("Session is detached; connect first", "not_found");
      invalidateWorkspace(value);
      workspaceState(value).untracked = true;

      return value;
    },
  };

  return provider;
}
