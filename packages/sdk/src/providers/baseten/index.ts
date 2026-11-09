/**
 * Baseten Sandboxes over their HTTP API, with no SDK dependency; https://docs.baseten.co/sandboxes/overview.
 * Two planes, both authenticated with a short-lived sandbox access token minted from the API key
 * (`POST /v1/token`, scope `sandboxes`) and sent as `Authorization: Bearer`:
 * - `api`: the management API (`https://api.baseten.co`): sandboxes, previews and preview tokens.
 * - `sandbox`: each sandbox's own execution API at its `url`: processes and files.
 */
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import type {
  CreateInput,
  FileInfo,
  Preview,
  Provider,
  ProviderFiles,
  SandboxInfo,
} from "../../provider.js";
import { invalid } from "../../errors.js";
import {
  createDeadline,
  createHttpClient,
  httpStatus,
  sleep,
  type HttpClient,
} from "../../http.js";
import { createNativeApi, type NativeApi } from "../../native.js";
import { basetenError, failure } from "./errors.js";
import { execute, type BasetenPlane } from "./exec.js";

export type { BasetenPlane };

export interface BasetenOptions {
  /** Baseten API key. Defaults to BASETEN_API_KEY; required on first use. */
  apiKey?: string;
  /** Team ID, for keys with access to several teams. Defaults to BASETEN_TEAM_ID. */
  teamId?: string;
  /** Region such as `us-pdx-1` or `eu-fra-1`. Defaults to BASETEN_SANDBOX_REGION, then Baseten's default region. */
  region?: string;
  /** Sandbox image. Default: `baseten/ts-app:latest` (Debian with Node, npm and Git). */
  image?: string;
  /** Memory in MB, 1024 to 262144; Baseten gives one vCPU per 2048 MB. Default: 4096 (2 vCPU). A `size` at create wins. */
  memoryMb?: number;
  /** Management API URL. Defaults to BASETEN_API_URL, then https://api.baseten.co. */
  baseUrl?: string;
  /** Native request deadline. Default: 60 s. Commands use their run timeout. */
  requestTimeoutMs?: number;
  /** `private` previews carry a token in their URL; `public` URLs need none. Default: `private`. */
  previewAccess?: "private" | "public";
  /** Lifetime of private preview tokens. Default: one hour. */
  previewTokenTtlMs?: number;
}

/** `box.native`. `{sandboxName}` in a path fills from the sandbox. */
export type BasetenNative = NativeApi<BasetenPlane>;

/** `provider.api`: the management API with no sandbox bound. Use `box.native` for the `sandbox` plane. */
export type BasetenApi = NativeApi<BasetenPlane>;

export type BasetenProvider = Provider<BasetenNative, "size"> & {
  /** Account-level calls: `provider.api.request("GET", "/v1/sandboxes/instances")`. */
  readonly api: BasetenApi;
};

const sdkLabel = "sandbox-sdk";
const keyLabel = "sandbox-sdk-key";
const defaultImage = "baseten/ts-app:latest";
/** A deleted sandbox keeps its record for a while in one of these states. */
const gone = new Set(["DELETING", "TERMINATED"]);
const readyPollMs = 250;
/** Mint a new access token this long before the current one expires. */
const tokenMarginMs = 5 * 60_000;

interface NativeInfo {
  name: string;
  status: string;
  createdAt: number;
  labels: Record<string, string>;
  url?: string;
}

const field = (raw: JsonValue | undefined, key: string): JsonValue | undefined =>
  isJsonObject(raw) ? raw[key] : undefined;

function parseInfo(raw: JsonValue | undefined, sandboxId?: string): NativeInfo {
  const name = field(raw, "name"),
    status = field(raw, "status"),
    created = field(raw, "created_at"),
    url = field(raw, "url"),
    rawLabels = field(raw, "labels");

  if (!isString(name) || !name || !isString(status))
    throw failure("Baseten returned a sandbox without a name or status", "provider", sandboxId);
  const labels: Record<string, string> = {};

  if (isJsonObject(rawLabels))
    for (const [key, value] of Object.entries(rawLabels)) if (isString(value)) labels[key] = value;

  return {
    name,
    status,
    createdAt: isString(created) ? Date.parse(created) || 0 : 0,
    labels,
    url: isString(url) && url ? url : undefined,
  };
}

function info(v: NativeInfo): SandboxInfo {
  if (v.labels[sdkLabel] !== "1" || gone.has(v.status))
    throw failure("Sandbox does not exist or was not created by this SDK", "not_found", v.name);
  const labels = { ...v.labels };
  delete labels[keyLabel];

  return {
    id: v.name,
    key: v.labels[keyLabel],
    labels,
    createdAt: v.createdAt,
    // DEACTIVATED is standby: the next request wakes it.
    state: v.status === "FAILED" ? "stopped" : "running",
  };
}

/** Joins an absolute sandbox path for `/filesystem/{path}`; relative paths would resolve against the API's root. */
function absolute(path: string, id: string) {
  if (!path.startsWith("/") || path.split("/").includes(".."))
    throw failure("File paths must be absolute without .. segments", "invalid_argument", id);

  return path;
}

const parent = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf("/")));

/** Baseten derives CPU from memory, one vCPU per 2048 MB, so a size is its memory. */
const presets = { small: 2048, medium: 4096, large: 8192 };

function memoryFor(size: CreateInput["size"]): number | undefined {
  if (size === undefined) return undefined;

  if (isString(size)) return presets[size];

  if (
    Number.isSafeInteger(size.cpu) &&
    size.cpu > 0 &&
    size.memoryMb === size.cpu * 2048 &&
    size.memoryMb <= 262_144 &&
    size.diskGb === undefined
  )
    return size.memoryMb;
  throw failure(
    "Custom sizes need a whole number of vCPUs, memoryMb equal to 2048 per vCPU (at most 262144), and no diskGb; Baseten derives CPU from memory and has no disk setting",
    "unsupported",
  );
}

/** Milliseconds as a Baseten duration: whole seconds, rounded up. */
const duration = (ms: number) => `${Math.ceil(ms / 1000)}s`;

export function baseten(options: BasetenOptions = {}): BasetenProvider {
  const urls = new Map<string, string>();
  const timeout = options.requestTimeoutMs ?? 60_000;
  const previewAccess = options.previewAccess ?? "private";
  const tokenTtl = options.previewTokenTtlMs ?? 3_600_000;
  const memory = options.memoryMb ?? 4096;

  if (previewAccess !== "private" && previewAccess !== "public")
    invalid("previewAccess must be private or public");

  if (!Number.isSafeInteger(memory) || memory < 1024 || memory > 262_144)
    invalid("memoryMb must be an integer from 1024 to 262144");

  if (!Number.isSafeInteger(tokenTtl) || tokenTtl <= 0)
    invalid("previewTokenTtlMs must be a positive integer");

  function config() {
    const apiKey = options.apiKey ?? process.env.BASETEN_API_KEY;

    if (!apiKey?.trim())
      throw failure(
        "Baseten API key is missing. Authentication is required. Set BASETEN_API_KEY or pass apiKey.",
        "auth",
      );

    return {
      apiKey,
      teamId: (options.teamId ?? process.env.BASETEN_TEAM_ID)?.trim() || undefined,
      baseUrl:
        (options.baseUrl ?? process.env.BASETEN_API_URL)?.trim().replace(/\/+$/, "") ||
        "https://api.baseten.co",
      region: (options.region ?? process.env.BASETEN_SANDBOX_REGION)?.trim() || undefined,
    };
  }

  // One access token for every sandbox of this provider, shared by concurrent callers.
  let token: { value: string; expiresAt: number } | undefined;
  let minting: Promise<string> | undefined;

  async function accessToken(signal: AbortSignal): Promise<string> {
    if (token && Date.now() < token.expiresAt - tokenMarginMs) return token.value;
    minting ??= (async () => {
      const { apiKey, teamId } = config();
      const minted = await http.json({
        method: "POST",
        path: "/v1/token",
        auth: false,
        // Minting changes nothing a caller could double: a lost response is safe to repeat.
        readOnly: true,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(teamId ? { "x-team-id": teamId } : {}),
        },
        body: { scopes: ["sandboxes"] },
        signal,
      });
      const value = field(minted, "token"),
        expires = field(minted, "expires_at");

      if (!isString(value) || !value)
        throw failure("Baseten returned an access token response without a token", "auth");
      token = {
        value,
        expiresAt: (isString(expires) && Date.parse(expires)) || Date.now() + 60 * 60_000,
      };

      return value;
    })().finally(() => {
      minting = undefined;
    });

    return minting;
  }

  const credentials = async (context: { signal: AbortSignal }) => {
    const { teamId } = config();

    return {
      Authorization: `Bearer ${await accessToken(context.signal)}`,
      ...(teamId ? { "X-Team-Id": teamId } : {}),
    };
  };

  // A 401 means the token expired or was revoked: drop it, and the retry mints a new one.
  const refresh = async () => {
    token = undefined;
  };

  async function safe<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw basetenError(error, id);
    }
  }

  const http: HttpClient<BasetenPlane> = createHttpClient<BasetenPlane>({
    provider: "baseten",
    label: "Baseten",
    defaultPlane: "api",
    timeoutMs: timeout,
    secrets: () => [options.apiKey, process.env.BASETEN_API_KEY, token?.value],
    authHint: "Set BASETEN_API_KEY to a valid Baseten API key.",
    // A missing path on the sandbox's filesystem API is a missing file, not a missing sandbox.
    mapError: (failed, request) =>
      failed.kind === "status" &&
      failed.status === 404 &&
      request.plane === "sandbox" &&
      request.operation.includes(" /filesystem/")
        ? "file_not_found"
        : undefined,
    planes: {
      api: { baseUrl: () => config().baseUrl, auth: credentials, refresh },
      sandbox: {
        async baseUrl(context): Promise<string> {
          const id = context.sandboxId;

          if (id === undefined)
            invalid(
              "The Baseten sandbox plane needs a sandbox. Use box.native instead of provider.api",
            );
          const known = urls.get(id);

          if (known) return known;
          const url = parseInfo(await getRaw(id, context.signal), id).url;

          if (!url) throw failure("Baseten returned a sandbox without a URL", "provider", id);
          urls.set(id, url);

          return url;
        },
        auth: credentials,
        refresh,
      },
    },
  });

  const sandbox = (id: string) => ({ params: { sandboxName: id }, sandboxId: id });
  const instance = "/v1/sandboxes/instances/{sandboxName}";

  const getRaw = (id: string, signal?: AbortSignal): Promise<JsonValue | undefined> =>
    http.json({ method: "GET", path: instance, ...sandbox(id), signal });

  async function getInfo(id: string) {
    const value = parseInfo(await getRaw(id), id);

    if (value.url) urls.set(id, value.url);

    return value;
  }

  async function listNative() {
    const all: NativeInfo[] = [];
    let cursor: string | undefined;

    for (;;) {
      const raw = await http.json({
        method: "GET",
        path: "/v1/sandboxes/instances",
        query: { cursor, limit: 100 },
      });
      const items = field(raw, "items");

      if (!Array.isArray(items))
        throw failure("Baseten returned a sandbox list that is not an array");
      all.push(...items.map((item) => parseInfo(item)));
      const pagination = field(raw, "pagination"),
        next = field(pagination, "cursor");

      if (field(pagination, "has_more") !== true || !isString(next) || !next) return all;
      cursor = next;
    }
  }

  const fs = (id: string, path: string) => ({
    path: "/filesystem/{path}",
    params: { path: absolute(path, id) },
    plane: "sandbox" as const,
    sandboxId: id,
  });

  /** A directory listing as the execution API returns it: files with size and time, subdirectories with neither. */
  async function listing(id: string, path: string): Promise<FileInfo[] | undefined> {
    const raw = await http.json({ method: "GET", ...fs(id, path) });

    const files = field(raw, "files"),
      directories = field(raw, "subdirectories");

    if (!Array.isArray(files) || !Array.isArray(directories)) return undefined;
    const entries: FileInfo[] = [];

    for (const item of files) {
      const entryPath = field(item, "path"),
        size = field(item, "size"),
        modified = field(item, "lastModified");

      if (!isString(entryPath))
        throw failure("Baseten returned a file without a path", "provider", id);
      entries.push({
        path: entryPath,
        type: "file",
        size: isNumber(size) ? size : 0,
        modifiedAt: isString(modified) ? Date.parse(modified) || 0 : 0,
      });
    }

    for (const item of directories) {
      const entryPath = field(item, "path");

      if (!isString(entryPath))
        throw failure("Baseten returned a directory without a path", "provider", id);
      entries.push({ path: entryPath, type: "directory", size: 0, modifiedAt: 0 });
    }

    return entries;
  }

  const files: ProviderFiles = {
    writeCreatesParents: true,
    read: (id, path) =>
      safe(id, async () => {
        const response = await http.request({
          method: "GET",
          ...fs(id, path),
          headers: { accept: "application/octet-stream" },
          maxBytes: 2 * 1024 * 1024 * 1024,
        });

        // A download carries Content-Disposition; a directory answers with its JSON listing instead.
        if (!response.headers.has("content-disposition"))
          throw failure("Path is a directory, not a file", "invalid_argument", id);

        return response.body;
      }),
    write: (id, path, data) =>
      safe(id, async () => {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(data)]), "file");
        await http.request({ method: "PUT", ...fs(id, path), body: form });
      }),
    list: (id, path) =>
      safe(id, async () => {
        const entries = await listing(id, path);

        if (!entries) throw failure("Path is not a directory", "invalid_argument", id);

        return entries;
      }),
    stat: (id, path) =>
      safe(id, async () => {
        const target = absolute(path, id).replace(/\/+$/, "") || "/";

        if (target === "/") return { path: "/", type: "directory", size: 0, modifiedAt: 0 };
        const entry = (await listing(id, parent(target)))?.find((item) => item.path === target);

        if (!entry) throw failure("File does not exist", "file_not_found", id);

        return entry;
      }),
    remove: (id, path, removeOptions) =>
      safe(id, async () => {
        await http.request({
          method: "DELETE",
          ...fs(id, path),
          query: { recursive: removeOptions.recursive },
        });
      }),
    mkdir: (id, path) =>
      safe(id, async () => {
        await http.request({ method: "PUT", ...fs(id, path), body: { isDirectory: true } });
      }),
  };

  const provider: BasetenProvider = {
    name: "baseten",
    keyMode: "best-effort",
    capabilities: new Set(["size"] as const),
    api: createNativeApi<BasetenPlane>({ http, placeholder: "sandboxName" }),
    create: (input) =>
      safe(undefined, async () => {
        const sizedMemory = memoryFor(input.size) ?? memory;

        if (input.network !== undefined && input.network !== "all")
          throw failure("This adapter does not apply Baseten network policies", "unsupported");

        if (input.from !== undefined)
          throw failure("This adapter does not restore Baseten snapshots", "unsupported");

        for (const [label, value] of [
          ["timeoutMs", input.timeoutMs],
          ["idleTimeoutMs", input.idleTimeoutMs],
        ] as const)
          if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
            invalid(`${label} must be a positive integer`);

        for (const port of input.ports ?? [])
          if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535)
            invalid("ports must be integers from 1 to 65535");

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        // Read credentials first: a missing key allocated nothing, so it is not an unknown outcome.
        const { region } = config();
        // The name is also the sandbox's ID.
        const name = `sbxsdk-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;

        const labels = Object.fromEntries([
          ...Object.entries(input.labels).filter(([key]) => key !== keyLabel),
          [sdkLabel, "1"],
          ...(input.key === undefined ? [] : [[keyLabel, input.key]]),
        ]);

        const policies = [
          ...(input.timeoutMs === undefined
            ? []
            : [{ action: "DELETE", type: "TTL_MAX_AGE", value: duration(input.timeoutMs) }]),
          ...(input.idleTimeoutMs === undefined
            ? []
            : [{ action: "DELETE", type: "TTL_IDLE", value: duration(input.idleTimeoutMs) }]),
        ];

        const createdAt = Date.now();
        let created: NativeInfo;

        try {
          // The caller's signal is checked after the response: aborting mid-request would leave a sandbox nobody deletes.
          created = parseInfo(
            await http.json({
              method: "POST",
              path: "/v1/sandboxes/instances",
              body: {
                name,
                image: options.image ?? defaultImage,
                memory: sizedMemory,
                region,
                labels,
                envs: Object.entries(input.env ?? {}).map(([key, value]) => ({
                  name: key,
                  value,
                })),
                ports: input.ports?.map((port) => ({
                  name: `port-${port}`,
                  protocol: "HTTP",
                  target: port,
                })),
                lifecycle: policies.length ? { expiration_policies: policies } : undefined,
              },
            }),
          );
        } catch (error) {
          const mapped = basetenError(error);

          if (["timeout", "unavailable", "aborted", "outcome_unknown"].includes(mapped.code)) {
            // The name is this call's own, so deleting it can only remove what this call made.
            await provider.destroy(name).catch(() => {});
            throw failure(
              `Creation outcome unknown; sandbox ${name} was deleted if it existed`,
              "outcome_unknown",
              name,
            );
          }

          throw mapped;
        }

        try {
          if (created.url) urls.set(name, created.url);
          const deadline = createDeadline(timeout);

          while (created.status !== "DEPLOYED") {
            if (created.status === "FAILED" || gone.has(created.status))
              throw failure(
                `Sandbox did not start: its status is ${created.status.slice(0, 32)}`,
                "provider",
                name,
              );
            await sleep(readyPollMs, deadline, "baseten");
            created = await getInfo(name);
          }

          if (input.signal?.aborted) throw failure("Creation aborted", "aborted", name);
          await files.mkdir(name, "/workspace");

          return {
            id: name,
            key: input.key,
            labels: { ...input.labels, [sdkLabel]: "1" },
            createdAt,
            state: "running",
          };
        } catch (error) {
          await provider.destroy(name).catch(() => {});
          throw error;
        }
      }),
    list: (labels) =>
      safe(undefined, async () =>
        (await listNative())
          .filter((v) => v.labels[sdkLabel] === "1" && !gone.has(v.status))
          .map(info)
          .filter((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x)),
      ),
    async find(key) {
      const value = (await provider.list({})).find((v) => v.key === key);

      return value ? provider.connect(value.id) : undefined;
    },
    connect: (id) => safe(id, async () => info(await getInfo(id))),
    destroy: (id) =>
      safe(id, async () => {
        try {
          await http.request({ method: "DELETE", path: instance, ...sandbox(id) });
        } catch (error) {
          // Deleting is idempotent: a sandbox that is already gone is done.
          if (httpStatus(error)?.status !== 404) throw error;
        } finally {
          urls.delete(id);
        }
      }),
    async close(id) {
      urls.delete(id);
    },
    exec: (id, input) => safe(id, () => execute(http, id, input)),
    files,
    previewUrl: (id, port) =>
      safe(id, async () => {
        if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535)
          invalid("port must be an integer from 1 to 65535");
        const isPublic = previewAccess === "public";

        // Without a name, create_if_not_exists names it public-<port> or private-<port> and returns it again.
        const preview = await http.json({
          method: "POST",
          path: `${instance}/previews`,
          ...sandbox(id),
          body: { port, public: isPublic, create_if_not_exists: true },
        });
        const url = field(preview, "url"),
          previewName = field(preview, "name");

        if (!isString(url) || !url || !isString(previewName) || !previewName)
          throw failure("Baseten returned a preview without a URL", "provider", id);

        if (isPublic) return { url };
        const expiresAt = Date.now() + tokenTtl;

        const minted = await http.json({
          method: "POST",
          path: `${instance}/previews/{previewName}/tokens`,
          params: { sandboxName: id, previewName },
          sandboxId: id,
          body: { expires_at: new Date(expiresAt).toISOString() },
        });
        const value = field(minted, "token");

        if (!isString(value) || !value)
          throw failure("Baseten returned an invalid preview token", "provider", id);
        const withToken = new URL(url);
        withToken.searchParams.set("preview_token", value);
        const result: Preview = { url: withToken.toString(), expiresAt };

        return result;
      }),
    native: (id) =>
      createNativeApi<BasetenPlane>({ http, placeholder: "sandboxName", sandboxId: id }),
  };

  return provider;
}
