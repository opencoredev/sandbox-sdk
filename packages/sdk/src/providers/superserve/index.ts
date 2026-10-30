/**
 * Superserve over its HTTP API, with no SDK dependency. Wire behaviour follows @superserve/sdk 0.11.4;
 * https://docs.superserve.ai/sdk-reference/sandbox. Two planes:
 * - `api`: the control plane (`https://api.superserve.ai`), authenticated with `X-API-Key`.
 * - `data`: exec and files inside a sandbox, authenticated with the access token and routing hint from
 *   activate or resume (see routes.ts for when they are replaced).
 */
import { type JsonValue, isJsonObject } from "../../shared/json.js";
import { isNumber, isObject, isString } from "../../shared/narrow.js";
import type { CreateInput, Provider, SandboxInfo } from "../../provider.js";
import { SandboxError, invalid } from "../../errors.js";
import {
  createDeadline,
  createHttpClient,
  httpStatus,
  sleep,
  type PlaneContext,
} from "../../http.js";
import {
  createNativeApi,
  sdkCall,
  type NativeApi,
  type NativeSdkBinding,
  sdkObject,
} from "../../native.js";
import { files, python, type Guest } from "../../shared/guest.js";
import { failure, superserveError } from "./errors.js";
import { execute } from "./execute.js";
import { bootstrapCommand, checkBootstrap } from "./bootstrap.js";
import {
  accessTokenHeader,
  createRouteBook,
  dataPlane,
  execConnectUrl,
  previewUrl,
  resolveConfig,
  routingHintHeader,
} from "./routes.js";
import { spawn } from "./session.js";

export interface SuperserveOptions {
  /** Defaults to SUPERSERVE_API_KEY; required on first use. */
  apiKey?: string;
  /** Defaults to SUPERSERVE_BASE_URL, then https://api.superserve.ai. */
  baseUrl?: string;
  /** Native template name or UUID. Defaults to superserve/node-22.
   * Must include git, tar, and nohup. Python 3 is required unless installPython is enabled.
   * Template-owned resources cannot be overridden by the SDK size option.
   */
  template?: string;
  /** Allow apt to install missing Python 3, pip and venv on first use.
   * Defaults to false: a template without Python fails with unsupported on first use.
   * The public default superserve/node-22 currently requires this opt-in.
   */
  installPython?: boolean;
  /** Native request deadline. Default: 90 s. */
  requestTimeoutMs?: number;
  /** Auto-pause after this much active time per session, re-armed on resume. Rounded up to whole seconds. Default: never. */
  autoPauseMs?: number;
  /** Delete the sandbox once it has been paused this long; `0` deletes it as soon as it pauses. Rounded up to whole seconds. Default: never. */
  autoDeleteMs?: number;
  /** Bind stored Superserve secrets to env vars: `{ ENV_VAR: secretName }`. The sandbox sees a proxy token; the real value is attached at egress. */
  secretBindings?: Record<string, string>;
  /** Access for preview ports. `private` returns a token header with each preview; `public` URLs need none. Default: `private`. */
  previewAccess?: "private" | "public";
}

/** `api` is the control plane (the default); `data` is exec and files inside the sandbox. */
export type SuperservePlane = "api" | "data";

/** What `native.sdk(load)` needs from `@superserve/sdk`: its `Sandbox` class. */
export interface SuperserveModule {
  Sandbox: {
    connect(sandboxId: string, options?: { apiKey?: string; baseUrl?: string }): Promise<object>;
  };
}

/** `box.native.sdk(() => import("@superserve/sdk"))`: the SDK's `Sandbox` for this sandbox, from `Sandbox.connect`. */
export type SuperserveSandboxSdk = <M extends SuperserveModule>(
  load: () => Promise<M>,
) => Promise<Awaited<ReturnType<M["Sandbox"]["connect"]>>>;

/** `provider.api.sdk(() => import("@superserve/sdk"))`: the SDK's `Sandbox` class, whose static methods take `{ apiKey }`. */
export type SuperserveAccountSdk = <M extends SuperserveModule>(
  load: () => Promise<M>,
) => Promise<M["Sandbox"]>;

/** `box.native`. `{sandboxId}` in a path fills from the sandbox. */
export type SuperserveNative = NativeApi<SuperservePlane, SuperserveSandboxSdk>;

/** `provider.api`: the same API with no sandbox bound, so only the `api` plane. Use `box.native` for the `data` plane. */
export type SuperserveApi = NativeApi<SuperservePlane, SuperserveAccountSdk>;

export type SuperserveProvider = Provider<
  SuperserveNative,
  "pause" | "snapshot" | "network-policy"
> & {
  /** Account-level calls: `provider.api.request("GET", "/sandboxes")`. */
  readonly api: SuperserveApi;
};

interface NetworkConfig {
  allowOut?: string[];
  denyOut?: string[];
}

/** The fields of a Superserve sandbox the adapter reads. */
interface NativeInfo {
  id: string;
  status: string;
  createdAt: number;
  metadata: Record<string, string>;
  timeoutSeconds?: number;
  network?: NetworkConfig;
}

// Superserve resolves names through these; a domain allow-list needs them reachable.
const resolvers = ["1.1.1.1/32", "8.8.8.8/32"];
const cidr = (entry: string) => /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(entry);

/** Maps SDK network policy to Superserve egress rules; undefined leaves egress open. */
function egress(network: CreateInput["network"]): NetworkConfig | undefined {
  if (network === undefined || network === "all") return undefined;

  if (network === "none") return { allowOut: [], denyOut: ["0.0.0.0/0"] };

  for (const entry of network.allow)
    if (
      !cidr(entry) &&
      !/^(\*\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(
        entry,
      )
    )
      throw failure(
        "Network allow entries must be hostnames, *.wildcards, IPv4 addresses or IPv4 CIDRs",
        "unsupported",
      );

  const allow = network.allow.map((entry) =>
    cidr(entry) && !entry.includes("/") ? `${entry}/32` : entry,
  );

  const domains = allow.some((entry) => !cidr(entry));

  return {
    allowOut: [...new Set([...allow, ...(domains ? resolvers : [])])],
    denyOut: ["0.0.0.0/0"],
  };
}

function sameEgress(requested: NetworkConfig, actual: NetworkConfig | undefined) {
  const same = (a: string[] = [], b: string[] = []) =>
    a.length === b.length && a.every((x) => b.includes(x));

  return same(requested.allowOut, actual?.allowOut) && same(requested.denyOut, actual?.denyOut);
}

const wholeSeconds = (value: number | undefined, label: string, zero: boolean) => {
  if (value === undefined) return undefined;

  if (!Number.isSafeInteger(value) || value < 0 || (!zero && value === 0))
    throw failure(
      `${label} must be a ${zero ? "non-negative" : "positive"} integer of milliseconds`,
      "invalid_argument",
    );

  return Math.ceil(value / 1000);
};

const field = (raw: JsonValue | undefined, key: string): JsonValue | undefined =>
  isJsonObject(raw) ? raw[key] : undefined;

const strings = (raw: JsonValue | undefined): string[] | undefined =>
  Array.isArray(raw) && raw.every((x) => isString(x)) ? raw : undefined;

/** Parses a sandbox object from the control plane, like the SDK's `toSandboxInfo`. */
function parseInfo(raw: JsonValue | undefined, sandboxId?: string): NativeInfo {
  const id = field(raw, "id"),
    status = field(raw, "status"),
    created = field(raw, "created_at");

  if (!isString(id) || !id || !isString(status) || !status || !isString(created))
    throw failure(
      "Superserve returned a sandbox without id, status or created_at",
      "provider",
      sandboxId,
    );
  const metadata: Record<string, string> = {};
  const rawMetadata = field(raw, "metadata");

  if (isObject(rawMetadata))
    for (const [key, value] of Object.entries(rawMetadata))
      if (isString(value)) metadata[key] = value;

  const timeout = field(raw, "timeout_seconds"),
    network = field(raw, "network");

  return {
    id,
    status,
    metadata,
    createdAt: Date.parse(created),
    ...(isNumber(timeout) ? { timeoutSeconds: timeout } : undefined),
    ...(isObject(network)
      ? {
          network: {
            allowOut: strings(field(network, "allow_out")),
            denyOut: strings(field(network, "deny_out")),
          },
        }
      : undefined),
  };
}

const outputLimit = 10 * 1024 * 1024;
const downloadLimit = 2 * 1024 * 1024 * 1024;

// Activation waits out a pause in progress, as the SDK's Sandbox.connect does.
const pausingWindowMs = 30_000;
const pausingRetryMs = 1_000;

// Pause polling, as the SDK's pause({ wait: true }): fast at first, then once a second.
const pauseFastPollMs = 50;
const pauseFastWindowMs = 2_000;
const pausePollMs = 1_000;
const snapshotPollMs = 2_000;

// DELETE retries a 409 (a sandbox mid-transition) like the SDK's retryConflict.
const deleteAttempts = 11;
const sdkPackage = "@superserve/sdk";
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function superserve(options: SuperserveOptions = {}): SuperserveProvider {
  const environments = new Map<string, Record<string, string>>();
  const workspacePrepared = new Set<string>();
  const prepared = new Set<string>();
  const deleting = new Map<string, Promise<void>>();
  // Sandboxes this client has activated (the SDK's Sandbox.connect). Connecting resumes a paused sandbox.
  // Each sandbox this provider has activated or created; the value settles once its route is known.
  const connected = new Map<string, Promise<void>>();
  const config = () => resolveConfig(options);
  const timeout = options.requestTimeoutMs ?? 90000;
  const autoPauseSeconds = wholeSeconds(options.autoPauseMs, "autoPauseMs", false);
  const autoDeleteSeconds = wholeSeconds(options.autoDeleteMs, "autoDeleteMs", true);
  const previewAccess = options.previewAccess ?? "private";

  if (previewAccess !== "private" && previewAccess !== "public")
    throw failure("previewAccess must be private or public", "invalid_argument");

  async function safe<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw superserveError(error, id);
    }
  }

  const sandboxOf = (context: PlaneContext) => {
    if (context.sandboxId === undefined)
      invalid("The Superserve data plane needs a sandbox. Use box.native instead of provider.api");

    return context.sandboxId;
  };

  // The route revision each data-plane call was sent with, so a refresh can tell whether a newer one exists.
  const sentWith = new WeakMap<PlaneContext, number>();

  const routes = createRouteBook({
    async rotate(id, endpoint) {
      // Activate and resume are safe to repeat, so a lost response is a plain failure, not outcome_unknown.
      const request = {
        method: "POST",
        path: `/sandboxes/{sandboxId}/${endpoint}`,
        params: { sandboxId: id },
        sandboxId: id,
        readOnly: true,
      } as const;

      const until = Date.now() + pausingWindowMs;

      for (;;) {
        try {
          return await http.json(request);
        } catch (error) {
          const status = httpStatus(error);

          if (
            endpoint !== "activate" ||
            status?.status !== 409 ||
            status.code !== "sandbox_pausing" ||
            until - Date.now() <= pausingRetryMs
          )
            throw error;
          await delay(pausingRetryMs);
        }
      }
    },
  });

  const http = createHttpClient<SuperservePlane>({
    provider: "superserve",
    label: "Superserve",
    defaultPlane: "api",
    timeoutMs: timeout,
    secrets: () => [options.apiKey, process.env.SUPERSERVE_API_KEY, ...routes.secrets()],
    authHint: "Set SUPERSERVE_API_KEY to a valid Superserve API key.",
    // Superserve answers 409 for a sandbox mid-transition (pausing, starting): try again shortly.
    mapError: (failed) =>
      failed.kind === "status" && failed.status === 409 ? "unavailable" : undefined,
    planes: {
      api: { baseUrl: () => config().baseUrl, auth: () => ({ "X-API-Key": config().apiKey }) },
      data: {
        baseUrl: (context) => dataPlane(sandboxOf(context), config().sandboxHost).url,
        async auth(context) {
          const id = sandboxOf(context);
          const route = await routes.current(id, context.signal);
          sentWith.set(context, route.revision);

          return {
            ...dataPlane(id, config().sandboxHost).headers,
            [accessTokenHeader]: route.token,
            ...(route.hint ? { [routingHintHeader]: route.hint } : undefined),
          };
        },
        // Shared by every request refused at once; each one stops waiting on its own signal.
        async refresh(context) {
          await routes.refresh(sandboxOf(context), sentWith.get(context));
        },
        // The SDK's isResumable: a moved route, or a 503 for a sandbox that is not running. With a routing hint,
        // only a 503 `sandbox_unavailable` (or the legacy plain-text paused answer) means that. Those refuse the
        // request before it runs; a bare 503 without a hint might come after an exec started, so it is `unsure`.
        stale: ({ status, body, credentials }) => {
          if (status === 404 && body.code === "sandbox_route_stale") return "refused";

          if (status !== 503) return undefined;

          if (
            body.code === "sandbox_unavailable" ||
            /^sandbox is (paused|stopped)$/.test(body.text.trim())
          )
            return "refused";

          return credentials[routingHintHeader] ? undefined : "unsure";
        },
      },
    },
  });

  function ensure(id: string): Promise<void> {
    let pending = connected.get(id);

    if (!pending) {
      const activation = routes.activate(id).then(() => undefined);
      pending = activation;
      connected.set(id, activation);
      activation.catch(() => {
        if (connected.get(id) === activation) connected.delete(id);
      });
    }

    return pending;
  }

  const sandbox = (id: string) => ({ params: { sandboxId: id }, sandboxId: id });

  const getInfo = async (id: string) =>
    parseInfo(
      await http.json({ method: "GET", path: "/sandboxes/{sandboxId}", ...sandbox(id) }),
      id,
    );

  function forget(id: string) {
    connected.delete(id);
    routes.forget(id);
    environments.delete(id);
    prepared.delete(id);
    workspacePrepared.delete(id);
  }

  function info(v: NativeInfo): SandboxInfo {
    if (v.metadata["sandbox-sdk"] !== "1") throw failure("Not an SDK sandbox", "not_found", v.id);
    const labels: Record<string, string> = {};

    for (const [key, value] of Object.entries(v.metadata))
      if (key.startsWith("label:")) labels[key.slice(6)] = value;

    return {
      id: v.id,
      key: v.metadata["sdk-key"],
      labels,
      createdAt: v.createdAt,
      state:
        v.status === "active"
          ? "running"
          : ["paused", "pausing"].includes(v.status)
            ? "paused"
            : "stopped",
    };
  }

  function preparation(id: string, command: string, execution: boolean) {
    if (execution ? prepared.has(id) : workspacePrepared.has(id)) return { command, env: {} };

    const setup = bootstrapCommand({
      env: environments.get(id),
      installPython: options.installPython,
      execution,
    });

    return { command: `${setup.command} && ${command}`, env: setup.env };
  }

  /** POST /exec on the data plane: runs to completion and returns its buffered output. */
  async function commandRun(
    id: string,
    command: string,
    settings: { env?: Record<string, string>; timeoutMs: number },
  ) {
    const raw = await http.json({
      method: "POST",
      path: "/exec",
      plane: "data",
      sandboxId: id,
      body: {
        command,
        ...(settings.env === undefined ? undefined : { env: settings.env }),
        timeout_s: Math.ceil(settings.timeoutMs / 1000),
      },
      // The 5 s margin lets the server's own command timeout answer first.
      timeoutMs: settings.timeoutMs + 5000,
      maxBytes: outputLimit,
    });

    const stdout = field(raw, "stdout"),
      stderr = field(raw, "stderr"),
      exitCode = field(raw, "exit_code"),
      truncated = field(raw, "truncated");

    return {
      stdout: isString(stdout) ? stdout : "",
      stderr: isString(stderr) ? stderr : "",
      exitCode: isNumber(exitCode) ? exitCode : 0,
      truncated: truncated === true,
    };
  }

  async function runGuest(
    id: string,
    command: string,
    settings: { env?: Record<string, string>; timeoutMs: number },
    execution = false,
  ) {
    const setup = preparation(id, command, execution);

    const result = await commandRun(id, setup.command, {
      ...settings,
      env: { ...settings.env, ...setup.env },
    });

    checkBootstrap(result.exitCode, id);

    if (result.exitCode === 0) {
      workspacePrepared.add(id);

      if (execution) prepared.add(id);
    }

    return result;
  }

  const guestPath = (path: string) => {
    if (!path.startsWith("/") || path.split("/").includes(".."))
      throw failure(
        "Superserve file paths must be absolute without .. segments",
        "invalid_argument",
      );

    return path;
  };

  async function guest(id: string): Promise<Guest> {
    await ensure(id);

    return {
      name: "superserve",
      raw: async (command) => {
        const r = await runGuest(id, command, { timeoutMs: timeout });

        if (r.exitCode !== 0) throw failure("Guest operation failed", "provider", id);

        return r.stdout;
      },
      upload: async (path, bytes) => {
        await http.request({
          method: "POST",
          path: "/files",
          plane: "data",
          sandboxId: id,
          query: { path: guestPath(path) },
          body: bytes,
          headers: { "content-type": "application/octet-stream" },
        });
      },
      read: async (path, range) => {
        try {
          if (range) {
            const r = await runGuest(
              id,
              python(
                "import sys,base64; f=open(sys.argv[1],'rb'); f.seek(int(sys.argv[2])); print(base64.b64encode(f.read(int(sys.argv[3]))).decode())",
                path,
                String(range.offset),
                String(range.length),
              ),
              { timeoutMs: timeout },
            );

            if (r.exitCode !== 0) throw failure("File range read failed", "file_not_found", id);

            return new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
          }

          return (
            await http.request({
              method: "GET",
              path: "/files",
              plane: "data",
              sandboxId: id,
              query: { path: guestPath(path) },
              maxBytes: downloadLimit,
            })
          ).body;
        } catch (error) {
          if (superserveError(error).code === "not_found")
            throw failure("File does not exist", "file_not_found", id);
          throw error;
        }
      },
    };
  }

  /** Polls until the sandbox is paused; one deleted meanwhile counts as done. Like the SDK's _pollUntilPaused. */
  async function untilPaused(
    id: string,
    deadline: ReturnType<typeof createDeadline>,
    stillPausing: () => Error,
  ) {
    const started = Date.now();

    for (let first = true; ; first = false) {
      if (!first) {
        try {
          await sleep(
            Date.now() - started < pauseFastWindowMs ? pauseFastPollMs : pausePollMs,
            deadline,
            "superserve",
          );
        } catch {
          throw stillPausing();
        }
      }

      let status: string;

      try {
        status = parseInfo(
          await http.json({
            method: "GET",
            path: "/sandboxes/{sandboxId}",
            ...sandbox(id),
            deadline,
          }),
          id,
        ).status;
      } catch (error) {
        if (httpStatus(error)?.status === 404) return;

        if (deadline.timeout.aborted) throw stillPausing();
        throw error;
      }

      if (status === "paused" || status === "deleted") return;

      // A pause can take a moment to show; an active sandbox early on is not yet a failure.
      if (status === "active" && Date.now() - started < pauseFastWindowMs) continue;

      if (status !== "pausing")
        throw failure(
          `Sandbox did not pause: its status is ${status.slice(0, 32)}`,
          "provider",
          id,
        );
    }
  }

  const pauseDeadline = (id: string) => {
    const deadline = createDeadline(timeout);

    return {
      deadline,
      stillPausing: () =>
        failure(
          `Sandbox is still pausing after ${timeout} ms; it finishes in the background`,
          "timeout",
          id,
        ),
    };
  };

  const binding: NativeSdkBinding = {
    package: sdkPackage,
    async connect(module, sandboxId) {
      const Sandbox = module.Sandbox;

      if (!(Sandbox instanceof Function))
        invalid(
          `The module passed to native.sdk() has no Sandbox export. Pass () => import("${sdkPackage}")`,
        );

      if (sandboxId === undefined) return Sandbox;

      return sdkObject(
        await sdkCall(
          Sandbox,
          "connect",
          [sandboxId, { apiKey: config().apiKey, baseUrl: options.baseUrl }],
          sdkPackage,
        ),
        "Sandbox.connect",
        sdkPackage,
      );
    },
  };

  const provider: SuperserveProvider = {
    name: "superserve",
    keyMode: "best-effort",
    inlineActivity: true,
    capabilities: new Set(["pause", "snapshot", "network-policy"]),
    api: createNativeApi<SuperservePlane, SuperserveAccountSdk>({
      http,
      placeholder: "sandboxId",
      sdk: binding,
    }),
    create: (input) =>
      safe(undefined, async () => {
        if (
          input.size !== undefined ||
          input.idleTimeoutMs !== undefined ||
          input.timeoutMs !== undefined
        )
          throw failure(
            "Template resources cannot be overridden, and Superserve has no idle or hard lifetime; use autoPauseMs and autoDeleteMs",
            "unsupported",
          );
        const network = egress(input.network);

        if (!Number.isSafeInteger(timeout) || timeout <= 0)
          throw failure("requestTimeoutMs must be a positive integer", "invalid_argument");

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        // Read credentials first: a missing key allocated nothing, so it is not an unknown outcome.
        config();

        const metadata = new Map([["sandbox-sdk", "1"]]);

        if (input.key !== undefined) metadata.set("sdk-key", input.key);

        for (const [key, value] of Object.entries(input.labels))
          metadata.set(`label:${key}`, value);
        const createdAt = Date.now();
        let raw: JsonValue | undefined;

        try {
          // The caller's signal is checked after the response instead: aborting mid-request would leave a sandbox nobody deletes.
          raw = await http.json({
            method: "POST",
            path: "/sandboxes",
            body: {
              name: `sbxsdk-${crypto.randomUUID()}`,
              metadata: Object.fromEntries(metadata),
              ...(input.env === undefined ? undefined : { env_vars: input.env }),
              preview_access: previewAccess,
              ...(network
                ? { network: { allow_out: network.allowOut, deny_out: network.denyOut } }
                : undefined),
              ...(autoPauseSeconds === undefined
                ? undefined
                : { timeout_seconds: autoPauseSeconds }),
              ...(autoDeleteSeconds === undefined
                ? undefined
                : { auto_delete_seconds: autoDeleteSeconds }),
              ...(options.secretBindings && Object.keys(options.secretBindings).length
                ? { secrets: options.secretBindings }
                : undefined),
              ...(input.from
                ? { from_snapshot: input.from }
                : { from_template: options.template ?? "superserve/node-22" }),
            },
          });
        } catch (error) {
          const mapped = superserveError(error);

          if (["timeout", "unavailable", "aborted", "outcome_unknown"].includes(mapped.code))
            throw failure(
              "Creation outcome unknown; inspect SDK-labelled sandboxes before retrying",
              "outcome_unknown",
            );
          throw mapped;
        }

        const created = parseInfo(raw);
        routes.seed(created.id, raw);
        connected.set(created.id, Promise.resolve());

        try {
          if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
          environments.set(created.id, { ...input.env });

          if (input.from || network) {
            const details = await getInfo(created.id);

            // Restores inherit the snapshot's auto-pause; keep only what this adapter asked for.
            if (input.from && details.timeoutSeconds !== autoPauseSeconds)
              await http.request({
                method: "PATCH",
                path: "/sandboxes/{sandboxId}",
                ...sandbox(created.id),
                body: { timeout_seconds: autoPauseSeconds ?? null },
              });

            if (network && !sameEgress(network, details.network))
              throw failure(
                "Superserve did not confirm the requested egress rules",
                "unsupported",
                created.id,
              );
          }

          return {
            id: created.id,
            key: input.key,
            labels: { ...input.labels, "sandbox-sdk": "1" },
            createdAt,
            state: "running",
          };
        } catch (error) {
          await provider.destroy(created.id);
          throw error;
        }
      }),
    list: (labels) =>
      safe(undefined, async () => {
        const raw = await http.json({
          method: "GET",
          path: "/sandboxes",
          query: { "metadata.sandbox-sdk": "1" },
        });

        if (!Array.isArray(raw))
          throw failure("Superserve returned a sandbox list that is not an array");

        return raw
          .map((v) => parseInfo(v))
          .filter((v) => v.status !== "deleted")
          .map(info)
          .filter((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x));
      }),
    async find(key) {
      const value = (await provider.list({})).find((v) => v.key === key);

      return value ? provider.connect(value.id) : undefined;
    },
    connect: (id) =>
      safe(id, async () => {
        await ensure(id);

        return info(await getInfo(id));
      }),
    destroy(id) {
      let pending = deleting.get(id);

      if (!pending) {
        pending = safe(id, async () => {
          const deadline = createDeadline(timeout);

          for (let attempt = 1; ; attempt++) {
            try {
              await http.request({
                method: "DELETE",
                path: "/sandboxes/{sandboxId}",
                ...sandbox(id),
                deadline,
              });
              break;
            } catch (error) {
              const status = httpStatus(error)?.status;

              // Deleting is idempotent: a sandbox that is already gone is done.
              if (status === 404) break;
              const wait = Math.min(100 * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4), 30_000);

              if (status !== 409 || attempt >= deleteAttempts || wait >= deadline.remaining())
                throw error;
              await sleep(wait, deadline, "superserve");
            }
          }

          forget(id);
        });
        deleting.set(id, pending);
        pending.finally(() => deleting.delete(id)).catch(() => {});
      }

      return pending;
    },
    async close(id) {
      forget(id);
    },
    exec: (id, input) =>
      safe(id, async () => {
        const g = await guest(id);

        return execute(
          {
            raw: g.raw,
            read: async (path, range) => {
              const text = await g.raw(
                python(
                  "import sys,base64; f=open(sys.argv[1],'rb'); f.seek(int(sys.argv[2])); print(base64.b64encode(f.read(int(sys.argv[3]))).decode())",
                  path,
                  String(range.offset),
                  String(range.length),
                ),
              );

              return new Uint8Array(Buffer.from(text.trim(), "base64"));
            },
            run: async (command, env, timeoutMs, signal) => {
              if (signal?.aborted) throw failure("Command interrupted", "aborted", id);
              let abort = () => {};

              const stopped = new Promise<never>((_, reject) => {
                abort = () => reject(failure("Command interrupted", "aborted", id));
              });

              signal?.addEventListener("abort", abort, { once: true });

              try {
                // Keep the supervisor alive for lock-based cancellation and exit recovery.
                const completion = runGuest(id, command, { env, timeoutMs }, true);
                const r = await Promise.race([completion, stopped]);

                if (r.exitCode !== 0 || r.truncated)
                  throw failure("Supervisor failed", "provider", id);

                return r.stdout;
              } finally {
                signal?.removeEventListener("abort", abort);
              }
            },
            exec: async (command, stdin, timeoutMs, signal) => {
              const setup = preparation(id, command, true);

              const session = await spawn({
                sandboxId: id,
                url: execConnectUrl(id, config().sandboxHost),
                command: setup.command,
                env: setup.env,
                timeoutMs,
                startupSignal: signal,
                route: (startup) => routes.current(id, startup),
                refresh: (used, startup) => routes.refresh(id, used.revision, startup),
                redact: http.redact,
              });

              let abort = () => {},
                waiting = false;

              try {
                session.stdin.write(stdin);
                session.stdin.close();

                const stopped = new Promise<never>((_, reject) => {
                  abort = () => {
                    reject(failure("Command interrupted", "aborted", id));
                  };
                });

                signal?.addEventListener("abort", abort, { once: true });

                if (signal?.aborted) abort();
                const completion = session.wait().finally(() => session.close());
                waiting = true;
                const r = await Promise.race([completion, stopped]);
                checkBootstrap(r.exitCode, id);

                if (r.exitCode !== 0) throw failure("Supervisor failed", "provider", id);
                prepared.add(id);
                workspacePrepared.add(id);

                return r.stdout;
              } finally {
                signal?.removeEventListener("abort", abort);

                if (!waiting) await session.close();
              }
            },
          },
          input,
        );
      }),
    files: files(guest, safe),
    previewUrl: (id, port) =>
      safe(id, async () => {
        await ensure(id);
        const url = previewUrl(id, config().sandboxHost, port);

        const published = await http.json({
          method: "POST",
          path: "/sandboxes/{sandboxId}/preview-ports",
          ...sandbox(id),
          body: { port, access: previewAccess },
        });

        const access = field(published, "access");

        if (!isNumber(field(published, "port")) || (access !== "public" && access !== "private"))
          throw failure("Superserve returned an invalid preview port", "provider", id);

        if (previewAccess === "public") return { url };

        const token = await http.json({
          method: "POST",
          path: "/sandboxes/{sandboxId}/preview-ports/{port}/token",
          params: { sandboxId: id, port },
          sandboxId: id,
          body: {},
        });

        const value = field(token, "token"),
          header = field(token, "header"),
          expires = field(token, "expires_at");

        if (!isString(value) || !value || !isString(header) || !header)
          throw failure("Superserve returned an invalid preview token", "provider", id);
        const expiresAt = isString(expires) ? Date.parse(expires) : NaN;

        return {
          url,
          headers: { [header]: value },
          ...(Number.isNaN(expiresAt) ? undefined : { expiresAt }),
        };
      }),
    pause: (id) =>
      safe(id, async () => {
        await ensure(id);
        const { deadline, stillPausing } = pauseDeadline(id);
        let pausing: boolean;

        try {
          pausing =
            field(
              await http.json({
                method: "POST",
                path: "/sandboxes/{sandboxId}/pause",
                ...sandbox(id),
                timeoutMs: Math.min(30_000, timeout),
                signal: deadline.signal,
              }),
              "status",
            ) === "pausing";
        } catch (error) {
          // A pause request that timed out may still be pausing; polling finds out.
          if (deadline.timeout.aborted) throw stillPausing();

          if (
            !(error instanceof SandboxError) ||
            (error.code !== "timeout" && error.code !== "outcome_unknown")
          )
            throw error;
          pausing = true;
        }

        if (pausing) await untilPaused(id, deadline, stillPausing);
      }),
    resume: (id) =>
      safe(id, async () => {
        await ensure(id);

        try {
          await routes.resume(id);
        } catch (error) {
          // A conflict is a pause still in progress: wait it out, then resume.
          if (httpStatus(error)?.status !== 409) throw error;
          const { status } = await getInfo(id);

          if (status !== "pausing" && status !== "paused") throw error;

          if (status === "pausing") {
            const { deadline, stillPausing } = pauseDeadline(id);
            await untilPaused(id, deadline, stillPausing);
          }

          await routes.resume(id);
        }
      }),
    snapshot: (id, snapshotOptions) =>
      safe(id, async () => {
        if (snapshotOptions?.expiresInMs)
          throw failure(
            "Superserve keeps snapshots until they are deleted; omit expiresInMs",
            "unsupported",
            id,
          );
        await ensure(id);
        const name = `sbxsdk-${crypto.randomUUID()}`;

        try {
          const deadline = createDeadline(timeout);

          // The name doubles as the server-side idempotency key, so a retried request takes one snapshot.
          let snapshot = await http.json({
            method: "POST",
            path: "/sandboxes/{sandboxId}/snapshot",
            ...sandbox(id),
            body: { kind: "mem+fs", idempotency_key: name, name },
            idempotencyKey: name,
            deadline,
          });

          for (;;) {
            const snapshotId = field(snapshot, "id"),
              status = field(snapshot, "status");

            if (!isString(snapshotId) || !snapshotId)
              throw failure("Superserve returned a snapshot without an id", "provider", id);

            if (status === "ready") return { id: snapshotId };

            if (status === "failed" || status === "deleting")
              throw failure(`Snapshot ${status}`, "provider", id);
            await sleep(Math.min(snapshotPollMs, deadline.remaining()), deadline, "superserve");
            snapshot = await http.json({
              method: "GET",
              path: "/snapshots/{snapshotId}",
              params: { snapshotId },
              sandboxId: id,
              deadline,
            });
          }
        } catch {
          throw failure(
            `Snapshot outcome unknown; recover snapshot named ${name} from source ${id}`,
            "outcome_unknown",
            id,
          );
        }
      }),
    native: (id) =>
      createNativeApi<SuperservePlane, SuperserveSandboxSdk>({
        http,
        placeholder: "sandboxId",
        sandboxId: id,
        sdk: binding,
      }),
  };

  return provider;
}
