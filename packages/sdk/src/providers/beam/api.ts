/**
 * The parts of Beam's gateway (https://app.beam.cloud/api/v1/gateway) the adapter calls directly.
 * Shapes verified live on 2026-11-18 and against @beamcloud/beam-js 1.1.6, which calls the same
 * routes. The gateway answers most failures with HTTP 200 and `{ ok: false, errorMsg }`.
 */
import { SandboxError } from "../../errors.js";
import { createHttpClient, httpStatus, type HttpClient } from "../../http.js";
import type { HttpMethod } from "../../native.js";
import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { BeamGatewayError } from "./errors.js";

/** The gateway's routes under `/api/v1/gateway`, such as `/pods/{containerId}/exec`. */
export type BeamPlane = "gateway";

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

export interface GatewayClientOptions {
  /** The token, read per request; throws when it is missing. */
  token: () => string;
  url: string;
  fetch?: typeof fetch;
  /** Per request, retries included. */
  requestTimeoutMs: number;
}

/**
 * The SDK's HTTP client on Beam's gateway, for the adapter's own calls and `box.native`: its user
 * agent, read retries (a GET on 429, 502, 503, 504 or a network error, within the deadline), error
 * mapping and redaction.
 */
export function createGatewayClient(options: GatewayClientOptions): HttpClient<BeamPlane> {
  return createHttpClient<BeamPlane>({
    provider: "beam",
    label: "Beam",
    planes: {
      gateway: {
        baseUrl: options.url.replace(/\/+$/, "") + "/api/v1/gateway",
        auth: () => ({ Authorization: `Bearer ${options.token()}` }),
      },
    },
    defaultPlane: "gateway",
    fetch: options.fetch,
    timeoutMs: options.requestTimeoutMs,
    secrets: () => {
      try {
        return [options.token()];
      } catch {
        // No token yet: nothing to redact.
        return [];
      }
    },
    authHint: "Set BEAM_TOKEN to a valid Beam token.",
  });
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

/**
 * What a request does to Beam. `read`: nothing; the client retries it. `repeatable`: a POST or
 * PATCH that leaves the same state when sent again (connect, stop, kill, upload, expose, ttl), so a
 * lost answer fails like a read's, though it is sent once. `mutation`: restore, exec and snapshot,
 * where a lost or unclear answer may hide a change, so it is `unknown`.
 */
type Effect = "read" | "repeatable" | "mutation";

/**
 * Whether a failed write may have taken effect: an error other than the client's, a 5xx (a proxy may have forwarded it), or the
 * client's own outcome_unknown (lost after sending, the deadline, a 504), or a 2xx whose body could
 * not be read. A 4xx, or a failure before the request left the process, made nothing.
 */
function unconfirmed(error: SandboxError) {
  const status = httpStatus(error)?.status;

  if (status !== undefined) return status >= 500;

  return ["outcome_unknown", "provider", "unsupported"].includes(error.code);
}

/**
 * A gateway body that said `ok: true`. Only an explicit `ok: false` is a refusal (`missing` for a
 * gone sandbox); a body without one says nothing, which for a mutation leaves it `unknown`.
 */
function accepted(value: JsonValue | undefined, effect: Effect): JsonObject {
  if (record(value) && value.ok === true) return value;

  if (record(value) && value.ok === false) {
    const message = text(value.errorMsg) ?? "";

    throw new BeamGatewayError(undefined, missing.test(message) ? "missing" : "refused");
  }

  throw new BeamGatewayError(undefined, effect === "mutation" ? "unknown" : "malformed");
}

export function createGateway(http: HttpClient<BeamPlane>): BeamGateway {
  /** One gateway request through the shared client. Only the caller's own abort stays an abort. */
  async function call(request: {
    method: HttpMethod;
    path: string;
    effect: Effect;
    sandboxId?: string;
    params?: Record<string, string>;
    query?: Record<string, number>;
    body?: JsonObject;
    signal?: AbortSignal;
  }): Promise<JsonValue | undefined> {
    const { effect, ...rest } = request;

    try {
      return await http.json({ ...rest, readOnly: effect === "repeatable" ? true : undefined });
    } catch (error) {
      if (
        effect === "mutation" &&
        !request.signal?.aborted &&
        (!(error instanceof SandboxError) || unconfirmed(error))
      )
        throw new BeamGatewayError(httpStatus(error)?.status, "unknown");
      throw error;
    }
  }

  /** A request on one container, `/pods/{containerId}/...`. */
  const pod = (
    id: string,
    route: string,
    request: Omit<Parameters<typeof call>[0], "path" | "sandboxId" | "params"> & {
      params?: Record<string, string>;
    },
  ) =>
    call({
      ...request,
      path: `/pods/{containerId}/${route}`,
      sandboxId: id,
      params: { containerId: id, ...request.params },
    });

  return {
    async containers(signal) {
      const value = accepted(
        await call({ method: "GET", path: "/containers", effect: "read", signal }),
        "read",
      );

      const list = Array.isArray(value.containers) ? value.containers : [];

      return list.flatMap((entry) => container(entry) ?? []);
    },
    async connect(id, signal) {
      accepted(
        await pod(id, "connect", { method: "POST", body: {}, effect: "repeatable", signal }),
        "repeatable",
      );
    },
    async restore(checkpointId, signal) {
      const value = accepted(
        await call({
          method: "POST",
          path: "/pods",
          body: { checkpointId },
          effect: "mutation",
          signal,
        }),
        "mutation",
      );

      const containerId = text(value.containerId);

      // Accepted without naming the container: it may exist, so this is not a refusal.
      if (!containerId) throw new BeamGatewayError(undefined, "unknown");

      return { containerId, stubId: text(value.stubId) ?? "" };
    },
    async stop(id) {
      accepted(
        await call({
          method: "POST",
          path: "/containers/{containerId}/stop",
          sandboxId: id,
          params: { containerId: id },
          body: {},
          effect: "repeatable",
        }),
        "repeatable",
      );
    },
    async exec(id, command, signal) {
      // `wait` makes the gateway hold the request briefly and answer inline when the process
      // finishes in that window (about half a second, measured 2026-11-18).
      const value = accepted(
        await pod(id, "exec", {
          method: "POST",
          body: { command, wait: true },
          effect: "mutation",
          signal,
        }),
        "mutation",
      );

      const pid = count(value.pid);

      // Accepted without a process to follow: it may be running, so this is not a refusal.
      if (pid === undefined || pid <= 0) throw new BeamGatewayError(undefined, "unknown");
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
        await pod(id, "status", { method: "GET", query: { pid }, effect: "read", signal }),
        "read",
      );

      return count(value.exitCode) ?? -1;
    },
    async stdout(id, pid, signal) {
      const value = accepted(
        await pod(id, "stdout", { method: "GET", query: { pid }, effect: "read", signal }),
        "read",
      );

      return text(value.stdout) ?? "";
    },
    async kill(id, pid) {
      accepted(
        await pod(id, "kill", { method: "POST", body: { pid }, effect: "repeatable" }),
        "repeatable",
      );
    },
    async upload(id, path, data, mode) {
      accepted(
        await pod(id, "files/upload", {
          method: "POST",
          body: { containerPath: path, mode, data: Buffer.from(data).toString("base64") },
          effect: "repeatable",
        }),
        "repeatable",
      );
    },
    async download(id, path) {
      const value = await pod(id, "files/download/{path}", {
        method: "GET",
        params: { path },
        effect: "read",
      });

      // Only a missing path is a missing file; anything else is the gateway's failure.
      if (record(value) && value.ok === false) {
        const message = text(value.errorMsg) ?? "";

        if (/no such file or directory/.test(message)) return undefined;

        if (tooLarge.test(message)) throw new BeamGatewayError(undefined, "too_large");
      }

      return new Uint8Array(Buffer.from(text(accepted(value, "read").data) ?? "", "base64"));
    },
    async expose(id, stubId, port) {
      const url = text(
        accepted(
          await pod(id, "ports/expose", {
            method: "POST",
            body: { stubId, port },
            effect: "repeatable",
          }),
          "repeatable",
        ).url,
      );

      if (!url) throw new BeamGatewayError(undefined, "refused");

      return url;
    },
    async snapshot(id, stubId) {
      const checkpoint = text(
        accepted(
          await pod(id, "snapshot-memory", {
            method: "POST",
            body: { stubId },
            effect: "mutation",
          }),
          "mutation",
        ).checkpointId,
      );

      // Accepted without naming the snapshot: it may exist, so this is not a refusal.
      if (!checkpoint) throw new BeamGatewayError(undefined, "unknown");

      return checkpoint;
    },
    async ttl(id, seconds) {
      // beam-js 1.1.6 updates the lifetime with PATCH.
      accepted(
        await pod(id, "ttl", { method: "PATCH", body: { ttl: seconds }, effect: "repeatable" }),
        "repeatable",
      );
    },
  };
}
