/** Official API sources (checked against @tenkicloud/sandbox 1.4.1 types):
 * https://tenki.cloud/docs/sandbox/sdk.md
 * https://tenki.cloud/docs/sandbox/sessions.md
 * https://tenki.cloud/docs/sandbox/snapshots.md
 * https://tenki.cloud/docs/sandbox/base-image.md
 * https://www.npmjs.com/package/@tenkicloud/sandbox
 */
import type { Session, CreateOptions } from "@tenkicloud/sandbox";
import type { Provider, CreateInput, SandboxInfo } from "../../provider.js";
import { execute, raw } from "./exec.js";
import { files } from "./files.js";
import { tenkiError, failure } from "./errors.js";

export interface TenkiOptions {
  /** Defaults to TENKI_AUTH_TOKEN, then TENKI_API_KEY. */
  authToken?: string;
  baseUrl?: string;
  image?: string;
  /** Deadline for control-plane requests, in milliseconds. */
  requestTimeoutMs?: number;
  waitTimeoutMs?: number;
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
  if (
    !value ||
    !Number.isInteger(value.cpu) ||
    value.cpu < 1 ||
    value.cpu > 128 ||
    !Number.isInteger(value.memoryMb) ||
    value.memoryMb < 128 ||
    value.memoryMb > 524288 ||
    value.memoryMb % 2 ||
    !Number.isInteger(value.diskGb) ||
    value.diskGb < 5 ||
    value.diskGb > 100
  )
    throw failure(
      "Size requires 1–128 CPUs, even memoryMb from 128–524288, and 5–100 diskGb",
      "unsupported",
    );
  return { cpuCores: value.cpu, memoryMb: value.memoryMb, diskSizeGb: value.diskGb };
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
  "mkdir -p /workspace /home/tenki/.sandbox-sdk /tmp; if [ ! -e /tmp/.sandbox-sdk ]; then ln -s /home/tenki/.sandbox-sdk /tmp/.sandbox-sdk; fi; test -L /tmp/.sandbox-sdk; command -v python3 git tar nohup setsid >/dev/null",
];
export function tenki(options: TenkiOptions = {}): TenkiProvider {
  let client:
    | Promise<InstanceType<(typeof import("@tenkicloud/sandbox"))["TenkiSandbox"]>>
    | undefined;
  const boxes = new Map<string, Session>();
  async function api() {
    return (client ??= (async () => {
      const authToken =
        options.authToken ??
        (process.env.TENKI_AUTH_TOKEN?.trim() || process.env.TENKI_API_KEY?.trim());
      if (!authToken)
        throw failure("Tenki API key is missing; set TENKI_API_KEY or TENKI_AUTH_TOKEN", "auth");
      const { TenkiSandbox } = await import("@tenkicloud/sandbox");
      return new TenkiSandbox({
        authToken,
        baseUrl: options.baseUrl,
        timeoutMs: options.requestTimeoutMs ?? 30_000,
      });
    })());
  }
  async function safe<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw tenkiError(error, id);
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
    processRecordRoot: "/home/tenki/.sandbox-sdk/procs",
    capabilities: new Set<TenkiCapability>(["pause", "snapshot", "size", "network-policy"]),
    create: (input) =>
      safe(undefined, async () => {
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
        const value = await (await api()).create(params);
        boxes.set(value.id, value);
        try {
          await value.waitReady(options.waitTimeoutMs ?? 180_000, input.signal);
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
          await raw(value, prepare);
          return info(value);
        } catch (error) {
          await provider.destroy(value.id);
          if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
          throw error;
        }
      }),
    list: (labels) =>
      safe(undefined, async () =>
        (await (await api()).list())
          .filter(
            (value) =>
              value.state !== "TERMINATED" &&
              value.state !== "TERMINATING" &&
              Object.entries({ ...labels, "sandbox-sdk": "1" }).every(
                ([key, expected]) => value.metadata[key] === expected,
              ),
          )
          .map(info),
      ),
    async find(key) {
      const found = (await provider.list({ [keyTag]: key }))[0];
      return found ? provider.connect(found.id) : undefined;
    },
    connect: (id) =>
      safe(id, async () => {
        const value = await (await api()).get(id);
        const result = info(value);
        if (["TERMINATED", "TERMINATING"].includes(value.state))
          throw failure("Session has terminated", "not_found");
        if (result.state === "running") await raw(value, prepare);
        boxes.set(id, value);
        return result;
      }),
    destroy: (id) =>
      safe(id, async () => {
        try {
          await (await box(id)).close();
        } catch (error) {
          if (tenkiError(error).code !== "not_found") throw error;
        } finally {
          boxes.delete(id);
        }
      }),
    async close(id) {
      boxes.delete(id);
    },
    exec: (id, input) => safe(id, async () => execute(await box(id), input)),
    files: files(box, safe),
    previewUrl: (id, port) =>
      safe(id, async () => {
        const value = await (await box(id)).exposePort(port);
        return { url: value.previewUrl, expiresAt: value.expiresAt?.getTime() };
      }),
    pause: (id) =>
      safe(id, async () => {
        const value = await box(id);
        await value.pause();
        await value.waitPaused(options.waitTimeoutMs ?? 180_000);
      }),
    resume: (id) =>
      safe(id, async () => {
        const value = await box(id);
        await value.resume();
        await value.waitResumed(options.waitTimeoutMs ?? 180_000);
        await raw(value, prepare);
      }),
    snapshot: (id) =>
      safe(id, async () => ({
        id: (
          await (
            await api()
          ).createSnapshotAndWait(id, { timeoutMs: options.waitTimeoutMs ?? 300_000 })
        ).id,
      })),
    native(id) {
      const value = boxes.get(id);
      if (!value) throw failure("Session is detached; connect first", "not_found");
      return value;
    },
  };
  return provider;
}
