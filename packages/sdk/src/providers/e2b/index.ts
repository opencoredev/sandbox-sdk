import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isBoolean, isObject, isString } from "../../shared/narrow.js";
import { posix } from "node:path";
import type {
  Provider,
  SandboxInfo,
  ExecInput,
  FileInfo,
  NativeProcess,
  CreateInput,
} from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { createHttpClient, type HttpRequest } from "../../http.js";
import {
  createNativeApi,
  sdkConstruct,
  type NativeApi,
  type NativeSdkBinding,
} from "../../native.js";
import { e2bError, mapE2BError } from "./errors.js";
import {
  createEnvd,
  envdGates,
  versionAtLeast,
  type Command,
  type Connection,
  type E2BPlane,
  type EntryInfo,
} from "./envd.js";

export type { E2BPlane } from "./envd.js";

export interface E2BOptions {
  /** Defaults to E2B_API_KEY; required on first use. */
  apiKey?: string;
  /** Template name or ID, including custom hardware templates. Defaults to base. */
  template?: string;
  /** Self-hosted domain. Defaults to E2B_DOMAIN, then e2b.app. */
  domain?: string;
  /** Deadline for each E2B control-plane request. Default: 60 s (the E2B SDK default). */
  requestTimeoutMs?: number;
  /** Serve preview URLs without authentication. Default: true. With false, `preview()` returns the `e2b-traffic-access-token` header. */
  public?: boolean;
  /** Pause instead of kill when the sandbox timeout runs out. `timeoutMs` then sets the running time before the pause, not a hard lifetime. Default: false. */
  autoPause?: boolean;
  /** Wake an auto-paused sandbox when traffic reaches a preview URL. Requires `autoPause`. Default: false. */
  autoResume?: boolean;
  /** E2B volumes to mount, keyed by absolute mount path. Values are volume names or IDs. */
  volumes?: Record<string, string>;
}

/** What `box.native.sdk(load)` builds from: this sandbox's connection, handed to the `Sandbox` constructor without an API call. */
export interface E2BSandboxInit {
  sandboxId: string;
  sandboxDomain?: string;
  envdVersion: string;
  envdAccessToken?: string;
  trafficAccessToken?: string;
  apiKey?: string;
  domain?: string;
  requestTimeoutMs?: number;
}

/** The connection options `provider.api.sdk(load)` passes to the `E2B` client. */
export type E2BClientInit = Pick<E2BSandboxInit, "apiKey" | "domain" | "requestTimeoutMs">;

/** `box.native.sdk`: pass `() => import("e2b")` and get that module's `Sandbox` for this sandbox. */
export type E2BSandboxSdk = <M extends { Sandbox: new (init: E2BSandboxInit) => object }>(
  load: () => Promise<M>,
) => Promise<InstanceType<M["Sandbox"]>>;

/** `provider.api.sdk`: pass `() => import("e2b")` and get an `E2B` client with the provider's credentials. */
export type E2BClientSdk = <M extends { E2B: new (init: E2BClientInit) => object }>(
  load: () => Promise<M>,
) => Promise<InstanceType<M["E2B"]>>;

/** `box.native` for E2B: the control plane (`"api"`, default) and the sandbox's envd (`"envd"`). `{sandboxId}` fills itself. */
export type E2BNative = NativeApi<E2BPlane, E2BSandboxSdk>;

const keyTag = "sandbox-sdk-key";
const workspaceMarker = "/tmp/.sandbox-sdk-workspace-ready";
const deadlineTag = "sandbox-sdk-deadline";
const envdPort = 49983;

/** Domains the SDK (outside browsers) reaches envd on through one shared host, routed by headers. */
const sharedRouting = new Set(["e2b.app", "e2b.dev", "e2b.pro", "e2b-staging.dev"]);
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;

// Double-checked under the lock, in the launching shell: a prepared sandbox spawns nothing, a fresh one only flock and mkdir.
// Redirections on a group, not exec or ":", so a failed open is a non-zero status rather than a shell exit.
const prepareWorkspace = `[ -e ${workspaceMarker} ] || { flock -x 9 && { [ -e ${workspaceMarker} ] || { mkdir -p /workspace && printf ready > ${workspaceMarker}; }; }; } 9>${workspaceMarker}.lock || exit 125`;

const missing = (cause: unknown) =>
  cause instanceof SandboxError && cause.code === "file_not_found";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const seconds = (ms: number) => Math.ceil(ms / 1000);

const unsupported = (message: string) =>
  new SandboxError(
    `${message}. E2B cannot enforce this option. Choose a compatible template or omit the option.`,
    { code: "unsupported", provider: "e2b" },
  );

const isRecord = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: JsonValue | undefined): string[] | undefined =>
  Array.isArray(value) ? value.filter((item) => isString(item)) : undefined;

const fileOf = (entry: EntryInfo): FileInfo => ({
  path: entry.path,
  type: entry.type === "dir" ? "directory" : entry.type,
  size: entry.size,
  modifiedAt: entry.modifiedTime ?? 0,
});

/** A sandbox as `GET /sandboxes/{id}` and `GET /v2/sandboxes` describe it. */
interface Details {
  id: string;
  metadata: Record<string, string>;
  state: SandboxInfo["state"];
  startedAt: number;
  allowInternetAccess?: boolean;
  network?: { allowOut?: string[]; denyOut?: string[]; allowPublicTraffic?: boolean };
}

function invalidResponse(what: string, sandboxId?: string) {
  return new SandboxError(`E2B returned ${what}. Check the E2B service, then retry.`, {
    code: "provider",
    provider: "e2b",
    sandboxId,
  });
}

function parseDetails(value: JsonValue | undefined): Details {
  if (!isRecord(value) || !isString(value.sandboxID) || !value.sandboxID)
    throw invalidResponse("a sandbox without an ID");

  const metadata = isRecord(value.metadata)
    ? Object.fromEntries(
        Object.entries(value.metadata).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

  const startedAt = isString(value.startedAt) ? Date.parse(value.startedAt) : Number.NaN;
  const network = isRecord(value.network) ? value.network : undefined;

  return {
    id: value.sandboxID,
    metadata,
    // E2B has only these two states; a killed sandbox is gone.
    state: value.state === "paused" ? "paused" : "running",
    startedAt: Number.isFinite(startedAt) ? startedAt : 0,
    ...(isBoolean(value.allowInternetAccess)
      ? { allowInternetAccess: value.allowInternetAccess }
      : undefined),
    ...(network
      ? {
          network: {
            allowOut: strings(network.allowOut),
            denyOut: strings(network.denyOut),
            ...(isBoolean(network.allowPublicTraffic)
              ? { allowPublicTraffic: network.allowPublicTraffic }
              : undefined),
          },
        }
      : undefined),
  };
}

const infoOf = (details: Details): SandboxInfo => ({
  id: details.id,
  key: details.metadata[keyTag],
  labels: Object.fromEntries(
    Object.entries(details.metadata).filter(([key]) => ![keyTag, deadlineTag].includes(key)),
  ),
  state: details.state,
  createdAt: details.startedAt,
});

export type E2BProvider = Provider<E2BNative, "pause" | "snapshot" | "network-policy"> & {
  /** The E2B API with this provider's credentials and no sandbox bound, for account calls such as `GET /templates`. */
  readonly api: NativeApi<E2BPlane, E2BClientSdk>;
};

/** E2B's template fixes CPU, RAM and disk; explicit size requests fail closed.
 * Talks to E2B's control plane and to envd directly over HTTP; the `e2b` package is not needed.
 */
export function e2b(options: E2BOptions = {}): E2BProvider {
  const domain = () => options.domain ?? (process.env.E2B_DOMAIN || "e2b.app");

  const apiKey = () => {
    const key = options.apiKey ?? process.env.E2B_API_KEY;

    if (!key?.trim())
      throw new SandboxError(
        "E2B API key is missing. Authentication is required. Set E2B_API_KEY or pass apiKey.",
        { code: "auth", provider: "e2b" },
      );

    return key;
  };

  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const connections = new Map<string, Connection>();

  function connection(id: string): Connection {
    const found = connections.get(id);

    if (!found)
      throw new SandboxError("Sandbox is detached. No local client exists. Connect first.", {
        code: "not_found",
        provider: "e2b",
        sandboxId: id,
      });

    return found;
  }

  const http = createHttpClient<E2BPlane>({
    provider: "e2b",
    label: "E2B",
    defaultPlane: "api",
    timeoutMs: requestTimeoutMs,
    mapError: mapE2BError,
    authHint: "Check E2B_API_KEY and the E2B domain.",
    secrets: () => [
      options.apiKey,
      process.env.E2B_API_KEY,
      ...[...connections.values()].flatMap((item) => [
        item.envdAccessToken,
        item.trafficAccessToken,
      ]),
    ],
    planes: {
      api: {
        baseUrl: () => process.env.E2B_API_URL || `https://api.${domain()}`,
        auth: () => ({ "x-api-key": apiKey() }),
      },
      envd: {
        // Connect's protocol version header; envd's plain HTTP routes ignore it.
        headers: { "connect-protocol-version": "1" },
        baseUrl: ({ sandboxId }) => {
          if (sandboxId === undefined)
            throw new SandboxError(
              "The envd plane belongs to one sandbox. Use box.native, not provider.api.",
              { code: "invalid_argument", provider: "e2b" },
            );
          const { domain: host } = connection(sandboxId);

          return (
            process.env.E2B_SANDBOX_URL ||
            (sharedRouting.has(host)
              ? `https://sandbox.${host}`
              : `https://${envdPort}-${sandboxId}.${host}`)
          );
        },
        // The routing headers ride with the token so they reach only envd's origin. Every envd request carries
        // them, as in the SDK, whether the host is shared or the sandbox's own.
        auth: ({ sandboxId }) => {
          const { envdAccessToken } = connection(sandboxId ?? "");

          return {
            "e2b-sandbox-id": sandboxId ?? "",
            "e2b-sandbox-port": String(envdPort),
            ...(envdAccessToken ? { "x-access-token": envdAccessToken } : undefined),
          };
        },
      },
    },
  });

  const envd = createEnvd({ http, connection, startupTimeoutMs: requestTimeoutMs });

  /** Control-plane POSTs the SDK treats as replayable (connect, timeout, pause): retried, and never `outcome_unknown`. */
  const replayable = { idempotencyKey: "replayable", readOnly: true } as const satisfies Partial<
    HttpRequest<E2BPlane>
  >;

  function parseConnection(value: JsonValue | undefined): Connection {
    if (
      !isRecord(value) ||
      !isString(value.sandboxID) ||
      !value.sandboxID ||
      !isString(value.envdVersion)
    )
      throw invalidResponse("a sandbox connection without an ID or envd version");

    const text = (field: string) => {
      const found = value[field];

      return isString(found) && found ? found : undefined;
    };

    const envdAccessToken = text("envdAccessToken"),
      trafficAccessToken = text("trafficAccessToken");

    return {
      sandboxId: value.sandboxID,
      envdVersion: value.envdVersion,
      ...(envdAccessToken ? { envdAccessToken } : undefined),
      ...(trafficAccessToken ? { trafficAccessToken } : undefined),
      domain: text("domain") ?? domain(),
    };
  }

  const api = {
    async info(id: string) {
      return parseDetails(
        await http.json({ method: "GET", path: "/sandboxes/{id}", params: { id }, sandboxId: id }),
      );
    },
    async connect(id: string, timeoutMs?: number) {
      return parseConnection(
        await http.json({
          method: "POST",
          path: "/v2/sandboxes/{id}/connect",
          params: { id },
          sandboxId: id,
          body: timeoutMs === undefined ? {} : { timeout: seconds(timeoutMs) },
          ...replayable,
        }),
      );
    },
    async setTimeout(id: string, timeoutMs: number) {
      await http.request({
        method: "POST",
        path: "/sandboxes/{id}/timeout",
        params: { id },
        sandboxId: id,
        body: { timeout: seconds(timeoutMs) },
        ...replayable,
      });
    },
    /** `false` when the sandbox was already gone. */
    async kill(id: string): Promise<boolean> {
      try {
        await http.request({
          method: "DELETE",
          path: "/sandboxes/{id}",
          params: { id },
          sandboxId: id,
        });

        return true;
      } catch (cause) {
        if (cause instanceof SandboxError && cause.code === "not_found") return false;
        throw cause;
      }
    },
    /** Every page, following `x-next-token`. The metadata filter is encoded the way the SDK's paginator does. */
    async list(metadata: Record<string, string>): Promise<Details[]> {
      const filter = new URLSearchParams(
        Object.fromEntries(
          Object.entries(metadata).map(([key, value]) => [
            encodeURIComponent(key),
            encodeURIComponent(value),
          ]),
        ),
      ).toString();

      const result: Details[] = [];

      for (let nextToken: string | undefined, pages = 0; pages < 1000; pages++) {
        const response = await http.request({
          method: "GET",
          path: "/v2/sandboxes",
          query: { metadata: filter, state: "running,paused", nextToken },
        });

        const body = response.json();

        if (!Array.isArray(body)) throw invalidResponse("a sandbox list that is not an array");
        result.push(...body.map(parseDetails));
        nextToken = response.headers.get("x-next-token") || undefined;

        if (nextToken === undefined) return result;
      }

      throw invalidResponse("more than 1000 pages of sandboxes");
    },
  };

  const deadlines = new Map<string, number>();
  const workspaces = new Map<string, number>();
  const natives = new Map<string, E2BNative>();
  const detached = new Map<string, { wait: Promise<void>; release(): void }>();

  function detach(id: string) {
    if (detached.has(id)) return;
    let release = () => {};

    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    detached.set(id, { wait, release });
  }

  function attached(id: string) {
    detached.get(id)?.release();
    detached.delete(id);
  }

  const handles = new Map<string, Set<Command>>();

  function disconnectAll(id: string) {
    for (const handle of handles.get(id) ?? []) handle.disconnect();
    handles.delete(id);
  }

  async function call<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (cause) {
      throw e2bError(cause, id);
    }
  }

  const stat = (id: string, path: string) => envd.fs.stat(id, path, "root");

  async function attach(id: string): Promise<Details> {
    const info = await api.info(id);
    const deadline = Number(info.metadata[deadlineTag]);

    if (Number.isFinite(deadline) && deadline > 0) {
      deadlines.set(id, deadline);

      if (deadline <= Date.now()) {
        await api.kill(id);
        throw new SandboxError(
          "Sandbox lifetime expired. Its hard deadline passed. Create another sandbox.",
          { code: "not_found", provider: "e2b", sandboxId: id },
        );
      }
    }

    connections.set(
      id,
      await api.connect(
        id,
        deadlines.has(id) ? Math.max(1, (deadlines.get(id) ?? 0) - Date.now()) : undefined,
      ),
    );

    // Reconnect may precede the original creator's first guest operation.
    try {
      await stat(id, "/workspace");
      await envd.files.write(id, [{ path: workspaceMarker, data: "ready" }], "root");
      workspaces.delete(id);
    } catch (cause) {
      if (!missing(cause)) throw cause;

      try {
        await stat(id, workspaceMarker);
        workspaces.delete(id);
      } catch (cause) {
        if (!missing(cause)) throw cause;
        workspaces.set(id, info.startedAt);
      }
    }

    // connect may lengthen the native timeout; clamp it back to the hard deadline.
    if (deadlines.has(id))
      await api.setTimeout(id, Math.max(1, (deadlines.get(id) ?? 0) - Date.now()));
    attached(id);

    return { ...info, state: "running" };
  }

  async function client(id: string) {
    if (!connections.has(id)) await attach(id);
    connection(id);
  }

  async function reconcileWorkspace(id: string) {
    if (!workspaces.has(id)) return;

    try {
      await stat(id, workspaceMarker);
      workspaces.delete(id);
    } catch (cause) {
      if (!missing(cause)) throw cause;
    }
  }

  async function list(metadata: Record<string, string>) {
    return (await api.list({ ...metadata, "sandbox-sdk": "1" })).map(infoOf);
  }

  /** A short command run to completion as root, like `commands.run` in the foreground: its exit code. */
  async function runToEnd(id: string, command: string, timeoutMs = 60_000): Promise<number> {
    return (
      await envd.process.start(id, {
        command,
        cwd: "/",
        user: "root",
        stdin: false,
        timeoutMs,
        abandon: (tag) => abandon(id, tag),
      })
    ).wait();
  }

  async function groupSignal(id: string, pid: number, signal: "TERM" | "KILL") {
    await runToEnd(id, `kill -${signal} -- -${pid} 2>/dev/null || true`, 10_000);
  }

  /** A Start whose outcome is unknown: stop the process with that tag, and its group, if it is running. */
  async function abandon(id: string, tag: string) {
    const found = (await envd.process.list(id)).find((entry) => entry.tag === tag);

    if (found) {
      // The group signal cannot report a missing group, so a failed PID kill must surface: the caller then
      // destroys the sandbox rather than leave a bootstrap that never made its group running.
      await envd.process.signal(id, { pid: found.pid }, "SIGNAL_SIGKILL").catch((cause) => {
        if (!(cause instanceof SandboxError && cause.code === "not_found")) throw cause;
      });
      await groupSignal(id, found.pid, "KILL");

      return;
    }

    // Not listed: it never started, already exited, or is starting right now.
    await envd.process.signal(id, { tag }, "SIGNAL_SIGKILL").catch((cause) => {
      if (!(cause instanceof SandboxError && cause.code === "not_found")) throw cause;
    });
  }

  async function launch(id: string, input: Omit<ExecInput, "timeoutMs">, signal?: AbortSignal) {
    await client(id);
    // E2B supplies the launch PID out of band. Keep that PID as the group
    // leader: setsid must not fork when envd already made it a group leader.
    // /proc fields after the final ')' are state, parent PID, then group PID.
    // No user output is interpreted as transport metadata.
    const pending = workspaces.has(id);
    // envd rejects a missing cwd as an invalid request. Change directory in the
    // shell instead, so a bad cwd is a non-zero exit with the error on stderr.
    const command = `${pending ? `${prepareWorkspace}; ` : ""}cd ${quote(input.cwd)} && exec sh -c ${quote(input.command)}`;
    const script = `set -- "$(</proc/$$/stat)" || exit 125; set -- \${1##*) }; [[ "$3" =~ ^[0-9]+$ ]] || exit 125; if [[ "$3" = "$$" ]]; then exec sh -c ${quote(command)}; else exec setsid -w sh -c ${quote(command)}; fi`;

    const handle = await envd.process.start(id, {
      command: script,
      cwd: "/",
      envs: input.env,
      user: "root",
      stdin: input.stdin !== undefined,
      timeoutMs: 0,
      signal,
      onStdout: (text) => input.onChunk({ stream: "stdout", text }),
      onStderr: (text) => input.onChunk({ stream: "stderr", text }),
      abandon: (tag) => abandon(id, tag),
    });

    const active = handles.get(id) ?? new Set<Command>();
    handles.set(id, active);
    active.add(handle);
    // Attach rejection handling immediately (a short command may already exit).
    const result = handle.wait().then((exitCode) => ({ exitCode, signal: null }));
    void result.catch(() => {});

    try {
      if (input.stdin !== undefined) {
        try {
          await handle.sendStdin(input.stdin);
          await handle.closeStdin();
        } catch (cause) {
          // A command that ignores stdin can exit before delivery. Preserve its
          // exit result; only a still-running command makes delivery failure fatal.
          if (handle.exitCode === undefined) throw cause;
        }
      }

      const settled = result
        .then(async (value) => {
          if (pending) {
            if (value.exitCode >= 0 && value.exitCode < 128 && value.exitCode !== 125)
              workspaces.delete(id);
            else await reconcileWorkspace(id);
          }

          return value;
        })
        .finally(() => active.delete(handle));

      void settled.catch(() => {});

      return { handle, pid: handle.pid, result: settled };
    } catch (cause) {
      // Failed stdin delivery can leave work running; destroy before returning.
      await provider.destroy(id);
      throw cause;
    }
  }

  const binding: NativeSdkBinding = {
    package: "e2b",
    connect(module, sandboxId) {
      const credentials = { apiKey: apiKey(), domain: domain(), requestTimeoutMs };

      if (sandboxId === undefined) return sdkConstruct(module, "E2B", [credentials], "e2b");

      const {
        envdVersion,
        envdAccessToken,
        trafficAccessToken,
        domain: sandboxDomain,
      } = connection(sandboxId);

      return sdkConstruct(
        module,
        "Sandbox",
        [
          {
            ...credentials,
            sandboxId,
            sandboxDomain,
            envdVersion,
            envdAccessToken,
            trafficAccessToken,
          } satisfies E2BSandboxInit,
        ],
        "e2b",
      );
    },
  };

  const provider: E2BProvider = {
    name: "e2b",
    keyMode: "best-effort",
    capabilities: new Set(["pause", "snapshot", "network-policy"]),
    // Every exec runs as root in the VM's single PID namespace.
    procActivity: true,
    api: createNativeApi<E2BPlane, E2BClientSdk>({ http, placeholder: "sandboxId", sdk: binding }),
    create: (input) =>
      call(undefined, async () => {
        validate(input, options);
        const createdAt = Date.now();

        // An auto-paused sandbox outlives its timeout, so no hard deadline is recorded.
        const deadline =
          input.timeoutMs === undefined || options.autoPause
            ? undefined
            : createdAt + input.timeoutMs;

        const network =
          isObject(input.network) || options.public === false
            ? {
                ...(isObject(input.network)
                  ? { denyOut: ["0.0.0.0/0"], allowOut: input.network.allow }
                  : undefined),
                ...(options.public === false ? { allowPublicTraffic: false } : undefined),
              }
            : undefined;

        // No caller signal: an aborted create could still succeed remotely, so it runs to the end and is destroyed below.
        const created = parseConnection(
          await http.json({
            method: "POST",
            path: "/v2/sandboxes",
            body: {
              templateID: input.from ?? options.template ?? "base",
              metadata: {
                ...input.labels,
                "sandbox-sdk": "1",
                ...(input.key === undefined ? undefined : { [keyTag]: input.key }),
                ...(deadline === undefined ? undefined : { [deadlineTag]: String(deadline) }),
              },
              envVars: input.env,
              ...(input.timeoutMs === undefined
                ? undefined
                : { timeout: seconds(input.timeoutMs) }),
              ...(input.network === "none"
                ? { allow_internet_access: false }
                : isObject(input.network)
                  ? {}
                  : { allow_internet_access: true }),
              ...(network === undefined ? undefined : { network }),
              autoPause: options.autoPause === true,
              autoResume: { enabled: options.autoPause === true && options.autoResume === true },
              ...(options.volumes === undefined
                ? undefined
                : {
                    volumeMounts: Object.entries(options.volumes).map(([path, name]) => ({
                      name,
                      path,
                    })),
                  }),
            },
          }),
        );

        const id = created.sandboxId;
        connections.set(id, created);

        if (deadline !== undefined) deadlines.set(id, deadline);

        try {
          // The SDK refuses envd before 0.1.0 the same way: kill, then throw.
          if (!versionAtLeast(created.envdVersion, envdGates.minimum))
            throw new SandboxError(
              "The template's envd is too old for this SDK. Rebuild the template.",
              { code: "provider", provider: "e2b", sandboxId: id },
            );

          if (input.signal?.aborted)
            throw new SandboxError(
              "Creation aborted. Cancellation arrived during E2B creation. Retry with a fresh signal.",
              { code: "aborted", provider: "e2b" },
            );

          // The create response carries connection fields, not network policy.
          const info =
            input.network === "none" || isObject(input.network) || options.public === false
              ? await api.info(id)
              : undefined;

          if (
            input.network === "none" &&
            info?.allowInternetAccess !== false &&
            !(info?.network?.denyOut?.includes("0.0.0.0/0") && !info?.network.allowOut?.length)
          )
            throw unsupported("E2B did not confirm that internet access is disabled");

          if (isObject(input.network)) {
            const requested = input.network.allow;
            const allowed = info?.network?.allowOut ?? [];

            if (
              !info?.network?.denyOut?.includes("0.0.0.0/0") ||
              requested.some((host) => !allowed.includes(host)) ||
              allowed.some((host) => !requested.includes(host))
            )
              throw unsupported("E2B did not confirm the requested outbound allow list");
          }

          if (
            options.public === false &&
            (info?.network?.allowPublicTraffic !== false || !created.trafficAccessToken)
          )
            throw unsupported(
              "E2B did not confirm that preview URLs require a traffic access token",
            );
          workspaces.set(id, createdAt);

          if (input.from !== undefined) await reconcileWorkspace(id);

          if (input.signal?.aborted)
            throw new SandboxError("Creation aborted during E2B policy confirmation", {
              code: "aborted",
              provider: "e2b",
            });

          return {
            id,
            key: input.key,
            labels: { ...input.labels, "sandbox-sdk": "1" },
            state: "running",
            createdAt,
          };
        } catch (cause) {
          await provider.destroy(id);
          throw cause;
        }
      }),
    find: (key) =>
      call(undefined, async () => {
        const info = (await list({ [keyTag]: key }))[0];

        return info ? provider.connect(info.id) : undefined;
      }),
    connect: (id) => call(id, async () => infoOf(await attach(id))),
    list: (labels) => call(undefined, () => list(labels)),
    destroy: (id) =>
      call(id, async () => {
        await api.kill(id);
        connections.delete(id);
        natives.delete(id);
        workspaces.delete(id);
        deadlines.delete(id);
        attached(id);
        disconnectAll(id);
      }),
    close: (id) =>
      call(id, async () => {
        detach(id);
        disconnectAll(id);
        connections.delete(id);
        natives.delete(id);
      }),
    native(id) {
      if (!connections.has(id))
        throw new SandboxError(
          "Sandbox client is detached. There is no cached native object. Connect the sandbox first.",
          { code: "not_found", provider: "e2b", sandboxId: id },
        );
      let native = natives.get(id);

      if (!native) {
        native = createNativeApi<E2BPlane, E2BSandboxSdk>({
          http,
          placeholder: "sandboxId",
          sandboxId: id,
          sdk: binding,
        });
        natives.set(id, native);
      }

      return native;
    },
    exec: (id, input) =>
      call(id, async () => {
        if (input.signal?.aborted) return { exitCode: null, timedOut: true };
        const started = Date.now();
        const stop = new AbortController();
        let cancelled = false;
        let cancel = () => {};

        const cancellation = new Promise<"cancelled">((resolve) => {
          cancel = () => {
            cancelled = true;
            stop.abort();
            resolve("cancelled");
          };
        });

        input.signal?.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(cancel, input.timeoutMs);

        try {
          let running: Awaited<ReturnType<typeof launch>>;

          try {
            running = await launch(id, input, stop.signal);
          } catch (cause) {
            if (!cancelled) throw cause;

            // Cancelled during startup: the Start was abandoned and anything it launched was stopped by tag.
            // Like a failed kill below, a cleanup that did not finish leaves no running work behind.
            if (!(cause instanceof SandboxError && cause.code === "aborted"))
              await provider.destroy(id);

            return { exitCode: null, timedOut: true };
          }

          if (input.signal?.aborted || Date.now() - started >= input.timeoutMs) cancel();

          const outcome = cancelled
            ? "cancelled"
            : await Promise.race([running.result, cancellation]);

          if (outcome !== "cancelled") return { exitCode: outcome.exitCode, timedOut: false };

          // Stop bootstrap first: it may not have established its group yet.
          // The final group signal then catches every descendant it did launch.
          try {
            await running.handle.kill();
            await groupSignal(id, running.pid, "KILL");
          } catch (cause) {
            await provider.destroy(id);
            throw cause;
          }

          await running.result.catch(() => {});
          running.handle.disconnect();

          return { exitCode: null, timedOut: true };
        } finally {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", cancel);
        }
      }),
    files: {
      writeCreatesParents: true,
      // envd writes uploads into the existing file, and ListDir sorts entries by name.
      editInGuest: "in-place",
      listOrder: "name",
      // Input over 32 KiB needs stdin and its close; envd before 0.3.0 cannot run without stdin at all.
      guestInput: (id) =>
        call(id, async () => {
          await client(id);
          const { envdVersion } = connection(id);

          return versionAtLeast(envdVersion, envdGates.closeStdin)
            ? "stdin"
            : versionAtLeast(envdVersion, envdGates.stdinFlag)
              ? "env"
              : "none";
        }),
      read: (id, path) =>
        call(id, async () => {
          await client(id);

          return envd.files.read(id, path, "root");
        }),
      write: (id, path, data) =>
        call(id, async () => {
          await client(id);

          if (handles.get(id)?.size) await reconcileWorkspace(id);

          if (posix.normalize(path) === "/workspace" && workspaces.has(id))
            throw new SandboxError("Cannot write a file over the workspace directory", {
              code: "invalid_argument",
              provider: "e2b",
              sandboxId: id,
            });

          if (workspaces.has(id) && posix.normalize(path).startsWith("/workspace/")) {
            await envd.files.write(
              id,
              [
                { path, data },
                { path: workspaceMarker, data: "ready" },
              ],
              "root",
            );
            workspaces.delete(id);
          } else await envd.files.write(id, [{ path, data }], "root");
        }),
      list: (id, path) =>
        call(id, async () => {
          await client(id);

          try {
            const entries = (await envd.fs.list(id, path, "root")).map(fileOf);

            if (handles.get(id)?.size) await reconcileWorkspace(id);
            const createdAt = workspaces.get(id);

            if (
              posix.normalize(path) === "/" &&
              createdAt !== undefined &&
              !entries.some((entry) => entry.path === "/workspace")
            )
              entries.push({
                path: "/workspace",
                type: "directory",
                size: 0,
                modifiedAt: createdAt,
              });

            return entries;
          } catch (cause) {
            if (handles.get(id)?.size) await reconcileWorkspace(id);

            if (posix.normalize(path) === "/workspace" && workspaces.has(id) && missing(cause))
              return [];
            throw cause;
          }
        }),
      stat: (id, path) =>
        call(id, async () => {
          await client(id);

          try {
            return fileOf(await stat(id, path));
          } catch (cause) {
            if (handles.get(id)?.size) await reconcileWorkspace(id);
            const createdAt = workspaces.get(id);

            if (posix.normalize(path) === "/workspace" && createdAt !== undefined && missing(cause))
              return { path, type: "directory", size: 0, modifiedAt: createdAt };
            throw cause;
          }
        }),
      mkdir: (id, path) =>
        call(id, async () => {
          await client(id);

          if (workspaces.has(id)) {
            const exitCode = await runToEnd(id, `${prepareWorkspace}; mkdir -p ${quote(path)}`);

            if (exitCode !== 0)
              throw new SandboxError(
                `Creating the directory failed with exit code ${exitCode}. Check the path and its parents.`,
                { code: "provider", provider: "e2b", sandboxId: id },
              );
            workspaces.delete(id);
          } else await envd.fs.mkdir(id, path, "root");
        }),
      remove: (id, path, options) =>
        call(id, async () => {
          await client(id);

          if (posix.normalize(path) === "/workspace" && workspaces.has(id)) {
            const exitCode = await runToEnd(
              id,
              `${prepareWorkspace}; if [ -L /workspace ]; then rm /workspace; else ${options.recursive ? "rm -rf" : "rmdir"} /workspace; fi`,
            );

            if (exitCode !== 0) {
              if (!options.recursive)
                throw new SandboxError("Directory is not empty. Pass recursive: true.", {
                  code: "invalid_argument",
                  provider: "e2b",
                  sandboxId: id,
                });
              throw new SandboxError(`Removing /workspace failed with exit code ${exitCode}.`, {
                code: "provider",
                provider: "e2b",
                sandboxId: id,
              });
            }

            workspaces.delete(id);

            return;
          }

          if (
            !options.recursive &&
            (await stat(id, path)).type === "dir" &&
            (await envd.fs.list(id, path, "root")).length
          )
            throw new SandboxError(
              "Directory is not empty. Recursive removal was not requested. Pass recursive: true.",
              { code: "invalid_argument", provider: "e2b", sandboxId: id },
            );
          await envd.fs.remove(id, path, "root");
        }),
    },
    previewUrl: (id, port) =>
      call(id, async () => {
        await client(id);
        const { domain: host, trafficAccessToken } = connection(id);
        const url = `https://${port}-${id}.${host}`;

        if (options.public !== false) return { url };

        if (!trafficAccessToken)
          throw new SandboxError(
            "Preview access token is missing. E2B returned no traffic access token for this private sandbox. Reconnect, or create it with public previews.",
            { code: "unsupported", provider: "e2b", sandboxId: id },
          );

        return { url, headers: { "e2b-traffic-access-token": trafficAccessToken } };
      }),
    pause: (id) =>
      call(id, async () => {
        detach(id);

        try {
          // 409: already paused, which the SDK reports as success too.
          try {
            await http.request({
              method: "POST",
              path: "/sandboxes/{id}/pause",
              params: { id },
              sandboxId: id,
              body: {},
              ...replayable,
            });
          } catch (cause) {
            if (!(cause instanceof SandboxError && /\(HTTP 409\b/.test(cause.message))) throw cause;
          }

          connections.delete(id);
          natives.delete(id);
          disconnectAll(id);
        } catch (cause) {
          attached(id);
          throw cause;
        }
      }),
    resume: (id) =>
      call(id, async () => {
        await attach(id);
      }),
    snapshot: (id, settings) =>
      call(id, async () => {
        if (settings?.expiresInMs)
          throw new SandboxError(
            "Snapshot expiry is unavailable. E2B keeps snapshots until you delete them. Omit expiresInMs, or pass 0.",
            { code: "unsupported", provider: "e2b", sandboxId: id },
          );
        await client(id);

        if (workspaces.has(id)) {
          const exitCode = await runToEnd(id, prepareWorkspace);

          if (exitCode !== 0)
            throw new SandboxError(
              `Preparing /workspace for the snapshot failed with exit code ${exitCode}.`,
              { code: "provider", provider: "e2b", sandboxId: id },
            );
          workspaces.delete(id);
        }

        const body = await http.json({
          method: "POST",
          path: "/sandboxes/{id}/snapshots",
          params: { id },
          sandboxId: id,
          body: {},
        });

        if (!isRecord(body) || !isString(body.snapshotID) || !body.snapshotID)
          throw invalidResponse("a snapshot without an ID", id);

        return { id: body.snapshotID };
      }),
    startProcess: (id, input) =>
      call(id, async (): Promise<NativeProcess> => {
        const running = await launch(id, input);
        // envd reports -1 for a signalled process. Report what the other providers do:
        // 143 after stop() (it sends SIGTERM first), otherwise null, which core records as 137.
        let stopped = false;

        const exit = (exitCode: number) => ({
          exitCode: exitCode >= 0 ? exitCode : stopped ? 143 : null,
          signal: null,
        });

        return {
          pid: running.pid,
          wait: () =>
            call(id, async () => {
              try {
                return exit((await running.result).exitCode);
              } catch {}

              await detached.get(id)?.wait;
              await client(id);

              return exit(await (await envd.process.connect(id, running.pid)).wait());
            }),
          stop: (options) =>
            call(id, async () => {
              stopped = true;
              await groupSignal(id, running.pid, "TERM");
              await sleep(options.graceMs);
              await running.handle.kill();
              await groupSignal(id, running.pid, "KILL");
            }),
        };
      }),
  };

  return provider;
}

function validate(input: CreateInput, options: E2BOptions) {
  if (options.autoResume && !options.autoPause)
    throw new SandboxError(
      "autoResume requires autoPause. E2B can only wake a sandbox it paused. Set autoPause: true or drop autoResume.",
      { code: "invalid_argument", provider: "e2b" },
    );

  if (input.size !== undefined)
    throw unsupported(
      "Machine size is fixed by the E2B template; small, medium, large and custom sizes are unavailable at creation",
    );

  if (input.idleTimeoutMs !== undefined)
    throw unsupported(
      "E2B timeouts measure elapsed time, not idle time; idleTimeoutMs is unavailable",
    );

  if (input.labels[keyTag] !== undefined || input.labels[deadlineTag] !== undefined)
    throw new SandboxError(
      "Reserved E2B metadata key. SDK lifecycle metadata must not be overwritten. Rename the label.",
      { code: "invalid_argument", provider: "e2b" },
    );
}
