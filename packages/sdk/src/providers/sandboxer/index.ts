/** Sandboxer API v1 derives from Boat API v1. https://sandboxer.com/api/v1/openapi.yaml */
import { isObject, isString } from "../../shared/narrow.js";
import type { Provider } from "../../provider.js";
import type { NativeApi } from "../../native.js";
import { createDeadline, sleep, type HttpRequest } from "../../http.js";
import type {
  BoatClientSdk,
  BoatCreateOptions,
  BoatMachine,
  BoatSandboxSdk,
} from "../boat/index.js";
import { boatApi } from "../boat-api/index.js";
import { errors } from "../boat-api/errors.js";
import type { BoatPlane } from "../boat-api/transport.js";

/** `GET /regions` lists them: us-east (Ashburn, Virginia), eu-central (Helsinki). */
export type SandboxerRegion = "us-east" | "eu-central" | (string & {});

export interface SandboxerOptions extends BoatCreateOptions {
  /** Defaults to SANDBOXER_API_KEY; required on first use. */
  apiKey?: string;
  /** Default: https://sandboxer.com/api/v1. */
  baseUrl?: string;
  /** Native machine size; default: Sandboxer default (4 CPU/8 GB). Per-create size wins. */
  machine?: BoatMachine;
  /** Deadline for each control-plane request and lifecycle poll. Default: 90 seconds. */
  requestTimeoutMs?: number;
  /** Region for new sandboxes. Default: SANDBOXER_REGION, else the region
   * nearest the caller. Snapshot restores must match the snapshot's region. */
  region?: SandboxerRegion;
}

const regionSources = ["requested", "nearest", "default", "source"] as const;

export type SandboxerRegionSource = (typeof regionSources)[number];

/**
 * `box.native`: Sandboxer's HTTP API with this adapter's base URL, key, retries and redaction (plane `"api"`,
 * `{sandboxId}` fills from the sandbox), plus where the VM landed and named snapshots.
 */
export interface SandboxerNative extends NativeApi<BoatPlane, BoatSandboxSdk> {
  /** Null for sandboxes from before regions. */
  readonly region: string | null;
  readonly regionSource: SandboxerRegionSource | null;
  createSnapshot(name: string): Promise<{ id: string }>;
}

const { failure, boatError } = errors("sandboxer", "Sandboxer", "SANDBOXER_API_KEY", true);
const baseUrl = "https://sandboxer.com/api/v1";
const confirmHeader = "X-Sandboxer-Confirm-Delete";

export type SandboxerProvider = Provider<SandboxerNative, "size" | "pause" | "snapshot"> & {
  /** Sandboxer's API with no sandbox bound, for account calls such as `GET /regions`. */
  readonly api: NativeApi<BoatPlane, BoatClientSdk>;
};

/** Sandboxer through its Boat-compatible API, over plain HTTP. No other package to install. */
export function sandboxer(options: SandboxerOptions = {}): SandboxerProvider {
  const timeout = options.requestTimeoutMs ?? 90_000;
  const deletions = new Map<string, string>();
  const region = options.region ?? process.env.SANDBOXER_REGION;

  if (region !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(region))
    throw failure("Invalid Sandboxer region", "invalid_argument");
  const placements = new Map<string, Pick<SandboxerNative, "region" | "regionSource">>();

  function place(value: object) {
    if (!("id" in value) || !isString(value.id) || !("region" in value)) return;
    const name = isString(value.region) ? value.region : null;

    const source =
      "regionSource" in value
        ? (regionSources.find((source) => source === value.regionSource) ?? null)
        : null;

    placements.set(value.id, { region: name, regionSource: source });
  }

  /** Polls `path` until `ready`, inside one deadline for the whole operation. */
  async function poll(
    path: string,
    params: Record<string, string>,
    ready: (value: unknown) => boolean,
  ) {
    const deadline = createDeadline(timeout);

    for (;;) {
      if (ready(await http.json({ method: "GET", path, params, deadline }))) return;

      if (deadline.remaining() <= 0) break;

      try {
        await sleep(Math.min(250, deadline.remaining()), deadline, "sandboxer");
      } catch {
        break;
      }
    }

    throw failure("Sandboxer operation did not finish before its deadline", "timeout");
  }

  async function createSnapshot(id: string, name: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))
      throw failure("Invalid snapshot name", "invalid_argument", id);

    try {
      await http.json({
        method: "POST",
        path: "/named-snapshots",
        body: { sandboxId: id, name },
        sandboxId: id,
      });
      await poll("/named-snapshots/{name}", { name }, (value) => {
        if (!isObject(value) || value === null || !("snapshot" in value))
          throw failure("Invalid snapshot response");
        const snapshot = value.snapshot;

        if (
          !isObject(snapshot) ||
          snapshot === null ||
          !("status" in snapshot) ||
          !("name" in snapshot) ||
          snapshot.name !== name ||
          !("sourceSandboxId" in snapshot) ||
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

  const { provider: core, http } = boatApi(options, {
    name: "sandboxer",
    label: "Sandboxer",
    keyEnv: "SANDBOXER_API_KEY",
    baseUrl,
    createFrom: true,
    idleStop: true,
    pausedStates: ["archived", "stopped"],
    ...(region === undefined ? {} : { createFields: { region } }),
    observe: (sandbox) => place(sandbox.raw),
    downloadMaxBytes: 50 * 1024 * 1024,
    destroy: async (http, id) => {
      let operationId = deletions.get(id);

      if (!operationId) {
        // The spec's ConfirmDelete header must equal the sandbox ID, else 409. Boat's header rides along, as the SDK sent it.
        const value: unknown = await http.json({
          method: "DELETE",
          path: "/sandboxes/{sandboxId}",
          params: { sandboxId: id },
          sandboxId: id,
          headers: { [confirmHeader]: id, "X-Ascii-Confirm-Delete": id },
        });

        const operation = isObject(value) && "operation" in value ? value.operation : undefined;

        if (
          !isObject(operation) ||
          operation === null ||
          !("targetId" in operation) ||
          operation.targetId !== id ||
          !("kind" in operation) ||
          operation.kind !== "sandbox" ||
          !("status" in operation)
        )
          throw failure("Invalid deletion operation", "outcome_unknown", id);

        if (operation.status === "completed") return;

        if (!("id" in operation) || !isString(operation.id) || !operation.id)
          throw failure("Invalid deletion operation", "outcome_unknown", id);
        operationId = operation.id;
        deletions.set(id, operationId);
      }

      await poll("/deletion-operations/{operationId}", { operationId }, (value) => {
        if (!isObject(value) || value === null || !("operation" in value))
          throw failure("Invalid deletion response");
        const next = value.operation;

        if (
          !isObject(next) ||
          next === null ||
          !("targetId" in next) ||
          next.targetId !== id ||
          !("status" in next)
        )
          throw failure("Invalid deletion metadata");

        return next.status === "completed";
      });
      deletions.delete(id);
    },
    download: async (http, id, path) =>
      (
        await http.request({
          method: "GET",
          path: "/sandboxes/{sandboxId}/artifacts",
          params: { sandboxId: id },
          query: { path },
          sandboxId: id,
          maxBytes: 50 * 1024 * 1024 + 1,
        })
      ).body,
    // The proxy accepts its __sbx_auth cookie, whose value is the URL token.
    // Exchanging the token over HTTP fails until the port listens, and a
    // tokened URL adds a redirect to every request, so build the cookie here.
    preview: async (url) => {
      const value = new URL(url),
        token = value.searchParams.get("_token");

      if (token === null) return { url };

      if (!/^[A-Za-z0-9._~-]+$/.test(token)) throw failure("Invalid preview token");
      value.searchParams.delete("_token");

      return { url: value.toString(), headers: { Cookie: `__sbx_auth=${token}` } };
    },
    // The BoatApi client native.sdk() builds sends Boat's delete header; Sandboxer needs its own too.
    sdkConfiguration: {
      middleware: [
        {
          async pre({ url, init }: { url: string; init: RequestInit }) {
            const path = new URL(url).pathname;

            if (init.method !== "DELETE" || !/\/sandboxes\/[^/]+$/.test(path)) return undefined;
            const headers = new Headers(init.headers);
            headers.set(confirmHeader, decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)));

            return { url, init: { ...init, headers } };
          },
        },
      ],
    },
  });

  const lifecycle = (id: string, action: "stop" | "resume"): HttpRequest<BoatPlane> => ({
    method: "POST",
    path: `/sandboxes/{sandboxId}/${action}`,
    params: { sandboxId: id },
    sandboxId: id,
  });

  return {
    ...core,
    capabilities: new Set(["size", "pause", "snapshot"]),
    async pause(id) {
      await http.json(lifecycle(id, "stop"));
      await poll("/sandboxes/{sandboxId}", { sandboxId: id }, (value) => {
        if (!isObject(value) || value === null || !("sandbox" in value))
          throw failure("Invalid stop response");
        const box = value.sandbox;

        if (!isObject(box) || box === null || !("id" in box) || box.id !== id || !("stop" in box))
          throw failure("Invalid stop metadata");
        const stop = box.stop;

        if (!isObject(stop) || stop === null || !("status" in stop)) return false;

        return stop.status === "completed";
      });
    },
    async resume(id) {
      await http.json(lifecycle(id, "resume"));
      await poll("/sandboxes/{sandboxId}", { sandboxId: id }, (value) => {
        if (!isObject(value) || value === null || !("sandbox" in value))
          throw failure("Invalid resume response");
        const box = value.sandbox;

        if (!isObject(box) || box === null || !("id" in box) || box.id !== id || !("state" in box))
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
    native: (id) =>
      Object.assign(core.native(id), {
        region: null,
        regionSource: null,
        ...placements.get(id),
        createSnapshot: (name: string) => createSnapshot(id, name),
      }),
  };
}
