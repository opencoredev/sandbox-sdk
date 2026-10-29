/** Sandboxer API v1 derives from Boat API v1. https://sandboxer.com/api/v1/openapi.yaml */
import type { CreateSandboxRequest } from "@boatdev/sdk";
import type { Provider } from "../../provider.js";
import type { BoatCreateOptions, BoatNative } from "../boat/index.js";
import { boatApi } from "../boat-api/index.js";
import { errors } from "../boat-api/errors.js";
import { isObject, isString } from "../../shared/narrow.js";

/** `GET /regions` lists them: us-east (Ashburn, Virginia), eu-central (Helsinki). */
export type SandboxerRegion = "us-east" | "eu-central" | (string & {});

export interface SandboxerOptions extends BoatCreateOptions {
  /** Defaults to SANDBOXER_API_KEY; required on first use. */
  apiKey?: string;
  /** Default: https://sandboxer.com/api/v1. */
  baseUrl?: string;
  /** Native machine size; default: Sandboxer default (4 CPU/8 GB). Per-create size wins. */
  machine?: CreateSandboxRequest["type"];
  /** Deadline for each control-plane request and lifecycle poll. Default: 90 seconds. */
  requestTimeoutMs?: number;
  /** Region for new sandboxes. Default: SANDBOXER_REGION, else the region
   * nearest the caller. Snapshot restores must match the snapshot's region. */
  region?: SandboxerRegion;
}

const regionSources = ["requested", "nearest", "default", "source"] as const;

export type SandboxerRegionSource = (typeof regionSources)[number];

export interface SandboxerNative extends BoatNative {
  /** Null for sandboxes from before regions. */
  readonly region: string | null;
  readonly regionSource: SandboxerRegionSource | null;
  createSnapshot(name: string): Promise<{ id: string }>;
}

const { failure, boatError } = errors("sandboxer", "Sandboxer", "SANDBOXER_API_KEY", true);

/** A JSON value from the Sandboxer API. */
type Json = string | number | boolean | null | Json[] | JsonObject;

type JsonObject = { [key: string]: Json };

function isJsonObject(value: Json | undefined): value is JsonObject {
  return isObject(value) && !Array.isArray(value);
}

const baseUrl = "https://sandboxer.com/api/v1";

export type SandboxerProvider = Provider<SandboxerNative, "size" | "pause" | "snapshot">;

/** Sandboxer through its Boat-compatible API; loads @boatdev/sdk on first use. */
export function sandboxer(options: SandboxerOptions = {}): SandboxerProvider {
  const timeout = options.requestTimeoutMs ?? 90_000;
  const deletions = new Map<string, string>();
  const region = options.region ?? process.env.SANDBOXER_REGION;

  if (region !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(region))
    throw failure("Invalid Sandboxer region", "invalid_argument");
  // The Boat SDK's serializers drop region fields, so add and read them here.
  const placements = new Map<string, Pick<SandboxerNative, "region" | "regionSource">>();

  function place(value: JsonObject) {
    if (!isString(value.id) || !("region" in value)) return;
    const name = isString(value.region) ? value.region : null;

    const source =
      "regionSource" in value
        ? (regionSources.find((source) => source === value.regionSource) ?? null)
        : null;

    placements.set(value.id, { region: name, regionSource: source });
  }

  async function request(
    path: string,
    method = "GET",
    body?: Json,
    timeoutMs = timeout,
  ): Promise<Json> {
    const key = options.apiKey ?? process.env.SANDBOXER_API_KEY;

    if (!key)
      throw failure(
        "Sandboxer API key is missing. Authentication is required. Set SANDBOXER_API_KEY or pass apiKey.",
        "auth",
      );

    try {
      const init: RequestInit = {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      };

      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await fetch(`${options.baseUrl ?? baseUrl}${path}`, init);

      if (!response.ok) {
        // An unreadable error body only means there is no API code to report.
        const envelope: Json | undefined = await response.json().catch(() => undefined);
        const apiCode = isJsonObject(envelope) ? envelope.code : undefined;

        throw { response, apiCode };
      }

      return await response.json();
    } catch (error) {
      throw boatError(error);
    }
  }

  async function poll(path: string, ready: (value: Json) => boolean) {
    const end = performance.now() + timeout;

    while (performance.now() < end) {
      if (
        ready(
          await request(path, "GET", undefined, Math.max(1, Math.ceil(end - performance.now()))),
        )
      )
        return;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, Math.max(1, Math.ceil(end - performance.now())))),
      );
    }

    throw failure("Sandboxer operation did not finish before its deadline", "timeout");
  }

  async function createSnapshot(id: string, name: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))
      throw failure("Invalid snapshot name", "invalid_argument", id);

    try {
      await request("/named-snapshots", "POST", { sandboxId: id, name });
      await poll(`/named-snapshots/${encodeURIComponent(name)}`, (value) => {
        if (!isJsonObject(value) || !("snapshot" in value))
          throw failure("Invalid snapshot response");
        const snapshot = value.snapshot;

        if (
          !isJsonObject(snapshot) ||
          !("status" in snapshot) ||
          snapshot.name !== name ||
          snapshot.sourceSandboxId !== id
        )
          throw failure("Invalid snapshot metadata");

        if (snapshot.status === "failed")
          throw failure("Sandboxer snapshot failed", "provider", id);

        return snapshot.status === "ready";
      });

      return { id: name };
    } catch (error) {
      throw failure(
        `Sandboxer snapshot ${name} did not complete; inspect this name before retrying`,
        boatError(error, id).code,
        id,
      );
    }
  }

  const core = boatApi(options, {
    name: "sandboxer",
    label: "Sandboxer",
    keyEnv: "SANDBOXER_API_KEY",
    baseUrl,
    createFrom: true,
    idleStop: true,
    pausedStates: ["archived", "stopped"],
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);

      const href = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
      const path = new URL(href).pathname;

      if (init?.method === "DELETE" && /\/sandboxes\/[^/]+$/.test(path))
        headers.set(
          "X-Sandboxer-Confirm-Delete",
          decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)),
        );
      let body = init?.body;

      if (region !== undefined && init?.method === "POST" && path.endsWith("/sandboxes")) {
        if (!isString(body)) throw failure("Sandboxer create body is not JSON", "provider");
        const request: Json = JSON.parse(body);

        if (!isJsonObject(request))
          throw failure("Sandboxer create body is not an object", "provider");
        body = JSON.stringify({ ...request, region });
      }

      const response = await fetch(url, { ...init, headers, body });

      if (response.ok && init?.method !== "DELETE" && /\/sandboxes(\/[^/]+)?$/.test(path)) {
        // A body that is not JSON carries no placement; the response still goes to the SDK.
        const value: Json | undefined = await response
          .clone()
          .json()
          .catch(() => undefined);

        if (isJsonObject(value)) {
          if (isJsonObject(value.sandbox)) place(value.sandbox);

          if (Array.isArray(value.sandboxes))
            for (const item of value.sandboxes) if (isJsonObject(item)) place(item);
        }
      }

      return response;
    },
    downloadMaxBytes: 50 * 1024 * 1024,
    destroy: async (api, id) => {
      let operationId = deletions.get(id);

      if (!operationId) {
        const { operation } = await api.deleteSandbox({ sandboxId: id, xAsciiConfirmDelete: id });

        if (operation.targetId !== id || operation.kind !== "sandbox")
          throw failure("Invalid deletion operation", "outcome_unknown", id);

        if (operation.status === "completed") return;
        operationId = operation.id;
        deletions.set(id, operationId);
      }

      await poll(`/deletion-operations/${encodeURIComponent(operationId)}`, (value) => {
        if (!isJsonObject(value) || !("operation" in value))
          throw failure("Invalid deletion response");
        const next = value.operation;

        if (!isJsonObject(next) || next.targetId !== id || !("status" in next))
          throw failure("Invalid deletion metadata");

        return next.status === "completed";
      });
      deletions.delete(id);
    },
    download: async (api, id, path) =>
      new Uint8Array(await (await api.artifact({ sandboxId: id, path })).arrayBuffer()),
    // The proxy accepts its __sbx_auth cookie, whose value is the URL token.
    // Exchanging the token over HTTP fails until the port listens, and a
    // tokened URL adds a redirect to every request, so build the cookie here.
    preview: async (url) => {
      const value = new URL(url);
      const token = value.searchParams.get("_token");

      if (token === null) return { url };

      if (!/^[A-Za-z0-9._~-]+$/.test(token)) throw failure("Invalid preview token");
      value.searchParams.delete("_token");

      return { url: value.toString(), headers: { Cookie: `__sbx_auth=${token}` } };
    },
  });

  return {
    ...core,
    capabilities: new Set(["size", "pause", "snapshot"]),
    async pause(id) {
      await request(`/sandboxes/${encodeURIComponent(id)}/stop`, "POST");
      await poll(`/sandboxes/${encodeURIComponent(id)}`, (value) => {
        if (!isJsonObject(value) || !("sandbox" in value)) throw failure("Invalid stop response");
        const box = value.sandbox;

        if (!isJsonObject(box) || box.id !== id || !("stop" in box))
          throw failure("Invalid stop metadata");
        const stop = box.stop;

        if (!isJsonObject(stop) || !("status" in stop)) return false;

        return stop.status === "completed";
      });
    },
    async resume(id) {
      await request(`/sandboxes/${encodeURIComponent(id)}/resume`, "POST");
      await poll(`/sandboxes/${encodeURIComponent(id)}`, (value) => {
        if (!isJsonObject(value) || !("sandbox" in value)) throw failure("Invalid resume response");
        const box = value.sandbox;

        if (!isJsonObject(box) || box.id !== id || !("state" in box))
          throw failure("Invalid resume metadata");

        return box.state === "ready";
      });
      await core.connect(id);
    },
    async snapshot(id, settings = {}) {
      // Named snapshots live until deleted; 0 asks for exactly that.
      if (settings.expiresInMs !== undefined && settings.expiresInMs !== 0)
        throw failure(
          "Sandboxer named snapshots never expire; expiresInMs is unsupported. Delete the snapshot yourself",
          "unsupported",
          id,
        );

      return createSnapshot(id, `sdk-${crypto.randomUUID()}`);
    },
    native: (id) => ({
      ...core.native(id),
      region: null,
      regionSource: null,
      ...placements.get(id),
      createSnapshot: (name) => createSnapshot(id, name),
    }),
  };
}
