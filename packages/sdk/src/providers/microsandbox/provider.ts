/**
 * Microsandbox Cloud (https://microsandbox.dev) microVM sandboxes. Sources, retrieved 2026-11-24:
 * https://api.microsandbox.dev/docs/openapi.json, https://docs.microsandbox.dev/llms-full.txt, and the
 * official SDK's cloud client and wire types (github.com/superradcompany/microsandbox,
 * `sdk/rust/lib/context/cloud/*.rs`, `packages/microsandbox-types/rust/lib/cloud/services.rs`).
 *
 * Two paths. The control plane (`https://api.microsandbox.dev/v1`, `Authorization: Bearer <key>`) creates,
 * reads, lists, starts, stops, snapshots and deletes sandboxes and owns Services (public port URLs), all
 * over `fetch`. Commands and files go through the guest agent, whose protocol only the optional peer
 * `microsandbox` speaks (a native addon): the adapter reaches it through a `RemoteContext` it builds with
 * its own key and URL, never the peer's process-wide defaults.
 */
import { randomUUID } from "node:crypto";
import { SandboxError } from "../../errors.js";
import {
  createDeadline,
  createHttpClient,
  httpStatus,
  neverSent,
  type Deadline,
  type Fetch,
  type HttpClient,
  type HttpRequest,
} from "../../http.js";
import {
  createNativeApi,
  sdkCall,
  sdkConstruct,
  sdkObject,
  type NativeApi,
  type NativeSdkBinding,
} from "../../native.js";
import { loadPeer } from "../../peer.js";
import type { CreateInput, ExecInput, Labels, Provider, SandboxInfo } from "../../provider.js";
import { files as guestFiles, type Guest } from "../../shared/guest.js";
import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isString } from "../../shared/narrow.js";
import {
  allocLabel,
  capturedFrom,
  keyLabel,
  leakPatterns,
  nestedTokens,
  parseOperation,
  parseOperationPage,
  parseSandbox,
  parseSandboxAnswer,
  parseSandboxPage,
  parseService,
  parseServicePage,
  parseSnapshot,
  serviceUrl,
  sourceLabel,
  toInfo,
  tokensIn,
  type MicrosandboxComputeType,
  type MicrosandboxSandbox,
  type MicrosandboxService,
  type MicrosandboxSnapshot,
  type SandboxAnswer,
} from "./api.js";
import { fail, mapError, nativeHint, peerError, provider as name } from "./errors.js";
import {
  execute,
  type MicrosandboxModule,
  type PeerContext,
  type PeerContextOptions,
  type PeerSandbox,
} from "./exec.js";

export type { MicrosandboxComputeType } from "./api.js";

export type {
  MicrosandboxModule,
  PeerContext as MicrosandboxPeerContext,
  PeerContextOptions as MicrosandboxPeerContextOptions,
  PeerExecEvent as MicrosandboxPeerExecEvent,
  PeerExecHandle as MicrosandboxPeerExecHandle,
  PeerExecOptions as MicrosandboxPeerExecOptions,
  PeerFs as MicrosandboxPeerFs,
  PeerSandbox as MicrosandboxPeerSandbox,
} from "./exec.js";

/** Microsandbox's API surface on `box.native` and `provider.api`: the control plane, `/v1` on the API host. */
export type MicrosandboxPlane = "control";

export type MicrosandboxCapability = "size" | "snapshot" | "snapshot-delete" | "network-policy";

/**
 * Called before the adapter sends a request that may allocate something billable, with what that request
 * will carry, so a harness can journal it first. The adapter awaits each hook; a rejection stops the call
 * before anything is sent. The hooks never see credentials.
 */
export interface MicrosandboxHooks {
  /** Before `POST /v1/sandboxes`: the sandbox name and allocation marker this create sends, and its labels. */
  create?(attempt: {
    name: string;
    allocId: string;
    from: string | undefined;
    labels: Labels;
  }): void | Promise<void>;
  /** Before the source is stopped for a snapshot: the snapshot name the capture will use. */
  snapshot?(attempt: { sandboxId: string; name: string }): void | Promise<void>;
  /** Before `POST /v1/services`: the Service slug the adapter will create for this sandbox port. */
  service?(attempt: {
    sandboxId: string;
    sandboxName: string;
    slug: string;
    port: number;
  }): void | Promise<void>;
  /**
   * After a Service's create or delete settles. `created`: the Service at `slug` was made for this
   * sandbox. `refused`: a 4xx (or never sent) made nothing. `conflict`: a 409 (or a live Service now
   * targeting another sandbox), so the slug is someone else's and must never be deleted as this
   * sandbox's. `deleted`: the adapter deleted the Service and released its slug. Not called when a
   * create outcome stays unknown, so a journal entry for it stays pending.
   */
  serviceSettled?(outcome: {
    sandboxId: string;
    slug: string;
    outcome: "created" | "refused" | "conflict" | "deleted";
    createdAt?: string | undefined;
  }): void | Promise<void>;
}

export interface MicrosandboxOptions {
  /** Defaults to MSB_API_KEY. */
  apiKey?: string;
  /** The API host. Default: MSB_API_URL, else https://api.microsandbox.dev. */
  baseUrl?: string;
  /**
   * Compute tier of new sandboxes and snapshot restores: `"standard"` (dedicated CPU) or `"shared"`. When
   * set, a create whose sandbox comes back on another tier is deleted and refused, and `list()` and
   * `find()` see only sandboxes on this tier. Default: the account's default (standard on paid plans).
   */
  computeType?: MicrosandboxComputeType;
  /** OCI image of fresh sandboxes. Default: `node:22-bookworm`. */
  image?: string;
  /** Hard lifetime of a sandbox created without `timeoutMs` (`max_duration_secs`). Default: 1 hour. */
  timeoutMs?: number;
  /** Deadline for each control-plane request, retries included. Default: 60 seconds. */
  requestTimeoutMs?: number;
  /** See {@link MicrosandboxHooks}. Also settable later with `provider.setAttemptHooks`. */
  hooks?: MicrosandboxHooks;
  /**
   * How to load the `microsandbox` package. Default: `() => import("microsandbox")`. Pass your own
   * import when a bundler needs it spelled out, or a stand-in for tests.
   */
  peer?: () => Promise<MicrosandboxModule>;
  /** For tests. */
  fetch?: Fetch;
}

/** The npm package the adapter loads for commands and files, and that `native.sdk()` binds. */
const sdkPackage = "microsandbox";

/** What `native.sdk()` needs from `microsandbox`: its `RemoteContext`. */
export interface MicrosandboxSdkModule {
  RemoteContext: new (options: PeerContextOptions) => {
    readonly sandboxes: { get(name: string): Promise<object> };
  };
}

/** `box.native.sdk(() => import("microsandbox"))`: a `RemoteContext` with this adapter's key, and the sandbox from `context.sandboxes.get`. */
export type MicrosandboxSandboxSdk = <M extends MicrosandboxSdkModule>(
  load: () => Promise<M>,
) => Promise<{
  context: InstanceType<M["RemoteContext"]>;
  sandbox: Awaited<ReturnType<InstanceType<M["RemoteContext"]>["sandboxes"]["get"]>>;
}>;

/** `provider.api.sdk(() => import("microsandbox"))`: a `RemoteContext` with this adapter's key. */
export type MicrosandboxClientSdk = <M extends MicrosandboxSdkModule>(
  load: () => Promise<M>,
) => Promise<InstanceType<M["RemoteContext"]>>;

/** `box.native`: Microsandbox's control plane with this adapter's key, `{id}` bound to the sandbox. */
export type MicrosandboxNative = NativeApi<MicrosandboxPlane, MicrosandboxSandboxSdk>;

export type MicrosandboxProvider = Provider<MicrosandboxNative, MicrosandboxCapability> & {
  /** Account-level calls, such as `api.request("GET", "/snapshots")`. */
  readonly api: NativeApi<MicrosandboxPlane, MicrosandboxClientSdk>;
  /** The {@link MicrosandboxOptions.computeType} this adapter creates and lists on; undefined for the account default. */
  readonly computeType: MicrosandboxComputeType | undefined;
  /** Replaces the {@link MicrosandboxHooks}. For harnesses that journal allocations before they are made. */
  setAttemptHooks(hooks: MicrosandboxHooks | undefined): void;
};

/** Size presets: vCPUs and MiB of memory. Disk is the cloud's default. */
const presets = {
  small: { vcpus: 1, memory_mib: 1024 },
  medium: { vcpus: 2, memory_mib: 4096 },
  large: { vcpus: 4, memory_mib: 8192 },
} as const;

const defaultImage = "node:22-bookworm";
const defaultLifetimeMs = 3_600_000;

/** How long cleanup and reconciliation after a failed, lost or aborted call may take, on its own deadline. */
const cleanupMs = 60_000;

/** How long a create waits for its sandbox to run, server wait and polling together. */
const readyMs = 180_000;

/** The server-side wait a create asks for (`wait_timeout`), in seconds. */
const serverWaitSeconds = 60;

/** How long a reconciliation keeps reading a name that answers 404: a create can be slow to appear. */
const missingGraceMs = 15_000;

/** How long a snapshot capture may take, from the request to a terminal operation. */
const captureMs = 600_000;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The largest value of an OpenAPI `int32` field, such as `CloudSandboxResources.vcpus`. */
const int32Max = 2_147_483_647;

/** The deterministic slug prefix of every Service the adapter makes for sandbox `id`. */
const slugBase = (id: string) => `sbx-${id.replaceAll("-", "").slice(0, 16).toLowerCase()}`;

/** Whether `slug` is one the adapter would make for sandbox `id`: `sbx-<16 hex>-p<port>`, optionally `-<4 hex>`. */
export function isOwnedSlug(slug: string, id: string): boolean {
  const base = slugBase(id);

  return (
    slug.startsWith(`${base}-p`) && /^-p[0-9]{1,5}(?:-[0-9a-f]{4})?$/.test(slug.slice(base.length))
  );
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);

    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }

    signal?.addEventListener("abort", done, { once: true });
  });
}

const statusOf = (cause: unknown) => httpStatus(cause)?.status;

const isGone = (cause: unknown) => statusOf(cause) === 404;

/** A failed write the server answered with a 4xx: refused before anything took effect. */
const refused = (cause: unknown) => {
  const status = statusOf(cause);

  return status !== undefined && status >= 400 && status < 500;
};

/** Size fields of a create body (`CloudSandboxResources` or, for a restore, `CloudSandboxComputeResources`). */
function resourcesOf(size: CreateInput["size"], restore: boolean): JsonObject | undefined {
  if (size === undefined) return undefined;

  if (isString(size)) return { ...presets[size] };

  if (!Number.isSafeInteger(size.cpu) || size.cpu < 1 || size.cpu > int32Max)
    throw fail(
      `cpu must be a whole number from 1 to ${int32Max}, not ${size.cpu}`,
      "invalid_argument",
    );

  if (!Number.isSafeInteger(size.memoryMb) || size.memoryMb < 128 || size.memoryMb > int32Max)
    throw fail(
      `memoryMb must be a whole number from 128 to ${int32Max}, not ${size.memoryMb}`,
      "invalid_argument",
    );
  const resources: JsonObject = { vcpus: size.cpu, memory_mib: size.memoryMb };

  if (size.diskGb !== undefined) {
    // A disk snapshot restore takes CPU and memory only (`CloudSandboxComputeResources`).
    if (restore)
      throw fail(
        "a snapshot restore keeps the snapshot's disk; omit diskGb when creating from a snapshot",
        "unsupported",
      );

    const diskMib = Math.round(size.diskGb * 1024);

    if (!Number.isFinite(size.diskGb) || size.diskGb <= 0 || diskMib < 1 || diskMib > int32Max)
      throw fail(
        `diskGb must be a positive number of at most ${int32Max} MiB, not ${size.diskGb}`,
        "invalid_argument",
      );
    resources.disk_size_mib = diskMib;
  }

  return resources;
}

/** A host allow-list entry as a `Destination`: an IP or CIDR, `*.domain` as a suffix, else an exact domain. */
function destinationOf(entry: string): JsonObject {
  const host = entry.trim().toLowerCase();

  if (/^[0-9.]+(?:\/[0-9]{1,2})?$/.test(host) || (host.includes(":") && /^[0-9a-f:/]+$/.test(host)))
    return { cidr: host };

  if (host.startsWith("*.") && /^[a-z0-9.-]+$/.test(host.slice(2)))
    return { domain_suffix: host.slice(2) };

  if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host))
    return { domain: host };

  throw fail(
    `the network allow list entry ${JSON.stringify(entry.slice(0, 80))} is not a host name, *.domain, IP or CIDR`,
    "unsupported",
  );
}

/** `CloudNetworkSpec` for a create's `network`. */
function networkOf(network: CreateInput["network"]): JsonObject {
  if (network === undefined || network === "all") return { enabled: true };

  if (network === "none" || network.allow.length === 0) return { enabled: false };

  // Deny by default: only the listed destinations, whose names also resolve (a domain rule permits its
  // own lookups). Ingress stays open so the sandbox's Services keep working.
  return {
    enabled: true,
    policy: {
      default_egress: "deny",
      default_ingress: "allow",
      rules: network.allow.map((entry) => ({
        direction: "egress",
        destination: destinationOf(entry),
        action: "allow",
      })),
    },
  };
}

/** Whole seconds, at least `min`, rounded up; otherwise `invalid_argument` naming the option. */
function seconds(ms: number, option: string, min: number) {
  const value = Math.ceil(ms / 1000);

  if (!Number.isFinite(value) || value < min)
    throw fail(`${option} must be at least ${min} second(s)`, "invalid_argument");

  return value;
}

/** Run once in a new sandbox, also one restored from a snapshot: the SDK works in /workspace. */
const setupCommand = "mkdir -p /workspace";

/** @internal The adapter behind `microsandbox()`. `load` imports `microsandbox`; tests pass a fixture. */
export function createMicrosandboxProvider(
  options: MicrosandboxOptions,
  load: () => Promise<MicrosandboxModule>,
): MicrosandboxProvider {
  const root = (options.baseUrl ?? process.env.MSB_API_URL ?? "https://api.microsandbox.dev")
    .trim()
    .replace(/\/+$/, "");

  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const computeType = options.computeType;
  let hooks: MicrosandboxHooks = options.hooks ?? {};

  /** Sandbox ID to name: names route the guest agent and Services; IDs never change. */
  const names = new Map<string, string>();
  /** Guest agent handles per sandbox ID, made once and dropped when the sandbox stops or goes. */
  const handles = new Map<string, Promise<PeerSandbox>>();

  /** Service slugs this adapter made or was about to make, per sandbox ID, with target name and creation timestamp. */
  const ownedServices = new Map<
    string,
    Map<string, { target: string; createdAt?: string | undefined }>
  >();

  /** Public Service URLs per sandbox ID and port. */
  const previews = new Map<string, string>();
  /** Tokens seen in answers, for redaction. Kept for the client's life. */
  const tokens = new Set<string>();

  if (computeType !== undefined && computeType !== "standard" && computeType !== "shared")
    throw fail(`computeType must be "standard" or "shared"`, "invalid_argument");

  function apiKey() {
    const key = (options.apiKey ?? process.env.MSB_API_KEY)?.trim();

    if (!key)
      throw fail(
        "the API key is missing. Authentication is required. Set MSB_API_KEY or pass apiKey",
        "auth",
      );

    return key;
  }

  const secrets = () => [options.apiKey, process.env.MSB_API_KEY, ...tokens];

  const http = createHttpClient<MicrosandboxPlane>({
    provider: name,
    label: "Microsandbox",
    planes: {
      // The cloud never redirects a write; following one could send it twice.
      control: {
        baseUrl: `${root}/v1`,
        auth: () => ({ Authorization: `Bearer ${apiKey()}` }),
        redirectWrites: false,
      },
    },
    defaultPlane: "control",
    fetch: options.fetch,
    timeoutMs: requestTimeoutMs,
    secrets,
    credentialPatterns: leakPatterns,
    authHint: "Set MSB_API_KEY to a valid Microsandbox organization API key.",
    mapError,
  });

  const redact = (text: string) => http.redact(text);

  // ---------------------------------------------------------------- the peer

  /** The `RemoteContext` options: this adapter's key, URL, timeout and tier, never the process's defaults. */
  function peerSettings(): PeerContextOptions {
    const settings: PeerContextOptions = { url: root, apiKey: apiKey(), requestTimeoutMs };

    if (computeType !== undefined) settings.computeType = computeType;

    return settings;
  }

  let peerContext: Promise<PeerContext> | undefined;

  /**
   * The `microsandbox` `RemoteContext` for this adapter's key, URL and tier, built once. A missing peer, or
   * one whose native addon cannot load (a bundle that inlined it, optional dependencies omitted), fails
   * here with `unavailable` naming the fix. `create` calls this before sending anything.
   */
  async function context(): Promise<PeerContext> {
    peerContext ??= (async () => {
      const settings = peerSettings();
      let module: MicrosandboxModule;

      try {
        module = await loadPeer(sdkPackage, name, load);
      } catch (error) {
        // A missing package or a bundle without require is already named; anything else is the peer
        // failing to load where it was put (a CommonJS bundle that inlined it has no import.meta.url).
        if (error instanceof SandboxError) throw error;

        throw fail(`microsandbox could not load. ${nativeHint}`, "unavailable", {
          hint: nativeHint,
          cause: error instanceof Error ? redact(error.message) : undefined,
        });
      }

      try {
        return new module.RemoteContext(settings);
      } catch (error) {
        if (error instanceof SandboxError) throw error;

        throw fail(
          `microsandbox loaded, but its RemoteContext could not start. ${nativeHint}`,
          "unavailable",
          { hint: nativeHint, cause: error instanceof Error ? redact(error.message) : undefined },
        );
      }
    })();

    try {
      return await peerContext;
    } catch (error) {
      // A failed setup (no key, no peer) is retried on the next call.
      peerContext = undefined;
      throw error;
    }
  }

  /** The guest agent handle of sandbox `id`, through this adapter's own `RemoteContext`. */
  function handle(id: string): Promise<PeerSandbox> {
    let known = handles.get(id);

    if (!known) {
      known = (async () => {
        const sandboxName = await nameOf(id);
        const peer = await context();

        try {
          return await peer.sandboxes.get(sandboxName);
        } catch (error) {
          throw peerError(error, "connecting to the sandbox", { sandboxId: id, redact });
        }
      })();
      handles.set(id, known);
      known.catch(() => {
        if (handles.get(id) === known) handles.delete(id);
      });
    }

    return known;
  }

  // ---------------------------------------------------------------- control plane

  const sandboxPath = (id: string, route = "") => ({
    path: `/sandboxes/{id}${route}`,
    params: { id },
    sandboxId: id,
  });

  /** Reads one sandbox by its immutable ID and remembers its name. */
  async function readSandbox(
    id: string,
    request: Partial<HttpRequest<MicrosandboxPlane>> = {},
  ): Promise<MicrosandboxSandbox> {
    const sandbox = parseSandbox(
      await http.json({ method: "GET", ...sandboxPath(id), ...request }),
    );

    if (sandbox.id !== id)
      throw fail("the API answered with another sandbox", "provider", { sandboxId: id });
    names.set(id, sandbox.name);

    return sandbox;
  }

  /** Reads one sandbox by name: a create's sandbox before its ID is known. */
  async function readByName(sandboxName: string, request: Partial<HttpRequest<MicrosandboxPlane>>) {
    return parseSandbox(
      await http.json({
        method: "GET",
        path: "/sandboxes/by-name/{name}",
        params: { name: sandboxName },
        ...request,
      }),
    );
  }

  async function nameOf(id: string): Promise<string> {
    return names.get(id) ?? (await readSandbox(id)).name;
  }

  const ownsLabels = (sandbox: MicrosandboxSandbox, labels: Labels) => {
    const own = sandbox.spec?.labels;

    return own !== undefined && Object.entries(labels).every(([k, v]) => own[k] === v);
  };

  const onTier = (sandbox: MicrosandboxSandbox) =>
    computeType === undefined || sandbox.compute === computeType;

  /** Sandboxes whose labels include every one of `labels`, on this adapter's tier, across all pages. */
  async function listSandboxes(labels: Labels): Promise<MicrosandboxSandbox[]> {
    const found: MicrosandboxSandbox[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 1000; page++) {
      const query = {
        limit: 100,
        labels: Object.keys(labels).length > 0 ? JSON.stringify(labels) : undefined,
        cursor,
      };

      const answer = parseSandboxPage(
        await http.json({ method: "GET", path: "/sandboxes", query }),
      );

      for (const sandbox of answer.data) names.set(sandbox.id, sandbox.name);
      found.push(...answer.data);
      cursor = answer.nextCursor;

      if (cursor === undefined) break;
    }

    // The server's filter is checked again: a looser match, or another tier, is never reported.
    return found.filter((s) => onTier(s) && ownsLabels(s, labels));
  }

  function forget(id: string) {
    names.delete(id);
    handles.delete(id);

    for (const key of previews.keys()) if (key.startsWith(`${id}:`)) previews.delete(key);
  }

  /** Polls until the sandbox runs; `failed` and other end states throw. Never past `deadline`. */
  async function untilRunning(id: string, deadline: Deadline, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw fail("creation aborted", "aborted", { sandboxId: id });
      const sandbox = await readSandbox(id, { deadline });

      if (sandbox.status === "running") return sandbox;

      if (!["created", "starting", "temporarily_unavailable"].includes(sandbox.status))
        throw fail(`the sandbox is ${sandbox.status}, not running`, "provider", { sandboxId: id });

      if (deadline.remaining() <= 0)
        throw fail("the sandbox did not start in time", "timeout", { sandboxId: id });
      await delay(Math.min(2000, 250 * 2 ** attempt), signal);
    }
  }

  /** Polls until the sandbox is stopped. */
  async function untilStopped(id: string, deadline: Deadline) {
    for (let attempt = 0; ; attempt++) {
      const sandbox = await readSandbox(id, { deadline });

      if (sandbox.status === "stopped") return;

      if (sandbox.status === "failed")
        throw fail("the sandbox failed while stopping", "provider", { sandboxId: id });

      if (deadline.remaining() <= 0)
        throw fail("the sandbox did not stop in time", "timeout", { sandboxId: id });
      await delay(Math.min(2000, 250 * 2 ** attempt));
    }
  }

  /** Starts a stopped or created sandbox and waits for it to run. A 409 (already starting) is waited out. */
  async function start(id: string, deadline: Deadline, signal?: AbortSignal) {
    handles.delete(id);

    try {
      await http.request({
        method: "POST",
        ...sandboxPath(id, "/start"),
        query: { wait_for: "running", wait_timeout: String(serverWaitSeconds) },
        deadline,
      });
    } catch (error) {
      if (statusOf(error) !== 409) throw error;
    }

    return untilRunning(id, deadline, signal);
  }

  /** Records Service `slug` of sandbox `id` as this adapter's, so a later destroy still finds it once detached. */
  function ownService(id: string, slug: string, sandboxName: string, createdAt?: string) {
    const owned =
      ownedServices.get(id) ??
      new Map<string, { target: string; createdAt?: string | undefined }>();

    const existing = owned.get(slug);
    owned.set(slug, { target: sandboxName, createdAt: createdAt ?? existing?.createdAt });
    ownedServices.set(id, owned);

    return owned;
  }

  /**
   * Notifies `serviceSettled` during cleanup with a tight bound so a stalled hook never holds up
   * sandbox deletion.
   */
  async function notifyServiceCleanup(
    outcome: {
      sandboxId: string;
      slug: string;
      outcome: "conflict" | "deleted";
    },
    deadline: Deadline,
  ) {
    const callback = hooks.serviceSettled;

    if (callback === undefined) return;
    const waitMs = Math.min(200, Math.max(1, deadline.remaining()));
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        Promise.resolve().then(() => callback(outcome)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      // Cleanup never fails or delays sandbox deletion because a settlement hook rejected.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Deletes the Services this adapter made for sandbox `id`. Candidates come from memory (which survives
   * a detached sandbox) and from the cloud's list filtered by the sandbox's name; each must match the
   * adapter's own slug shape for this ID and still target this sandbox (or nothing) before it is deleted.
   * A listed one joins memory, so if its delete fails, the next destroy retries it after the sandbox is
   * gone and the list no longer shows it. Returns the slugs whose deletion failed.
   */
  async function removeServices(id: string, sandboxName: string | undefined, deadline: Deadline) {
    const failed: string[] = [];

    if (sandboxName !== undefined)
      try {
        let cursor: string | undefined;

        for (let page = 0; page < 100; page++) {
          const query = { sandbox: sandboxName, limit: 100, cursor };

          const answer = parseServicePage(
            await http.json({ method: "GET", path: "/services", query, deadline }),
          );

          for (const service of answer.data)
            if (isOwnedSlug(service.slug, id) && service.target?.sandbox === sandboxName)
              ownService(id, service.slug, sandboxName, service.createdAt);
          cursor = answer.nextCursor;

          if (cursor === undefined) break;
        }
      } catch {
        // The list is a second source; memory still names what this adapter made.
      }

    // Deleting the entry being visited is safe while iterating a Map.
    for (const [slug, entry] of ownedServices.get(id) ??
      new Map<string, { target: string; createdAt?: string | undefined }>()) {
      if (!isOwnedSlug(slug, id)) continue;

      try {
        let service: MicrosandboxService;

        try {
          service = parseService(
            await http.json({
              method: "GET",
              path: "/services/{slug}",
              params: { slug },
              deadline,
            }),
          );
        } catch (error) {
          if (isGone(error)) {
            ownedServices.get(id)?.delete(slug);
            continue;
          }

          throw error;
        }

        // Never a Service that now targets another sandbox, or a detached Service whose creation
        // timestamp does not prove it is the same Service instance this adapter owned.
        if (service.target !== null) {
          if (service.target.sandbox !== entry.target) {
            ownedServices.get(id)?.delete(slug);
            await notifyServiceCleanup({ sandboxId: id, slug, outcome: "conflict" }, deadline);
            continue;
          }
        } else if (
          entry.createdAt === undefined ||
          service.createdAt === undefined ||
          service.createdAt !== entry.createdAt
        ) {
          ownedServices.get(id)?.delete(slug);

          if (
            entry.createdAt !== undefined &&
            service.createdAt !== undefined &&
            service.createdAt !== entry.createdAt
          )
            await notifyServiceCleanup({ sandboxId: id, slug, outcome: "conflict" }, deadline);
          continue;
        }

        try {
          await http.request({
            method: "DELETE",
            path: "/services/{slug}",
            params: { slug },
            deadline,
          });
        } catch (error) {
          if (!isGone(error)) throw error;
        }

        ownedServices.get(id)?.delete(slug);
        await notifyServiceCleanup({ sandboxId: id, slug, outcome: "deleted" }, deadline);
      } catch {
        failed.push(slug);
      }
    }

    if (ownedServices.get(id)?.size === 0) ownedServices.delete(id);

    return failed;
  }

  /**
   * Deletes a sandbox: its adapter-owned Services first, then the sandbox itself, which always runs even
   * when a Service could not be removed. A 404 is gone. A failed Service is kept in memory for the next
   * try and reported after the sandbox is deleted. The name lookup, the Services and the sandbox delete
   * each get their own `budgetMs` deadline, started when that step starts: a Service step that uses up
   * its time never stops the sandbox delete from being sent.
   */
  async function destroy(id: string, budgetMs = cleanupMs) {
    let sandboxName = names.get(id);

    if (sandboxName === undefined)
      try {
        sandboxName = (await readSandbox(id, { deadline: createDeadline(budgetMs) })).name;
      } catch {
        // Gone, or unreadable: the Services in memory are still removed, and the delete still runs.
      }

    let failedServices: string[] = [];

    try {
      failedServices = await removeServices(id, sandboxName, createDeadline(budgetMs));
    } catch {
      failedServices = [...(ownedServices.get(id)?.keys() ?? [])];
    }

    try {
      await http.request({
        method: "DELETE",
        ...sandboxPath(id),
        deadline: createDeadline(budgetMs),
      });
    } catch (error) {
      if (!isGone(error)) throw error;
    } finally {
      forget(id);
    }

    if (failedServices.length > 0)
      throw fail(
        `the sandbox was deleted, but ${failedServices.length} of its Services (${failedServices.join(", ")}) could not be removed; destroy again to retry`,
        "provider",
        { sandboxId: id },
      );
  }

  /** Deletes a sandbox this call made, on a fresh deadline, then reports `cause`. */
  async function abandon(id: string, cause: unknown): Promise<never> {
    try {
      await destroy(id);
    } catch {
      throw fail(
        `sandbox ${id} was created but did not finish setting up, and it could not be confirmed deleted. Delete it before retrying`,
        "outcome_unknown",
        { sandboxId: id },
      );
    }

    if (cause instanceof SandboxError) throw cause;
    throw fail("the sandbox did not finish setting up", "provider", { sandboxId: id });
  }

  /**
   * After a create whose answer was lost, unreadable, ambiguous or aborted: reads the chosen name on a
   * fresh deadline until a sandbox carrying this call's allocation marker appears. A 404 is read again
   * for {@link missingGraceMs} (a create can take a moment to appear), and a sandbox whose spec is not
   * resolved yet while it is created or starting is read again too. Never returns a sandbox without this
   * call's marker; `unknown` is thrown when nothing settles it.
   */
  async function reconcile(sandboxName: string, alloc: string, unknown: SandboxError) {
    const deadline = createDeadline(cleanupMs);
    const firstMissing = Date.now();

    for (let attempt = 0; deadline.remaining() > 0; attempt++) {
      let sandbox: MicrosandboxSandbox | undefined;

      try {
        sandbox = await readByName(sandboxName, { deadline });
      } catch (error) {
        // Still missing after the grace period: whatever happened, it cannot be found to settle it.
        if (isGone(error) && Date.now() - firstMissing >= missingGraceMs) break;
      }

      if (sandbox !== undefined) {
        const marker = sandbox.spec?.labels[allocLabel];

        if (marker === alloc) {
          names.set(sandbox.id, sandbox.name);

          return sandbox;
        }

        // Another call's sandbox under this name: never this call's to return or delete.
        if (sandbox.spec !== null)
          throw fail(
            `the sandbox named ${sandboxName} carries another allocation marker; it was left alone`,
            "outcome_unknown",
            { sandboxId: sandbox.id },
          );
      }

      await delay(Math.min(2000, 250 * 2 ** attempt));
    }

    throw unknown;
  }

  /** The managed snapshot ID a restore names: a UUID as is, else a snapshot name looked up. */
  async function snapshotRef(from: string): Promise<string> {
    if (uuidPattern.test(from)) return from;
    let snapshot: MicrosandboxSnapshot;

    try {
      snapshot = parseSnapshot(
        await http.json({
          method: "GET",
          path: "/snapshots/by-name/{name}",
          params: { name: from },
        }),
      );
    } catch (error) {
      if (isGone(error)) throw fail(`snapshot ${from} was not found`, "not_found");
      throw error;
    }

    if (snapshot.location.type !== "managed")
      throw fail(`snapshot ${from} is not in managed storage`, "unsupported");

    return snapshot.location.id;
  }

  function createBody(
    input: CreateInput,
    sandboxName: string,
    alloc: string,
    ref: string | undefined,
  ) {
    const labels: Labels = { ...input.labels, [allocLabel]: alloc };

    if (input.key !== undefined) labels[keyLabel] = input.key;

    const lifecycle: JsonObject = {
      ephemeral: false,
      max_duration_secs: seconds(
        input.timeoutMs ?? options.timeoutMs ?? defaultLifetimeMs,
        "timeoutMs",
        1,
      ),
    };

    if (input.idleTimeoutMs !== undefined)
      lifecycle.idle_timeout_secs = seconds(input.idleTimeoutMs, "idleTimeoutMs", 1);

    const spec: JsonObject = {
      name: sandboxName,
      labels,
      lifecycle,
      network: networkOf(input.network),
      env: Object.entries(input.env ?? {}).map(([key, value]) => ({ key, value })),
    };

    const resources = resourcesOf(input.size, ref !== undefined);

    if (ref === undefined) {
      spec.source = "oci";
      spec.reference = options.image ?? defaultImage;
    } else {
      spec.source = "disk_snapshot";
      spec.disk_snapshot_ref = { type: "managed", id: ref };
    }

    if (resources !== undefined) spec.resources = resources;
    const body: JsonObject = { spec };

    // Kept in the nested envelope: an API that ignored a flat `compute` could pick the wrong tier.
    if (computeType !== undefined) body.compute = { type: computeType };

    return body;
  }

  async function createSandbox(input: CreateInput): Promise<SandboxInfo> {
    // Everything that can be refused locally is checked before anything is sent.
    if (
      input.from !== undefined &&
      input.size !== undefined &&
      !isString(input.size) &&
      input.size.diskGb !== undefined
    )
      throw fail(
        "a snapshot restore keeps the snapshot's disk; omit diskGb when creating from a snapshot",
        "unsupported",
      );
    networkOf(input.network);
    resourcesOf(input.size, input.from !== undefined);

    // The peer gate: no billable sandbox is made for a client that could never run a command in it.
    await context();

    const ref = input.from === undefined ? undefined : await snapshotRef(input.from);
    const sandboxName = `sbx-${randomUUID()}`;
    const alloc = randomUUID();
    const body = createBody(input, sandboxName, alloc, ref);

    await hooks.create?.({
      name: sandboxName,
      allocId: alloc,
      from: input.from,
      labels: { ...input.labels },
    });

    if (input.signal?.aborted) throw fail("creation aborted", "aborted");

    let answer: SandboxAnswer;

    try {
      answer = parseSandboxAnswer(
        await http.json({
          method: "POST",
          path: "/sandboxes",
          query: {
            start: "true",
            wait_for: "running",
            wait_timeout: String(serverWaitSeconds),
          },
          body,
          signal: input.signal,
          timeoutMs: requestTimeoutMs + serverWaitSeconds * 1000,
        }),
      );
    } catch (error) {
      // Refused before anything was made: never left this process, or a 4xx.
      if (neverSent(error) || refused(error)) throw error;

      const unknown = fail(
        `the create of sandbox ${sandboxName} may or may not have taken effect; it was not found in time. Look it up by name before retrying`,
        "outcome_unknown",
        { cause: error instanceof SandboxError ? error.message : undefined },
      );

      answer = { kind: "sandbox", sandbox: await reconcile(sandboxName, alloc, unknown) };
    }

    let sandbox: MicrosandboxSandbox;

    if (answer.kind === "unreadable" || answer.sandbox.spec?.labels[allocLabel] !== alloc) {
      // An unreadable answer, or one whose spec is not resolved yet, may still be this call's sandbox.
      if (
        answer.kind === "sandbox" &&
        answer.sandbox.spec !== null &&
        answer.sandbox.name === sandboxName
      )
        throw fail(
          `the create answered with sandbox ${answer.sandbox.id}, which carries another allocation marker; it was left alone`,
          "outcome_unknown",
          { sandboxId: answer.sandbox.id },
        );
      sandbox = await reconcile(
        sandboxName,
        alloc,
        fail(
          `the create of sandbox ${sandboxName} was answered, but the answer did not show this call's marker; look it up by name before retrying`,
          "outcome_unknown",
        ),
      );
    } else sandbox = answer.sandbox;

    const id = sandbox.id;
    names.set(id, sandbox.name);

    try {
      if (input.signal?.aborted) throw fail("creation aborted", "aborted", { sandboxId: id });

      // The tier the cloud chose must be the one asked for.
      if (computeType !== undefined && sandbox.compute !== computeType)
        throw fail(
          `the sandbox runs on ${sandbox.compute ?? "an unknown"} compute, not ${computeType}`,
          "provider",
          { sandboxId: id },
        );

      const deadline = createDeadline(readyMs);

      if (sandbox.status === "created") sandbox = await start(id, deadline, input.signal);
      else if (sandbox.status !== "running")
        sandbox = await untilRunning(id, deadline, input.signal);

      const guest = await handle(id);
      await shell(id, setupCommand, 60_000, guest);

      if (input.signal?.aborted) throw fail("creation aborted", "aborted", { sandboxId: id });
    } catch (error) {
      return abandon(id, error);
    }

    return {
      id,
      key: input.key,
      labels: { ...input.labels },
      state: "running",
      createdAt: sandbox.createdAt || Date.now(),
    };
  }

  // ---------------------------------------------------------------- commands and files

  async function exec(id: string, input: ExecInput) {
    if (input.signal?.aborted) return { exitCode: null, timedOut: true };
    const sandbox = await handle(id);

    return execute({ sandbox, exec: input, sandboxId: id, redact });
  }

  /** A short command for the adapter itself: its stdout, or a failure on a non-zero exit. */
  async function shell(id: string, command: string, timeoutMs = 120_000, known?: PeerSandbox) {
    let stdout = "";
    const sandbox = known ?? (await handle(id));

    const result = await execute({
      sandbox,
      sandboxId: id,
      redact,
      exec: {
        command,
        cwd: "/",
        env: {},
        timeoutMs,
        onChunk: (chunk) => {
          if (chunk.stream === "stdout") stdout += chunk.text;
        },
      },
    });

    if (result.timedOut) throw fail("a guest command timed out", "timeout", { sandboxId: id });

    if (result.exitCode !== 0)
      throw fail(`a guest command failed (exit ${result.exitCode})`, "provider", { sandboxId: id });

    return stdout;
  }

  const guest = (id: string): Guest => ({
    name,
    raw: (command) => shell(id, command),
    upload: async (path, bytes) => {
      const sandbox = await handle(id);

      try {
        await sandbox.fs().write(path, bytes);
      } catch (error) {
        throw peerError(error, "writing a file", { sandboxId: id, redact, files: true });
      }
    },
    read: async (path, range) => {
      const sandbox = await handle(id);
      let bytes: Uint8Array;

      try {
        bytes = await sandbox.fs().read(path);
      } catch (error) {
        throw peerError(error, "reading a file", { sandboxId: id, redact, files: true });
      }

      return range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
    },
  });

  const files = guestFiles(
    async (id) => guest(id),
    async (_id, action) => action(),
  );

  // ---------------------------------------------------------------- previews

  /** The Service at `slug` when it routes `port` of the sandbox named `sandboxName`; undefined when absent. */
  async function readService(slug: string): Promise<MicrosandboxService | undefined> {
    try {
      return parseService(
        await http.json({ method: "GET", path: "/services/{slug}", params: { slug } }),
      );
    } catch (error) {
      if (isGone(error)) return undefined;
      throw error;
    }
  }

  const routes = (service: MicrosandboxService, sandboxName: string, port: number) =>
    service.target?.sandbox === sandboxName &&
    service.target.port === port &&
    service.status === "enabled";

  async function createService(id: string, sandboxName: string, slug: string, port: number) {
    // Journaled before the request: a lost answer may still have made it.
    await hooks.service?.({ sandboxId: id, sandboxName, slug, port });
    const owned = ownService(id, slug, sandboxName);
    let created: MicrosandboxService;

    try {
      created = parseService(
        await http.json({
          method: "POST",
          path: "/services",
          body: { slug, target: { sandbox: sandboxName, port } },
        }),
      );
    } catch (error) {
      if (neverSent(error) || (refused(error) && statusOf(error) !== 409)) {
        owned.delete(slug);

        // The refusal is what the caller sees; a journal that could not record it keeps the entry
        // pending, which recovery settles.
        try {
          await hooks.serviceSettled?.({ sandboxId: id, slug, outcome: "refused" });
        } catch {
          // Reported through `error` below.
        }

        throw error;
      }

      // A 409: the slug belongs to someone else, never touched, and the journal is told before any
      // other slug is tried. Anything else: read what was made.
      if (statusOf(error) === 409) {
        owned.delete(slug);
        await hooks.serviceSettled?.({ sandboxId: id, slug, outcome: "conflict" });

        return "taken" as const;
      }

      const found = await readService(slug).catch(() => undefined);

      if (found === undefined) throw error;
      created = found;
    }

    if (created.target?.sandbox === sandboxName) {
      ownService(id, slug, sandboxName, created.createdAt);
      await hooks.serviceSettled?.({
        sandboxId: id,
        slug,
        outcome: "created",
        createdAt: created.createdAt,
      });
    }

    return created;
  }

  async function previewUrl(id: string, port: number) {
    const cached = previews.get(`${id}:${port}`);

    if (cached) return { url: cached };

    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw fail(`port must be a whole number from 1 to 65535, not ${port}`, "invalid_argument");
    const sandboxName = await nameOf(id);
    const slug = `${slugBase(id)}-p${port}`;
    let service: MicrosandboxService | "taken" | undefined = await readService(slug);

    // An existing Service at the adapter's slug is reused only when it routes exactly this port.
    if (service !== undefined && !routes(service, sandboxName, port)) service = "taken";
    else if (service === undefined) service = await createService(id, sandboxName, slug, port);

    if (service === "taken") {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 4);
      service = await createService(id, sandboxName, `${slug}-${suffix}`, port);
    }

    if (service === "taken" || !routes(service, sandboxName, port))
      throw fail(`no Service could be made for port ${port}`, "provider", { sandboxId: id });
    ownService(id, service.slug, sandboxName, service.createdAt);
    const url = serviceUrl(service);

    for (const token of tokensIn(url)) tokens.add(token);
    previews.set(`${id}:${port}`, url);

    return { url };
  }

  // ---------------------------------------------------------------- snapshots

  /** Restarts a source sandbox that was running before a snapshot; never throws. */
  async function restart(id: string): Promise<boolean> {
    try {
      await start(id, createDeadline(readyMs));

      return true;
    } catch {
      return false;
    }
  }

  /** The operation that captures `snapshotName`, from the list of recent operations, or undefined. */
  async function findOperation(snapshotName: string, id: string, deadline: Deadline) {
    let cursor: string | undefined;

    for (let page = 0; page < 5; page++) {
      const query = { limit: 100, cursor };

      const answer = parseOperationPage(
        await http.json({ method: "GET", path: "/snapshot-operations", query, deadline }),
      );

      const match = answer.data.find(
        (op) =>
          op.snapshotName === snapshotName && (op.sandboxId === undefined || op.sandboxId === id),
      );

      if (match) return match;
      cursor = answer.nextCursor;

      if (cursor === undefined) return undefined;
    }

    return undefined;
  }

  /** The snapshot named `snapshotName`, or undefined on a 404. */
  async function snapshotByName(snapshotName: string, deadline: Deadline) {
    try {
      return parseSnapshot(
        await http.json({
          method: "GET",
          path: "/snapshots/by-name/{name}",
          params: { name: snapshotName },
          deadline,
        }),
      );
    } catch (error) {
      if (isGone(error)) return undefined;
      throw error;
    }
  }

  type Settled =
    | { kind: "succeeded"; snapshot: MicrosandboxSnapshot | undefined }
    | { kind: "failed" }
    | { kind: "pending"; operationId: string | undefined };

  /**
   * After a capture whose answer was lost: looks the capture up by its name, in the operations list and
   * as a snapshot, on a fresh deadline, until one of them shows a terminal outcome.
   */
  async function settleLostCapture(snapshotName: string, id: string): Promise<Settled> {
    const deadline = createDeadline(captureMs);
    let operationId: string | undefined;

    for (let attempt = 0; deadline.remaining() > 0; attempt++) {
      try {
        const snapshot = await snapshotByName(snapshotName, deadline);

        if (snapshot !== undefined) return { kind: "succeeded", snapshot };
        const op = await findOperation(snapshotName, id, deadline);

        if (op !== undefined) {
          operationId = op.id;

          if (op.status === "failed") return { kind: "failed" };

          if (op.status === "succeeded") return { kind: "succeeded", snapshot: op.result };
        }
      } catch {
        // Read again until the deadline.
      }

      await delay(Math.min(5000, 500 * 2 ** attempt));
    }

    return { kind: "pending", operationId };
  }

  /** Polls one capture operation until it is terminal. */
  async function settleOperation(operationId: string): Promise<Settled> {
    const deadline = createDeadline(captureMs);

    for (let attempt = 0; deadline.remaining() > 0; attempt++) {
      try {
        const op = parseOperation(
          await http.json({
            method: "GET",
            path: "/snapshot-operations/{op}",
            params: { op: operationId },
            deadline,
          }),
        );

        if (op.status === "failed") return { kind: "failed" };

        if (op.status === "succeeded") return { kind: "succeeded", snapshot: op.result };
      } catch {
        // Read again until the deadline.
      }

      await delay(Math.min(5000, 500 * 2 ** attempt));
    }

    return { kind: "pending", operationId };
  }

  async function snapshot(id: string, snapshotOptions?: { expiresInMs?: number }) {
    if (snapshotOptions?.expiresInMs)
      throw fail("snapshots are kept until deleted; omit expiresInMs", "unsupported", {
        sandboxId: id,
      });
    const snapshotName = `sandbox-sdk-${randomUUID()}`;

    // Journaled before the source is touched, so a capture that outlives this call is still found.
    await hooks.snapshot?.({ sandboxId: id, name: snapshotName });

    const before = await readSandbox(id);
    const wasRunning = before.status === "running" || before.status === "starting";

    if (wasRunning) {
      handles.delete(id);
      const deadline = createDeadline(readyMs);

      try {
        await http.request({ method: "POST", ...sandboxPath(id, "/stop"), deadline });
      } catch (error) {
        // A 409 is a stop already under way; an unknown outcome is settled by reading the status.
        if (refused(error) && statusOf(error) !== 409) throw error;
      }

      try {
        await untilStopped(id, deadline);
      } catch (error) {
        await restart(id);
        throw error;
      }
    }

    /** Reports `cause` after restarting a source that was running; the restart never hides it. */
    const afterRestart = async (cause: unknown): Promise<never> => {
      if (wasRunning) await restart(id);
      throw cause;
    };

    let settled: Settled;

    try {
      const op = parseOperation(
        await http.json({
          method: "POST",
          path: "/snapshots",
          body: {
            kind: "disk",
            sandbox_id: id,
            name: snapshotName,
            labels: { [sourceLabel]: id },
          },
          timeoutMs: requestTimeoutMs,
        }),
      );

      settled =
        op.status === "succeeded"
          ? { kind: "succeeded", snapshot: op.result }
          : op.status === "failed"
            ? { kind: "failed" }
            : await settleOperation(op.id);
    } catch (error) {
      // Refused before an operation started (400, 403, 404, 409, 422): nothing was captured.
      if (neverSent(error) || refused(error)) return afterRestart(error);
      settled = await settleLostCapture(snapshotName, id);
    }

    if (settled.kind === "failed")
      return afterRestart(fail("the snapshot capture failed", "provider", { sandboxId: id }));

    if (settled.kind === "pending")
      return afterRestart(
        fail(
          `the snapshot capture did not finish in time; it may still complete as ${snapshotName}. Delete it by name once it appears`,
          "outcome_unknown",
          { sandboxId: id },
        ),
      );

    let result = settled.snapshot;

    if (result === undefined)
      result = await snapshotByName(snapshotName, createDeadline(cleanupMs)).catch(() => undefined);

    if (
      result === undefined ||
      result.name !== snapshotName ||
      !capturedFrom(result, id) ||
      result.location.type !== "managed"
    )
      return afterRestart(
        fail(
          `the capture finished, but no managed snapshot of this sandbox named ${snapshotName} could be read`,
          "outcome_unknown",
          { sandboxId: id },
        ),
      );

    const confirmedId = result.location.id;

    // The snapshot exists whatever happens next; a failed restart names it so it is never lost.
    if (wasRunning && !(await restart(id)))
      throw fail(
        `snapshot ${confirmedId} (${snapshotName}) was taken, but the sandbox could not be restarted`,
        "provider",
        { sandboxId: id },
      );

    return { id: confirmedId };
  }

  async function deleteSnapshot(snapshotId: string) {
    const remove = async (path: string, params: Record<string, string>) => {
      try {
        await http.request({ method: "DELETE", path, params });

        return true;
      } catch (error) {
        if (isGone(error)) return false;
        throw error;
      }
    };

    if (uuidPattern.test(snapshotId) && (await remove("/snapshots/{id}", { id: snapshotId })))
      return true;

    return remove("/snapshots/by-name/{name}", { name: snapshotId });
  }

  // ---------------------------------------------------------------- native

  const binding: NativeSdkBinding = {
    package: sdkPackage,
    async connect(module, sandboxId) {
      const peer = sdkConstruct(module, "RemoteContext", [peerSettings()], sdkPackage);

      if (sandboxId === undefined) return peer;

      const sandboxes = sdkObject(peer.sandboxes, "RemoteContext.sandboxes", sdkPackage);

      const sandbox = sdkObject(
        await sdkCall(sandboxes, "get", [await nameOf(sandboxId)], sdkPackage),
        "the sandbox",
        sdkPackage,
      );

      return { context: peer, sandbox };
    },
  };

  /** `provider.api` and `box.native` register any token in the JSON they read, so a later error never echoes one. */
  const nativeHttp: HttpClient<MicrosandboxPlane> = {
    ...http,
    async json(request) {
      const value: JsonValue | undefined = await http.json(request);

      for (const token of nestedTokens(value)) tokens.add(token);

      return value;
    },
  };

  const api = createNativeApi<MicrosandboxPlane, MicrosandboxClientSdk>({
    http: nativeHttp,
    placeholder: "id",
    sdk: binding,
  });

  const natives = new Map<string, MicrosandboxNative>();

  const provider: MicrosandboxProvider = {
    name,
    keyMode: "best-effort",
    capabilities: new Set<MicrosandboxCapability>([
      "size",
      "snapshot",
      "snapshot-delete",
      "network-policy",
    ]),
    api,
    computeType,

    setAttemptHooks(next) {
      hooks = next ?? {};
    },

    create: createSandbox,

    async find(key) {
      // A failed sandbox never runs again: a key that names only those makes a new sandbox.
      const first = (await listSandboxes({ [keyLabel]: key })).find((s) => s.status !== "failed");

      return first ? toInfo(first) : undefined;
    },

    async connect(id) {
      try {
        return toInfo(await readSandbox(id));
      } catch (error) {
        if (isGone(error)) {
          forget(id);
          throw fail("the sandbox does not exist", "not_found", { sandboxId: id });
        }

        throw error;
      }
    },

    async list(labels) {
      return (await listSandboxes(labels)).map(toInfo);
    },

    destroy: (id) => destroy(id),

    async close(id) {
      handles.delete(id);
    },

    exec,
    files,
    previewUrl,
    snapshot,
    deleteSnapshot,

    native(id) {
      let value = natives.get(id);

      if (!value) {
        value = createNativeApi<MicrosandboxPlane, MicrosandboxSandboxSdk>({
          http: nativeHttp,
          placeholder: "id",
          sandboxId: id,
          sdk: binding,
        });
        natives.set(id, value);
      }

      return value;
    },
  };

  return provider;
}
