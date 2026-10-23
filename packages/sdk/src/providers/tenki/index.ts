/** Official API sources (checked against @tenkicloud/sandbox 1.4.1 types):
 * https://tenki.cloud/docs/sandbox/sdk.md
 * https://tenki.cloud/docs/sandbox/sessions.md
 * https://tenki.cloud/docs/sandbox/snapshots.md
 * https://tenki.cloud/docs/sandbox/base-image.md
 * https://www.npmjs.com/package/@tenkicloud/sandbox
 */
import type { Session, CreateOptions } from "@tenkicloud/sandbox";
import type { Provider, CreateInput, SandboxInfo } from "../../provider.js";
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
  /** Defaults to TENKI_AUTH_TOKEN, then TENKI_API_KEY. */
  authToken?: string;
  baseUrl?: string;
  image?: string;
  /** Deadline for control-plane requests, in milliseconds. */
  requestTimeoutMs?: number;
  waitTimeoutMs?: number;
  /** Resume RPC deadline, separate from readiness. Default: 180 seconds; maximum: 15 minutes. */
  resumeTimeoutMs?: number;
}
export type TenkiCapability = "pause" | "snapshot" | "size" | "network-policy";
export type TenkiProvider = Provider<Session, TenkiCapability>;
const keyTag = "sandbox-sdk-key";
const createdTag = "sandbox-sdk-created-at";
const presets = {
  small: { cpu: 1, memoryMb: 1024, diskGb: 10 },
  medium: { cpu: 2, memoryMb: 4096, diskGb: 20 },
  large: { cpu: 4, memoryMb: 8192, diskGb: 40 },
};
function size(input: CreateInput["size"]) {
  if (input === undefined) return {};
  const value = typeof input === "string" ? presets[input] : input;
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
    labels: { ...value.metadata },
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
  "set -e; mkdir -p /home/tenki/.sandbox-sdk /tmp; if [ ! -e /workspace ]; then mkdir -p /home/tenki/workspace; ln -s /home/tenki/workspace /workspace; elif [ ! -L /workspace ] && [ ! -e /home/tenki/workspace ]; then mv /workspace /home/tenki/workspace; ln -s /home/tenki/workspace /workspace; fi; if [ ! -e /tmp/.sandbox-sdk ]; then ln -s /home/tenki/.sandbox-sdk /tmp/.sandbox-sdk; fi; test -L /tmp/.sandbox-sdk; command -v python3 git tar nohup setsid >/dev/null; readlink -f /workspace",
];
export function tenki(options: TenkiOptions = {}): TenkiProvider {
  let client:
    | Promise<InstanceType<(typeof import("@tenkicloud/sandbox"))["TenkiSandbox"]>>
    | undefined;
  const boxes = new Map<string, Session>();
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
        options.authToken ??
        (process.env.TENKI_AUTH_TOKEN?.trim() || process.env.TENKI_API_KEY?.trim());
      if (!authToken)
        throw failure("Tenki API key is missing; set TENKI_API_KEY or TENKI_AUTH_TOKEN", "auth");
      const { TenkiSandbox } = await import("@tenkicloud/sandbox");
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
      throw tenkiError(error, id, operation, [options.authToken ?? ""]);
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
  const provider: TenkiProvider = {
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
        const domains = typeof input.network === "object" ? input.network.allow : undefined;
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
        const metadata: Record<string, string> = {
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
          ...(input.from ? { snapshotId: input.from } : { image: options.image }),
          waitReady: false,
        };
        // Admit without waiting so every subsequent failure has an ID to clean up.
        const client = await api();
        // create() has no AbortSignal in Tenki 1.4.1. Keep observing its result
        // after the caller's deadline so a late allocation can still be closed.
        const pending = client.create(params);
        let value: Session;
        try {
          value = await request(() => pending, input.signal);
        } catch (error) {
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
          let cleanupError: unknown;
          try {
            await provider.destroy(value.id);
          } catch (error) {
            cleanupError = error;
          }
          throw createError(
            input.signal?.aborted ? failure("Creation aborted", "aborted") : error,
            context,
            [options.authToken ?? ""],
            cleanupError,
          );
        }
      }),
    list: (labels) =>
      safe("list", undefined, async () =>
        (await request(async () => (await api()).list()))
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
        const value = await request(() => current.exposePort(port));
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
    snapshot: (id) =>
      safe("snapshot", id, async () => {
        const client = await api();
        const snapshot = await request(() => client.createSnapshot(id, { async: true }));
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
