/**
 * The parts of Beam's gateway (https://app.beam.cloud/api/v1/gateway) the adapter calls directly.
 * Shapes verified live on 2026-11-18 and against @beamcloud/beam-js 1.1.6, which calls the same
 * routes. The gateway answers most failures with HTTP 200 and `{ ok: false, errorMsg }`.
 */
import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { BeamGatewayError } from "./errors.js";

export interface BeamContainer {
  containerId: string;
  stubId: string;
  status: string;
  startedAt?: string;
  scheduledAt?: string;
}

export interface ExecStart {
  pid: number;
  /** Set when the gateway waited for the process and it finished. */
  done: boolean;
  exitCode?: number;
  stdout?: string;
}

export interface BeamGateway {
  containers(signal?: AbortSignal): Promise<BeamContainer[]>;
  /** Waits until a new container accepts commands. */
  connect(id: string, signal?: AbortSignal): Promise<void>;
  /** Starts a container from a memory snapshot. */
  restore(
    checkpointId: string,
    signal?: AbortSignal,
  ): Promise<{ containerId: string; stubId: string }>;
  stop(id: string): Promise<void>;
  exec(id: string, command: string, signal?: AbortSignal): Promise<ExecStart>;
  /** The exit code, or -1 while the process runs. */
  status(id: string, pid: number, signal?: AbortSignal): Promise<number>;
  stdout(id: string, pid: number, signal?: AbortSignal): Promise<string>;
  kill(id: string, pid: number): Promise<void>;
  upload(id: string, path: string, data: Uint8Array, mode: number): Promise<void>;
  /** The file's bytes, or undefined when the path does not exist. */
  download(id: string, path: string): Promise<Uint8Array | undefined>;
  expose(id: string, stubId: string, port: number): Promise<string>;
  snapshot(id: string, stubId: string): Promise<string>;
  ttl(id: string, seconds: number): Promise<void>;
}

export interface GatewayOptions {
  token: string;
  url: string;
  fetch: typeof fetch;
  /** Per request. */
  requestTimeoutMs: number;
}

// Beam's own message for a container that is gone or never existed, on exec and connect.
const missing = /^Failed to connect to sandbox$/;

const record = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: JsonValue | undefined) => (isString(value) ? value : undefined);

const count = (value: JsonValue | undefined) =>
  isNumber(value) && Number.isFinite(value) ? value : undefined;

function container(value: JsonValue): BeamContainer | undefined {
  if (!record(value)) return undefined;
  const containerId = text(value.containerId);
  const stubId = text(value.stubId);
  const status = text(value.status);

  if (!containerId || stubId === undefined || !status) return undefined;

  return {
    containerId,
    stubId,
    status,
    startedAt: text(value.startedAt),
    scheduledAt: text(value.scheduledAt),
  };
}

/** A gateway body that said `ok: true`; otherwise the failure, `missing` for a gone sandbox. */
function accepted(value: JsonValue): JsonObject {
  if (record(value) && value.ok === true) return value;
  const message = record(value) ? (text(value.errorMsg) ?? "") : "";

  throw new BeamGatewayError(undefined, missing.test(message) ? "missing" : "refused");
}

export function createGateway(options: GatewayOptions): BeamGateway {
  const base = options.url.replace(/\/+$/, "") + "/api/v1/gateway";

  async function call(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const deadline = AbortSignal.timeout(options.requestTimeoutMs);

    const response = await options.fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new BeamGatewayError(response.status, "http");
    }

    const parsed: JsonValue = JSON.parse(await response.text());

    return parsed;
  }

  const pod = (id: string) => `/pods/${encodeURIComponent(id)}`;

  return {
    async containers(signal) {
      const value = accepted(await call("GET", "/containers", undefined, signal));
      const list = Array.isArray(value.containers) ? value.containers : [];

      return list.flatMap((entry) => container(entry) ?? []);
    },
    async connect(id, signal) {
      accepted(await call("POST", `${pod(id)}/connect`, {}, signal));
    },
    async restore(checkpointId, signal) {
      const value = accepted(await call("POST", "/pods", { checkpointId }, signal));
      const containerId = text(value.containerId);

      // Accepted without naming the container: it may exist, so this is not a refusal.
      if (!containerId) throw new BeamGatewayError(undefined, "malformed");

      return { containerId, stubId: text(value.stubId) ?? "" };
    },
    async stop(id) {
      accepted(await call("POST", `/containers/${encodeURIComponent(id)}/stop`, {}));
    },
    async exec(id, command, signal) {
      // `wait` makes the gateway hold the request briefly and answer inline when the process
      // finishes in that window (about half a second, measured 2026-11-18).
      const value = accepted(
        await call("POST", `${pod(id)}/exec`, { command, wait: true }, signal),
      );

      const pid = count(value.pid);

      if (pid === undefined || pid <= 0) throw new BeamGatewayError(undefined, "refused");
      const done = value.done === true;

      return {
        pid,
        done,
        exitCode: done ? (count(value.exitCode) ?? 0) : undefined,
        stdout: done ? (text(value.stdout) ?? "") : undefined,
      };
    },
    async status(id, pid, signal) {
      const value = accepted(await call("GET", `${pod(id)}/status?pid=${pid}`, undefined, signal));

      return count(value.exitCode) ?? -1;
    },
    async stdout(id, pid, signal) {
      const value = accepted(await call("GET", `${pod(id)}/stdout?pid=${pid}`, undefined, signal));

      return text(value.stdout) ?? "";
    },
    async kill(id, pid) {
      accepted(await call("POST", `${pod(id)}/kill`, { pid }));
    },
    async upload(id, path, data, mode) {
      accepted(
        await call("POST", `${pod(id)}/files/upload`, {
          containerPath: path,
          mode,
          data: Buffer.from(data).toString("base64"),
        }),
      );
    },
    async download(id, path) {
      const value = await call("GET", `${pod(id)}/files/download/${encodeURIComponent(path)}`);

      // Only a missing path is a missing file; anything else is the gateway's failure.
      if (
        record(value) &&
        value.ok !== true &&
        /no such file or directory/.test(text(value.errorMsg) ?? "")
      )
        return undefined;

      return new Uint8Array(Buffer.from(text(accepted(value).data) ?? "", "base64"));
    },
    async expose(id, stubId, port) {
      const url = text(
        accepted(await call("POST", `${pod(id)}/ports/expose`, { stubId, port })).url,
      );

      if (!url) throw new BeamGatewayError(undefined, "refused");

      return url;
    },
    async snapshot(id, stubId) {
      const checkpoint = text(
        accepted(await call("POST", `${pod(id)}/snapshot-memory`, { stubId })).checkpointId,
      );

      if (!checkpoint) throw new BeamGatewayError(undefined, "refused");

      return checkpoint;
    },
    async ttl(id, seconds) {
      // beam-js 1.1.6 updates the lifetime with PATCH.
      accepted(await call("PATCH", `${pod(id)}/ttl`, { ttl: seconds }));
    },
  };
}
