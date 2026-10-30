/**
 * Freestyle's public API over fetch, following https://api.freestyle.sh/openapi.json and the behaviour of the
 * freestyle 0.2.20 SDK it replaces:
 *
 * - Every call except file reads asks the API to background itself after 5 s. A `202 Accepted` is polled every
 *   2 s at its `resultUrl` (or `/v5/background-requests/{id}`) until the stored response is ready. Failed polls
 *   (network errors, or 408/429/502/503/504 without a background request ID) are retried for 5 minutes. A GET
 *   whose result was too large to store (`BACKGROUND_RESULT_UNSTORABLE`) is fetched once more directly.
 * - Writes over 8 MiB use an upload session: 16 MiB chunks, each tried 5 times, with the session re-read after a
 *   failure to see whether the chunk landed.
 * - Every request and poll of one adapter operation shares its deadline (see deadline.ts).
 */
import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isString } from "../../shared/narrow.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { SandboxError } from "../../errors.js";
import {
  createDeadline,
  createHttpClient,
  sleep,
  type Deadline,
  type HttpClient,
  type HttpFailure,
  type HttpRequest,
  type HttpResponse,
} from "../../http.js";
import { operationSignal } from "./deadline.js";
import { FreestyleApiError, failure, recordRequest, recordResponse, statusCode } from "./errors.js";

/** Freestyle has one API surface. */
export type FreestylePlane = "api";

export const defaultBaseUrl = "https://api.freestyle.sh";
const backgroundAfterHeader = "x-freestyle-background-after-secs";
const backgroundIdHeader = "x-freestyle-background-request-id";

/** Timings of freestyle 0.2.20's background-request client. Mutable only so tests can shorten them. */
export const background = { afterSecs: 5, pollMs: 2_000, unavailableMs: 5 * 60_000, hopMs: 30_000 };
const transientPollStatuses = new Set([408, 429, 502, 503, 504]);
const resumableBytes = 8 * 1024 * 1024;
const chunkBytes = 16 * 1024 * 1024;
const chunkAttempts = 5;
const octet = { "content-type": "application/octet-stream" };

/** Whole-file reads are not capped by the client's 32 MiB buffer default; the SDK had no cap. */
const maxReadBytes = 2 ** 32;

/** The VM record fields the adapter reads. */
export interface VmData {
  id: string;
  state: string;
  metadata: Record<string, string>;
  createdAt: string;
  idleTimeoutSeconds?: number | null;
  ttlSeconds?: number | null;
  autoDeleteSeconds?: number | null;
  vpcs?: unknown[];
}

export interface FirewallRule {
  action: string;
  source: JsonObject;
  destination: JsonObject;
}

export interface CreatedVm {
  data: VmData;
  firewallRules: FirewallRule[];
  tlsRules: unknown[];
}

export interface ExecResponse {
  statusCode: number | null;
  stdout?: string | null;
  stderr?: string | null;
}

interface UploadStatus {
  uploadId: string;
  receivedBytes: number;
}

/** Where a failed request's HTTP failure is kept for the error hook to read. */
interface FailureSlot {
  failure?: HttpFailure;
}

const isRecord = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function unexpected(what: string, sandboxId?: string): never {
  throw failure(`Freestyle returned an unexpected ${what}`, "provider", sandboxId);
}

function optionalNumber(value: JsonValue | undefined): value is number | null | undefined {
  return value === undefined || value === null || typeof value === "number";
}

export function vmData(value: JsonValue | undefined, sandboxId?: string): VmData {
  if (!isRecord(value) || !isString(value.id) || !isString(value.state))
    unexpected("VM record", sandboxId);
  const metadata: Record<string, string> = {};

  if (value.metadata !== undefined && value.metadata !== null) {
    if (!isRecord(value.metadata)) unexpected("VM record", sandboxId);

    for (const [k, v] of Object.entries(value.metadata))
      if (isString(v)) Object.defineProperty(metadata, k, { value: v, enumerable: true });
  }

  const { idleTimeoutSeconds, ttlSeconds, autoDeleteSeconds, vpcs, createdAt } = value;

  if (
    !optionalNumber(idleTimeoutSeconds) ||
    !optionalNumber(ttlSeconds) ||
    !optionalNumber(autoDeleteSeconds) ||
    (vpcs !== undefined && !Array.isArray(vpcs)) ||
    (createdAt !== undefined && !isString(createdAt))
  )
    unexpected("VM record", sandboxId);

  return {
    id: value.id,
    state: value.state,
    metadata,
    createdAt: createdAt ?? "",
    ...(idleTimeoutSeconds === undefined ? undefined : { idleTimeoutSeconds }),
    ...(ttlSeconds === undefined ? undefined : { ttlSeconds }),
    ...(autoDeleteSeconds === undefined ? undefined : { autoDeleteSeconds }),
    ...(vpcs === undefined ? undefined : { vpcs }),
  };
}

function firewallRules(value: JsonValue | undefined): FirewallRule[] {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) unexpected("firewall rule list");

  return value.map((rule: JsonValue | undefined) => {
    if (
      !isRecord(rule) ||
      !isString(rule.action) ||
      !isRecord(rule.source) ||
      !isRecord(rule.destination)
    )
      unexpected("firewall rule");

    return { action: rule.action, source: rule.source, destination: rule.destination };
  });
}

function execResponse(value: JsonValue | undefined, sandboxId: string): ExecResponse {
  if (
    !isRecord(value) ||
    !optionalNumber(value.statusCode) ||
    (value.stdout !== undefined && value.stdout !== null && !isString(value.stdout)) ||
    (value.stderr !== undefined && value.stderr !== null && !isString(value.stderr))
  )
    unexpected("command result", sandboxId);

  return { statusCode: value.statusCode ?? null, stdout: value.stdout, stderr: value.stderr };
}

function uploadStatus(value: JsonValue | undefined, sandboxId: string): UploadStatus {
  if (!isRecord(value) || !isString(value.uploadId) || !Number.isSafeInteger(value.receivedBytes))
    unexpected("upload session", sandboxId);

  return { uploadId: value.uploadId, receivedBytes: Number(value.receivedBytes) };
}

const text = (value: JsonValue | undefined, key: string) => {
  const found = isRecord(value) ? value[key] : undefined;

  return isString(found) && found ? found : undefined;
};

export interface FreestyleClientOptions {
  baseUrl: string;
  /** Validates the configuration and returns the API key; throws the `auth` error when it is missing. */
  apiKey: () => string;
  /** Deadline for calls outside an adapter operation (native calls). */
  requestTimeoutMs: number;
}

/** An adapter request: the operation's shared deadline is applied, so no signal or timeout of its own. */
type Call = Omit<HttpRequest<FreestylePlane>, "deadline" | "signal" | "timeoutMs" | "plane">;

export function freestyleClient(options: FreestyleClientOptions) {
  // The failure behind the error the client is about to throw, per request, so the adapter can rebuild the
  // SDK-shaped status error its evidence and classification rely on.
  const failures = new AsyncLocalStorage<{ failure?: HttpFailure }>();
  let key: string | undefined;

  const credentials = () => {
    key = options.apiKey();

    return { authorization: `Bearer ${key}` };
  };

  const http: HttpClient<FreestylePlane> = createHttpClient<FreestylePlane>({
    provider: "freestyle",
    label: "Freestyle",
    defaultPlane: "api",
    planes: { api: { baseUrl: options.baseUrl, auth: credentials } },
    timeoutMs: options.requestTimeoutMs,
    // The bare key too: the client only remembers the whole `Bearer …` header value.
    secrets: () => [process.env.FREESTYLE_API_KEY, key],
    authHint: "Set FREESTYLE_API_KEY to a valid Freestyle API key, or pass apiKey.",
    async fetch(input, init) {
      recordRequest(input, init.method, key);
      const response = await globalThis.fetch(input, init);

      if (key !== undefined) recordResponse(response, key);

      return response;
    },
    mapError(failed) {
      const slot = failures.getStore();

      if (slot) slot.failure = failed;

      return failed.kind === "status" ? statusCode(failed.status, failed.body.message) : undefined;
    },
  });

  async function send(request: HttpRequest<FreestylePlane>): Promise<HttpResponse> {
    const slot: FailureSlot = {};

    try {
      return await failures.run(slot, () => http.request(request));
    } catch (error) {
      const failed = slot.failure;

      if (failed?.kind !== "status") throw error;
      throw new FreestyleApiError(
        failed.status,
        failed.body.code,
        failed.body.message,
        request.path,
        failed.headers.get(backgroundIdHeader) ?? undefined,
      );
    }
  }

  const current = (): Deadline =>
    operationSignal.getStore() ?? createDeadline(options.requestTimeoutMs);

  const transient = (cause: unknown) =>
    cause instanceof FreestyleApiError
      ? transientPollStatuses.has(cause.status) && cause.backgroundRequestId === undefined
      : cause instanceof SandboxError && (cause.code === "unavailable" || cause.code === "timeout");

  async function poll(
    accepted: HttpResponse,
    path: string,
    deadline: Deadline,
  ): Promise<HttpResponse> {
    let body: JsonValue | undefined;

    try {
      body = accepted.json();
    } catch {
      body = undefined;
    }

    const requestId = accepted.headers.get(backgroundIdHeader) ?? text(body, "requestId");

    const resultPath =
      text(body, "resultUrl") ??
      (requestId === undefined
        ? undefined
        : `/v5/background-requests/${encodeURIComponent(requestId)}`);

    // A server URL is never a template: braces would be read as placeholders.
    if (resultPath === undefined || /[{}]/.test(resultPath))
      throw new FreestyleApiError(
        accepted.status,
        "BACKGROUND_PROTOCOL_ERROR",
        "202 Accepted carried no background request id",
        path,
      );
    let unavailableSince: number | undefined;

    for (;;) {
      await sleep(background.pollMs, deadline, "freestyle");

      try {
        const hop = createDeadline(
          Math.min(background.hopMs, deadline.remaining()),
          deadline.signal,
        );

        const response = await send({ method: "GET", path: resultPath, deadline: hop });

        if (response.status !== 202) return response;
        unavailableSince = undefined;
      } catch (error) {
        // A stored terminal response, success or error, is the call's own result.
        if (deadline.signal.aborted || !transient(error)) throw error;
        unavailableSince ??= Date.now();

        if (Date.now() - unavailableSince >= background.unavailableMs) throw error;
      }
    }
  }

  /** Sends a backgroundable request and follows a 202 to the stored result. */
  async function call(request: Call): Promise<HttpResponse> {
    const deadline = current();
    const direct = { ...request, deadline };

    const response = await send({
      ...direct,
      headers: { ...request.headers, [backgroundAfterHeader]: String(background.afterSecs) },
    });

    if (response.status !== 202) return response;

    try {
      return await poll(response, request.path, deadline);
    } catch (error) {
      // The slow part (waking the VM) is done; only the result was too large to keep. Fetch it plainly.
      if (
        request.method === "GET" &&
        error instanceof FreestyleApiError &&
        error.code === "BACKGROUND_RESULT_UNSTORABLE"
      )
        return await send(direct);
      throw error;
    }
  }

  const vm = (id: string) => ({ params: { id }, sandboxId: id });

  async function putChunk(
    id: string,
    upload: string,
    chunk: Uint8Array,
    offset: number,
  ): Promise<UploadStatus> {
    const target = {
      path: "/v5/vms/{id}/fs/uploads/{upload}",
      params: { id, upload },
      sandboxId: id,
    };

    for (let attempt = 1; ; attempt++) {
      try {
        return uploadStatus(
          (
            await call({ ...target, method: "PUT", query: { offset }, body: chunk, headers: octet })
          ).json(),
          id,
        );
      } catch (error) {
        const retryable =
          error instanceof FreestyleApiError
            ? error.status >= 500 ||
              error.status === 408 ||
              error.status === 409 ||
              error.status === 429
            : transient(error);

        const deadline = current();

        if (!retryable || deadline.signal.aborted || attempt >= chunkAttempts) throw error;
        await sleep(Math.min(500 * 2 ** (attempt - 1), 8000), deadline, "freestyle");

        // The server counts only whole stored chunks, so the session says whether this one landed.
        const status = await call({ ...target, method: "GET" }).then(
          (r) => uploadStatus(r.json(), id),
          () => undefined,
        );

        if (status && status.receivedBytes > offset) return status;
      }
    }
  }

  return {
    http,
    async createVm(body: JsonObject): Promise<CreatedVm> {
      const value: JsonValue | undefined = (
        await call({ method: "POST", path: "/v5/vms", body })
      ).json();

      const data = vmData(value);

      return {
        data,
        firewallRules: firewallRules(isRecord(value) ? value.firewallRules : undefined),
        tlsRules: isRecord(value) && Array.isArray(value.tlsRules) ? value.tlsRules : [],
      };
    },
    async listVms(limit: number, offset: number): Promise<{ vms: VmData[]; totalCount: number }> {
      const value: JsonValue | undefined = (
        await call({ method: "GET", path: "/v5/vms", query: { limit, offset } })
      ).json();

      if (!isRecord(value) || !Array.isArray(value.vms) || !Number.isSafeInteger(value.totalCount))
        unexpected("VM list");

      return {
        vms: value.vms.map((v: JsonValue | undefined) => vmData(v)),
        totalCount: Number(value.totalCount),
      };
    },
    async getVm(id: string): Promise<VmData> {
      return vmData((await call({ method: "GET", path: "/v5/vms/{id}", ...vm(id) })).json(), id);
    },
    async deleteVm(id: string): Promise<void> {
      await call({ method: "DELETE", path: "/v5/vms/{id}", ...vm(id) });
    },
    async exec(
      id: string,
      body: { command: string; stdin?: string; timeoutMs: number },
    ): Promise<ExecResponse> {
      return execResponse(
        (
          await call({
            method: "POST",
            path: "/v5/vms/{id}/exec-await",
            ...vm(id),
            body: { ...body, linuxUser: "root" },
          })
        ).json(),
        id,
      );
    },
    async lifecycle(id: string, action: "pause" | "start"): Promise<void> {
      await call({ method: "POST", path: `/v5/vms/{id}/${action}`, ...vm(id), body: {} });
    },
    async snapshot(id: string, body: { ttlSeconds?: number }): Promise<string> {
      const value: JsonValue | undefined = (
        await call({ method: "POST", path: "/v5/vms/{id}/snapshot", ...vm(id), body })
      ).json();

      const snapshotId = text(value, "snapshotId");

      if (snapshotId === undefined) unexpected("snapshot result", id);

      return snapshotId;
    },
    async createTlsRule(body: JsonObject): Promise<{ domain: string }> {
      const domain = text((await call({ method: "POST", path: "/v5/tls", body })).json(), "domain");

      if (domain === undefined) unexpected("TLS rule");

      return { domain };
    },
    /** `GET fs/read`, never backgrounded (as in the SDK); a range becomes `Range: bytes=start-end`. */
    async readFile(
      id: string,
      path: string,
      range?: { offset: number; length: number },
    ): Promise<Uint8Array> {
      const headers = range
        ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
        : undefined;

      const response = await send({
        method: "GET",
        path: "/v5/vms/{id}/fs/read",
        ...vm(id),
        query: { path },
        deadline: current(),
        maxBytes: maxReadBytes,
        ...(headers ? { headers } : undefined),
      });

      return response.body;
    },
    async writeFile(id: string, path: string, bytes: Uint8Array, mode?: number): Promise<void> {
      const sha256 = createHash("sha256").update(bytes).digest("hex");

      if (bytes.byteLength <= resumableBytes) {
        await call({
          method: "PUT",
          path: "/v5/vms/{id}/fs/write",
          ...vm(id),
          query: { path, mode, sha256 },
          body: bytes,
          headers: octet,
        });

        return;
      }

      const size = bytes.byteLength;

      const session = uploadStatus(
        (
          await call({
            method: "POST",
            path: "/v5/vms/{id}/fs/uploads",
            ...vm(id),
            body: { path, size, sha256, ...(mode === undefined ? undefined : { mode }) },
          })
        ).json(),
        id,
      );

      const params = { id, upload: session.uploadId };

      try {
        let offset = session.receivedBytes;

        while (offset < size) {
          const next = (
            await putChunk(
              id,
              session.uploadId,
              bytes.subarray(offset, Math.min(offset + chunkBytes, size)),
              offset,
            )
          ).receivedBytes;

          if (next <= offset) throw failure("Freestyle upload made no progress", "provider", id);
          offset = next;
        }

        await call({
          method: "POST",
          path: "/v5/vms/{id}/fs/uploads/{upload}/commit",
          params,
          sandboxId: id,
          body: {},
        });
      } catch (error) {
        // Free the server-side spool; the original failure is what the caller sees.
        await http
          .cleanup({
            method: "DELETE",
            path: "/v5/vms/{id}/fs/uploads/{upload}",
            params,
            sandboxId: id,
          })
          .catch(() => {});
        throw error;
      }
    },
  };
}

export type FreestyleClient = ReturnType<typeof freestyleClient>;
