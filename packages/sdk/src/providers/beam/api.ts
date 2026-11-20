/**
 * The parts of Beam's gateway (https://app.beam.cloud/api/v1/gateway) the adapter calls directly.
 * Shapes verified live on 2026-11-18 and against @beamcloud/beam-js 1.1.6, which calls the same
 * routes. The gateway answers most failures with HTTP 200 and `{ ok: false, errorMsg }`.
 */
import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { userAgent } from "../../version.js";
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

// gRPC's refusal of a message over its 4 MiB cap. Measured as HTTP 429 on 2026-11-18; matched in an
// `ok: false` body too, so a download over the cap still moves in pieces if the gateway wraps it.
const tooLarge = /ResourceExhausted|larger than max/i;

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

  /**
   * One gateway request. A `mutation` whose answer is lost (a dropped connection, the deadline, a
   * 504, a body that cannot be read) may have taken effect, so it fails as `unknown`; only the
   * caller's own abort stays an abort. Only restore, exec and snapshot are mutations here: the
   * other writes (connect, stop, kill, upload, expose, ttl) leave the same state when repeated.
   */
  async function call(request: {
    method: "GET" | "POST" | "PATCH";
    path: string;
    body?: JsonObject;
    signal?: AbortSignal;
    mutation?: boolean;
  }): Promise<JsonValue> {
    const { method, path, body, signal, mutation = false } = request;
    const deadline = AbortSignal.timeout(options.requestTimeoutMs);
    let response: Response;

    try {
      response = await options.fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (error) {
      if (mutation && !signal?.aborted) throw new BeamGatewayError(undefined, "unknown");
      throw error;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});

      throw new BeamGatewayError(
        response.status,
        mutation && response.status === 504 ? "unknown" : "http",
      );
    }

    try {
      const parsed: JsonValue = JSON.parse(await response.text());

      return parsed;
    } catch (error) {
      if (mutation && !signal?.aborted) throw new BeamGatewayError(undefined, "unknown");
      throw error;
    }
  }

  const pod = (id: string) => `/pods/${encodeURIComponent(id)}`;

  return {
    async containers(signal) {
      const value = accepted(await call({ method: "GET", path: "/containers", signal }));
      const list = Array.isArray(value.containers) ? value.containers : [];

      return list.flatMap((entry) => container(entry) ?? []);
    },
    async connect(id, signal) {
      accepted(await call({ method: "POST", path: `${pod(id)}/connect`, body: {}, signal }));
    },
    async restore(checkpointId, signal) {
      const value = accepted(
        await call({
          method: "POST",
          path: "/pods",
          body: { checkpointId },
          signal,
          mutation: true,
        }),
      );

      const containerId = text(value.containerId);

      // Accepted without naming the container: it may exist, so this is not a refusal.
      if (!containerId) throw new BeamGatewayError(undefined, "malformed");

      return { containerId, stubId: text(value.stubId) ?? "" };
    },
    async stop(id) {
      accepted(
        await call({
          method: "POST",
          path: `/containers/${encodeURIComponent(id)}/stop`,
          body: {},
        }),
      );
    },
    async exec(id, command, signal) {
      // `wait` makes the gateway hold the request briefly and answer inline when the process
      // finishes in that window (about half a second, measured 2026-11-18).
      const value = accepted(
        await call({
          method: "POST",
          path: `${pod(id)}/exec`,
          body: { command, wait: true },
          signal,
          mutation: true,
        }),
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
      const value = accepted(
        await call({ method: "GET", path: `${pod(id)}/status?pid=${pid}`, signal }),
      );

      return count(value.exitCode) ?? -1;
    },
    async stdout(id, pid, signal) {
      const value = accepted(
        await call({ method: "GET", path: `${pod(id)}/stdout?pid=${pid}`, signal }),
      );

      return text(value.stdout) ?? "";
    },
    async kill(id, pid) {
      accepted(await call({ method: "POST", path: `${pod(id)}/kill`, body: { pid } }));
    },
    async upload(id, path, data, mode) {
      accepted(
        await call({
          method: "POST",
          path: `${pod(id)}/files/upload`,
          body: { containerPath: path, mode, data: Buffer.from(data).toString("base64") },
        }),
      );
    },
    async download(id, path) {
      const value = await call({
        method: "GET",
        path: `${pod(id)}/files/download/${encodeURIComponent(path)}`,
      });

      // Only a missing path is a missing file; anything else is the gateway's failure.
      if (record(value) && value.ok !== true) {
        const message = text(value.errorMsg) ?? "";

        if (/no such file or directory/.test(message)) return undefined;

        if (tooLarge.test(message)) throw new BeamGatewayError(undefined, "too_large");
      }

      return new Uint8Array(Buffer.from(text(accepted(value).data) ?? "", "base64"));
    },
    async expose(id, stubId, port) {
      const url = text(
        accepted(
          await call({ method: "POST", path: `${pod(id)}/ports/expose`, body: { stubId, port } }),
        ).url,
      );

      if (!url) throw new BeamGatewayError(undefined, "refused");

      return url;
    },
    async snapshot(id, stubId) {
      const checkpoint = text(
        accepted(
          await call({
            method: "POST",
            path: `${pod(id)}/snapshot-memory`,
            body: { stubId },
            mutation: true,
          }),
        ).checkpointId,
      );

      // Accepted without naming the snapshot: it may exist, so this is not a refusal.
      if (!checkpoint) throw new BeamGatewayError(undefined, "unknown");

      return checkpoint;
    },
    async ttl(id, seconds) {
      // beam-js 1.1.6 updates the lifetime with PATCH.
      accepted(await call({ method: "PATCH", path: `${pod(id)}/ttl`, body: { ttl: seconds } }));
    },
  };
}
