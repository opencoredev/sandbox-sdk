/**
 * Superserve endpoints and the data-plane route state machine, as @superserve/sdk 0.11.4 runs them
 * (`resolveConfig`, `dataPlaneTarget`, `_postAndRotateToken`, `_refreshActivate`, `withTokenRetry`).
 *
 * The control plane takes the API key. The data plane (exec, files, `exec/connect`) takes an access token
 * and a routing hint that `POST /sandboxes/{id}/activate` and `/resume` hand out. A route is replaced when:
 * - its routing hint is about to expire (checked before every data-plane call),
 * - the data plane answers 401, a 404 `sandbox_route_stale`, or a 503 meaning the sandbox is not running,
 * - `exec/connect` fails to open.
 * Concurrent activations for a sandbox share one request, so a paused sandbox is not resumed twice. Every
 * activation or resume takes a revision when it starts; a response older than the route in use is dropped,
 * so a slow activation never overwrites a newer resume.
 */
import { isNumber, isObject, isString } from "../../shared/narrow.js";
import { failure } from "./errors.js";

export interface SuperserveConfig {
  apiKey: string;
  /** Control plane, e.g. https://api.superserve.ai. */
  baseUrl: string;
  /** Data plane and preview host, e.g. sandbox.superserve.ai. */
  sandboxHost: string;
}

const defaultBaseUrl = "https://api.superserve.ai";
const defaultSandboxHost = "sandbox.superserve.ai";

const regions = new Map([
  ["use", { baseUrl: "https://api.superserve.ai", sandboxHost: "sandbox.superserve.ai" }],
  ["usw", { baseUrl: "https://api-usw.superserve.ai", sandboxHost: "usw-sandbox.superserve.ai" }],
]);

const regionKey = /^ss_live_([a-z0-9]{1,17})_[A-Za-z0-9_-]{32}$/;

// Hosts that route by the X-Superserve-Sandbox-Id header; any other host is per sandbox (boxd-<id>.<host>).
const sharedHosts = new Set([
  "sandbox.superserve.ai",
  "staging-sandbox.superserve.ai",
  "usw-sandbox.superserve.ai",
]);

function sandboxHostFor(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;

    if (host === "api-staging.superserve.ai") return "staging-sandbox.superserve.ai";

    for (const region of regions.values())
      if (new URL(region.baseUrl).hostname === host) return region.sandboxHost;
  } catch {
    // An unparseable override fails later, on the control-plane request itself.
  }

  return defaultSandboxHost;
}

/** Reads the key and endpoints: an explicit base URL wins, then the key's region (`ss_live_<region>_`), then the default. */
export function resolveConfig(options: { apiKey?: string; baseUrl?: string }): SuperserveConfig {
  const apiKey = options.apiKey ?? process.env.SUPERSERVE_API_KEY;

  if (!apiKey?.trim())
    throw failure(
      "Superserve API key is missing. Authentication is required. Set SUPERSERVE_API_KEY or pass apiKey.",
      "auth",
    );
  const override = (options.baseUrl ?? process.env.SUPERSERVE_BASE_URL)?.trim() || undefined;

  if (override !== undefined)
    return { apiKey, baseUrl: override, sandboxHost: sandboxHostFor(override) };
  const region = regions.get(regionKey.exec(apiKey)?.[1] ?? "");

  return {
    apiKey,
    baseUrl: region?.baseUrl ?? defaultBaseUrl,
    sandboxHost: region?.sandboxHost ?? defaultSandboxHost,
  };
}

export const sandboxIdHeader = "X-Superserve-Sandbox-Id";
export const routingHintHeader = "X-Superserve-Routing-Hint";
export const accessTokenHeader = "X-Access-Token";

/** Where data-plane HTTP for a sandbox goes, and the header a shared host routes by. */
export function dataPlane(
  sandboxId: string,
  sandboxHost: string,
): { url: string; headers: Record<string, string> } {
  const host = sandboxHost.toLowerCase();

  return sharedHosts.has(host)
    ? { url: `https://${host}`, headers: { [sandboxIdHeader]: sandboxId } }
    : { url: `https://boxd-${sandboxId}.${host}`, headers: {} };
}

/** `exec/connect` always dials the per-sandbox host; the route travels in the subprotocols. */
export function execConnectUrl(sandboxId: string, sandboxHost: string): string {
  return `wss://boxd-${sandboxId}.${sandboxHost.toLowerCase()}/exec/connect`;
}

/** Preview ports Superserve proxies: 1024 to 65535, except its control port 49983. */
export function previewUrl(sandboxId: string, sandboxHost: string, port: number): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 49983)
    throw failure(
      port === 49983
        ? "Preview port 49983 is reserved for sandbox control traffic"
        : "Preview ports must be integers from 1024 to 65535",
      "invalid_argument",
    );

  return `https://${port}-${sandboxId}.${sandboxHost}`;
}

/** The expiry of a routing hint in ms since the epoch: its payload's `e`, in seconds. `undefined` when it has none. */
export function hintExpiry(hint: string): number | undefined {
  try {
    const payload: unknown = JSON.parse(
      atob((hint.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    );

    const expiry = isObject(payload) ? ("e" in payload ? payload.e : undefined) : undefined;

    return isNumber(expiry) && Number.isFinite(expiry) ? expiry * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** The credentials one data-plane call uses. `revision` orders routes: a higher one is newer. */
export interface Route {
  readonly token: string;
  readonly hint?: string;
  readonly revision: number;
}

/** Reads `access_token` and `routing_hint` from a create, activate or resume response. */
export function parseRoute(
  raw: unknown,
  sandboxId: string,
  operation: string,
): { token: string; hint?: string } {
  const token = isObject(raw) ? ("access_token" in raw ? raw.access_token : undefined) : undefined;

  const hint = isObject(raw) ? ("routing_hint" in raw ? raw.routing_hint : undefined) : undefined;

  if (!isString(token) || !token)
    throw failure(`Superserve ${operation} returned no access token`, "provider", sandboxId);

  return { token, ...(isString(hint) && hint ? { hint } : undefined) };
}

export type RotateEndpoint = "activate" | "resume";

export interface RouteBookOptions {
  /** POST /sandboxes/{id}/{endpoint} and return the response body. */
  rotate(sandboxId: string, endpoint: RotateEndpoint): Promise<unknown>;
  /** Replace a route this long before its routing hint expires. Default: 30 s. */
  refreshBeforeMs?: number;
}

export interface RouteBook {
  /** The current route, activating first when there is none or its hint is about to expire. */
  current(sandboxId: string, signal?: AbortSignal): Promise<Route>;
  /**
   * A route newer than `used`. When one was already applied since (another call refreshed or resumed),
   * it is returned without a request; otherwise this joins or starts the sandbox's activation.
   */
  refresh(sandboxId: string, used: number | undefined, signal?: AbortSignal): Promise<Route>;
  /** Activate now, sharing a request already in flight. */
  activate(sandboxId: string, signal?: AbortSignal): Promise<Route>;
  /** POST `/resume` (not shared) and apply its route by revision. */
  resume(sandboxId: string): Promise<Route>;
  /** Apply a route from a create response. */
  seed(sandboxId: string, raw: unknown): Route;
  /** Drop a sandbox's state (destroy, close). An activation still in flight then applies to nothing. */
  forget(sandboxId: string): void;
  /** Every token and hint held, for redaction. */
  secrets(): string[];
}

interface RouteState {
  current?: Route;
  /** The revision the next activation or resume takes. */
  issued: number;
  activating?: Promise<Route>;
}

/** Waits for `promise` unless `signal` fires first. The shared promise keeps running for other callers. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;

  return new Promise((resolve, reject) => {
    // A plain Error: the HTTP client turns an abort it sees during `auth` into its own `aborted` or `timeout`.
    const onAbort = () => reject(new Error("Superserve route activation abandoned by its caller"));

    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createRouteBook(options: RouteBookOptions): RouteBook {
  const refreshBeforeMs = options.refreshBeforeMs ?? 30_000;
  const states = new Map<string, RouteState>();

  const stateOf = (id: string) => {
    let state = states.get(id);

    if (!state) states.set(id, (state = { issued: 0 }));

    return state;
  };

  /** Keeps the newer of the applied route and this response. Always returns the route now in use. */
  function apply(
    state: RouteState,
    revision: number,
    route: { token: string; hint?: string },
  ): Route {
    if (!state.current || revision > state.current.revision) state.current = { ...route, revision };

    return state.current;
  }

  async function rotate(id: string, state: RouteState, endpoint: RotateEndpoint): Promise<Route> {
    const revision = ++state.issued;

    return apply(
      state,
      revision,
      parseRoute(await options.rotate(id, endpoint), id, `POST /sandboxes/{id}/${endpoint}`),
    );
  }

  function activate(id: string, signal?: AbortSignal): Promise<Route> {
    const state = stateOf(id);

    if (!state.activating) {
      const pending = rotate(id, state, "activate");

      const settle = () => {
        if (state.activating === pending) state.activating = undefined;
      };

      pending.then(settle, settle);
      state.activating = pending;
    }

    return abortable(state.activating, signal);
  }

  const expiring = (route: Route) => {
    const expiry = route.hint === undefined ? undefined : hintExpiry(route.hint);

    return expiry !== undefined && expiry - Date.now() <= refreshBeforeMs;
  };

  return {
    async current(id, signal) {
      const route = states.get(id)?.current;

      return route && !expiring(route) ? route : activate(id, signal);
    },
    async refresh(id, used, signal) {
      const route = states.get(id)?.current;

      if (route && used !== undefined && route.revision > used && !expiring(route)) return route;

      return activate(id, signal);
    },
    activate,
    resume: (id) => {
      const state = stateOf(id);

      return rotate(id, state, "resume");
    },
    seed(id, raw) {
      const state = stateOf(id);

      return apply(state, ++state.issued, parseRoute(raw, id, "POST /sandboxes"));
    },
    forget: (id) => {
      states.delete(id);
    },
    secrets: () =>
      [...states.values()].flatMap((state) =>
        state.current
          ? [state.current.token, ...(state.current.hint ? [state.current.hint] : [])]
          : [],
      ),
  };
}
