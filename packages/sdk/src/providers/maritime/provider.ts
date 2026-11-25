/**
 * Maritime (https://maritime.sh) virtual machines through the Virtual machines API, with `fetch` and no
 * other package. Sources, retrieved 2026-11-23: https://maritime.sh/docs/ephemeral-sandboxes,
 * https://maritime.sh/docs/api, https://maritime.sh/docs/limits, https://maritime.sh/docs/billing and the
 * wire protocol of maritime-sdk 0.13.0. Every behaviour the adapter leans on was checked against the live
 * API the same day; the provider page lists what was found.
 *
 * Two planes: the control plane (`https://api.maritime.sh/v1`, `Authorization: Bearer <key>`) creates,
 * reads, pauses, snapshots and ends sandboxes; each sandbox's data plane (`dataPlaneUrl`,
 * `X-Maritime-Token: <secret>`) runs its commands and moves its files.
 */
import { randomUUID } from "node:crypto";
import { SandboxError } from "../../errors.js";
import {
  createDeadline,
  createHttpClient,
  httpStatus,
  neverSent,
  type Fetch,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "../../http.js";
import {
  createNativeApi,
  sdkCall,
  sdkConstruct,
  sdkObject,
  type NativeApi,
  type NativeSdkBinding,
} from "../../native.js";
import type {
  CreateInput,
  ExecInput,
  ExecResult,
  Labels,
  Provider,
  ProviderFiles,
} from "../../provider.js";
import { files as guestFiles, type Guest } from "../../shared/guest.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../../shared/json.js";
import { isString } from "../../shared/narrow.js";
import { sse, type ServerSentEvent } from "../../streams.js";
import {
  allocLabel,
  connectionOf,
  leakPatterns,
  credentials,
  exitedCleanly,
  keyLabel,
  liveStates,
  nestedCredentials,
  parseCommand,
  parseSandbox,
  parseSandboxAnswer,
  parseSandboxPage,
  parseSnapshot,
  parseUrl,
  parseUsage,
  toInfo,
  tokensIn,
  type Connection,
  type MaritimeSandbox,
  type SandboxAnswer,
} from "./api.js";
import { codeOf, fail, mapError, provider as name, refusals, shownCode } from "./errors.js";
import { commandSeconds, execDir, killCommand, wrappedCommand } from "./exec.js";

/**
 * Maritime's API surfaces: `control` (`/v1` on the API host), `data` (the sandbox's own `dataPlaneUrl`,
 * only on `box.native`) and `api` (the API host's root, for `/api/...` routes such as account limits).
 */
export type MaritimePlane = "control" | "data" | "api";

export type MaritimeCapability =
  | "pause"
  | "snapshot"
  | "snapshot-delete"
  | "network-policy"
  | "size";

export interface MaritimeOptions {
  /** Defaults to MARITIME_API_KEY. */
  apiKey?: string;
  /** The API host. Default: MARITIME_API_URL, else https://api.maritime.sh. */
  baseUrl?: string;
  /**
   * What new sandboxes start from (Maritime's `from`): a stock template (`base`, `python`,
   * `code-interpreter`), a saved snapshot or a public OCI image. Default: `base` (Ubuntu 24.04 with
   * Node.js 22, Python 3.12 and git).
   */
  template?: string;
  /**
   * Time limit of a sandbox created without `timeoutMs` (Maritime's `timeLimitSeconds`), counted from the
   * create or the last resume. 1 second to 24 hours. Default: 1 hour.
   */
  timeoutMs?: number;
  /**
   * Make previewed ports public (`token: false`): anyone with the URL reaches them. Default: false, and
   * `preview()` returns a URL carrying the sandbox's `?token=` URL token.
   */
  public?: boolean;
  /** Deadline for each control-plane request, retries included. Default: 60 seconds. */
  requestTimeoutMs?: number;
  /** For tests. */
  fetch?: Fetch;
}

/** The npm package `native.sdk()` binds, installed by the caller. */
const sdkPackage = "maritime-sdk";

/**
 * What `native.sdk()` needs from `maritime-sdk`: its `Maritime` client, whose `sandboxes.get` reads a
 * sandbox without resuming it.
 */
export interface MaritimeSdkModule {
  Maritime: new (options: { apiKey?: string; baseUrl?: string }) => {
    readonly sandboxes: { get(id: string): Promise<object> };
  };
}

/** `box.native.sdk(() => import("maritime-sdk"))`: a `Maritime` client with this adapter's key, and the sandbox from `client.sandboxes.get`. */
export type MaritimeSandboxSdk = <M extends MaritimeSdkModule>(
  load: () => Promise<M>,
) => Promise<{
  client: InstanceType<M["Maritime"]>;
  sandbox: Awaited<ReturnType<InstanceType<M["Maritime"]>["sandboxes"]["get"]>>;
}>;

/** `provider.api.sdk(() => import("maritime-sdk"))`: the `Maritime` client. */
export type MaritimeClientSdk = <M extends MaritimeSdkModule>(
  load: () => Promise<M>,
) => Promise<InstanceType<M["Maritime"]>>;

/** `box.native`: Maritime's API with this adapter's credentials, `{id}` bound to the sandbox. */
export type MaritimeNative = NativeApi<MaritimePlane, MaritimeSandboxSdk>;

export type MaritimeProvider = Provider<MaritimeNative, MaritimeCapability> & {
  /** Account-level calls, such as `api.request("GET", "/snapshots")`. */
  readonly api: NativeApi<MaritimePlane, MaritimeClientSdk>;
};

/** Maritime's presets (https://maritime.sh/docs/limits): vCPU, MiB of memory, GiB of disk. */
const presets = {
  small: { cpu: 2, memoryMb: 4096, diskGb: 12 },
  medium: { cpu: 4, memoryMb: 8192, diskGb: 50 },
  large: { cpu: 8, memoryMb: 16384, diskGb: 125 },
  xlarge: { cpu: 16, memoryMb: 32768, diskGb: 250 },
} as const;

type PresetName = keyof typeof presets;

const presetNames: readonly PresetName[] = ["small", "medium", "large", "xlarge"];

/** Size fields of a create body: a preset, or exact resources. */
function sizeFields(size: NonNullable<CreateInput["size"]>): JsonObject {
  if (isString(size)) return { size };

  // An exact size that is a preset, with no disk asked for, gets the preset's disk (medium: 50 GiB), not
  // the 12 GiB a bare vcpu and memory would get.
  const preset = presetNames.find(
    (n) =>
      presets[n].cpu === size.cpu &&
      presets[n].memoryMb === size.memoryMb &&
      (size.diskGb === undefined || size.diskGb === presets[n].diskGb),
  );

  if (preset !== undefined) return { size: preset };

  if (!Number.isInteger(size.cpu) || size.cpu < 1 || size.cpu > 16)
    throw fail(`cpu must be a whole number from 1 to 16, not ${size.cpu}`, "unsupported");

  if (
    !Number.isInteger(size.memoryMb) ||
    size.memoryMb < 1024 ||
    size.memoryMb > 65536 ||
    size.memoryMb % 1024 !== 0
  )
    throw fail(
      `memoryMb must be whole GiB from 1024 to 65536, not ${size.memoryMb}`,
      "unsupported",
    );
  const fields: JsonObject = { vcpu: size.cpu, memoryMib: size.memoryMb };

  if (size.diskGb !== undefined) {
    if (!Number.isInteger(size.diskGb) || size.diskGb < 5 || size.diskGb > 500)
      throw fail(`diskGb must be a whole number from 5 to 500, not ${size.diskGb}`, "unsupported");
    fields.diskGib = size.diskGb;
  }

  return fields;
}

/** Whole seconds in `min..max`, rounded up; outside that, `unsupported` naming the option. */
function seconds(ms: number, option: string, min: number, max: number) {
  const value = Math.ceil(ms / 1000);

  if (!Number.isFinite(value) || value < min || value > max)
    throw fail(`${option} must be between ${min} and ${max} seconds`, "unsupported");

  return value;
}

/**
 * Run once at create, also on a sandbox restored from a snapshot. Commands run as `user` (uid 1000) with
 * passwordless sudo, and the base image has no /workspace, the SDK's working directory.
 */
const setupCommand = [
  "set -e",
  `[ -w /workspace ] || { mkdir -p /workspace 2>/dev/null || sudo -n mkdir -p /workspace; [ -w /workspace ] || sudo -n chown "$(id -u):$(id -g)" /workspace; }`,
  `mkdir -p ${execDir}`,
  "command -v python3 tar nohup >/dev/null",
].join("; ");

const maxLifetimeSeconds = 86_400;
const defaultLifetimeMs = 3_600_000;

/** How long cleanup after a failed or aborted create may take, on its own deadline. */
const cleanupMs = 30_000;

/**
 * A create refused for capacity, which Maritime answers before anything runs, is tried again with a new
 * key for up to this long. On 2026-11-23 about one create in three was refused this way, and runs of six
 * refusals over a minute happened; Maritime's own hint is 30 seconds.
 */
const capacityBudgetMs = 180_000;

const capacityBackoffMs = (attempt: number) => Math.min(20_000, 2000 * 2 ** attempt);

type Body = JsonObject;

/** A 2xx body as JSON, or `undefined` when it is empty or not JSON: each caller treats that as unreadable. */
function readJson(response: HttpResponse): JsonValue | undefined {
  try {
    return response.json();
  } catch {
    return undefined;
  }
}

const isUnknown = (cause: unknown): cause is SandboxError =>
  cause instanceof SandboxError && cause.code === "outcome_unknown";

const isGone = (cause: unknown) => cause instanceof SandboxError && cause.code === "not_found";

/** A data-plane refusal made before anything ran: the sandbox is still starting or waking. */
const isWaking = (cause: unknown) => {
  const status = httpStatus(cause);

  return (
    status?.status === 409 &&
    (status.code === "sandbox_paused" || status.code === "sandbox_starting")
  );
};

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

export function createMaritimeProvider(options: MaritimeOptions = {}): MaritimeProvider {
  const root = (
    options.baseUrl ??
    process.env.MARITIME_API_URL ??
    "https://api.maritime.sh"
  ).replace(/\/+$/, "");

  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const connections = new Map<string, Connection>();
  const natives = new Map<string, MaritimeNative>();
  /** Public preview URLs, which carry no credential. A private one is asked for each time: its token rotates. */
  const previews = new Map<string, string>();
  /** Every secret and URL token an answer carried. Kept for the client's life: an error may echo one after a close. */
  const tokens = new Set<string>();

  /** Registers the credentials in a sandbox answer for redaction, and hands the answer on. */
  const remember = (raw: JsonValue | undefined) => {
    for (const token of credentials(raw)) tokens.add(token);

    return raw;
  };

  function apiKey() {
    const key = (options.apiKey ?? process.env.MARITIME_API_KEY)?.trim();

    if (!key)
      throw fail(
        "the API key is missing. Authentication is required. Set MARITIME_API_KEY or pass apiKey",
        "auth",
      );

    return key;
  }

  const bearer = () => ({ Authorization: `Bearer ${apiKey()}` });

  function sandboxOf(sandboxId: string | undefined) {
    if (sandboxId === undefined)
      throw fail(
        "the data plane belongs to one sandbox; call it through box.native",
        "invalid_argument",
      );

    return sandboxId;
  }

  const http = createHttpClient<MaritimePlane>({
    provider: name,
    label: "Maritime",
    planes: {
      // Maritime never redirects a write, so none is followed: it is never sent twice.
      control: { baseUrl: `${root}/v1`, auth: bearer, redirectWrites: false },
      api: { baseUrl: root, auth: bearer, redirectWrites: false },
      data: {
        redirectWrites: false,
        baseUrl: async ({ sandboxId }) => (await connection(sandboxOf(sandboxId))).dataPlaneUrl,
        auth: async ({ sandboxId }) => ({
          "X-Maritime-Token": (await connection(sandboxOf(sandboxId))).secret,
        }),
        // A 401 carrying Maritime's `unauthenticated` code means the secret rotated: read the current one
        // and send again. Nothing ran, so this is the one case a command is sent twice. Any other 401 (no
        // body, an unreadable one, another code) proves nothing ran, so it is never sent again.
        unauthorized: (body) => body.code === "unauthenticated",
        refresh: async ({ sandboxId }) => {
          const id = sandboxOf(sandboxId);
          connections.delete(id);
          await connection(id);
        },
      },
    },
    defaultPlane: "control",
    fetch: options.fetch,
    timeoutMs: requestTimeoutMs,
    secrets: () => [options.apiKey ?? process.env.MARITIME_API_KEY, ...tokens],
    // Tokens the adapter never saw, such as another sandbox's, echoed in an error code or request ID.
    credentialPatterns: leakPatterns,
    idempotencyHeader: "Idempotency-Key",
    authHint: "Set MARITIME_API_KEY to a valid Maritime API key with the sandboxes scope.",
    mapError,
  });

  const binding: NativeSdkBinding = {
    package: sdkPackage,
    async connect(module, sandboxId) {
      const client = sdkConstruct(
        module,
        "Maritime",
        [{ apiKey: apiKey(), baseUrl: root }],
        sdkPackage,
      );

      if (sandboxId === undefined) return client;

      const sandboxes = sdkObject(client.sandboxes, "Maritime.sandboxes", sdkPackage);

      // get, not connect with a fetch: neither resumes a paused sandbox.
      const sandbox = sdkObject(
        await sdkCall(sandboxes, "get", [sandboxId], sdkPackage),
        "the sandbox",
        sdkPackage,
      );

      return { client, sandbox };
    },
  };

  /**
   * `provider.api` and `box.native` register the credentials in every JSON answer they read, as the
   * adapter's own calls do, so a later error never echoes one. `fetch` hands the caller the raw body unread.
   */
  const nativeHttp: HttpClient<MaritimePlane> = {
    ...http,
    async json(request) {
      const value = await http.json(request);

      for (const token of nestedCredentials(value)) tokens.add(token);

      return value;
    },
  };

  const api = createNativeApi<MaritimePlane, MaritimeClientSdk>({
    http: nativeHttp,
    placeholder: "id",
    sdk: binding,
  });

  const sandboxPath = (id: string, route = "") => ({
    plane: "control" as const,
    path: `/sandboxes/{id}${route}`,
    params: { id },
    sandboxId: id,
  });

  const dataPath = (id: string, path: string) => ({ plane: "data" as const, path, sandboxId: id });

  /** A write that may need a retry carries a key, so Maritime applies it once. */
  const idempotent = () => ({ idempotencyKey: randomUUID() });

  /** Reads one sandbox and keeps its connection. Never resumes it. */
  async function readSandbox(id: string, request: Partial<HttpRequest<MaritimePlane>> = {}) {
    const raw = remember(await http.json({ method: "GET", ...sandboxPath(id), ...request }));
    const sandbox = parseSandbox(raw);
    const found = connectionOf(raw);

    if (found && sandbox.state !== "ended") connections.set(id, found);

    return { sandbox, raw };
  }

  /** The data-plane URL and secret: from the create, a read or a list. An ended sandbox has none. */
  async function connection(id: string): Promise<Connection> {
    const known = connections.get(id);

    if (known) return known;
    const { sandbox, raw } = await readSandbox(id);

    if (sandbox.state === "ended")
      throw fail("the sandbox has ended", "not_found", { sandboxId: id });
    const found = connectionOf(raw);

    if (!found)
      throw fail(
        "the sandbox answer has no data-plane secret; use an API key with the sandboxes scope",
        "auth",
        { sandboxId: id },
      );
    connections.set(id, found);

    return found;
  }

  /**
   * A data-plane call. A `409` saying the sandbox is still starting or waking from a pause is a refusal
   * made before anything ran, so it is sent again a few times; any other answer stands.
   */
  async function data(request: HttpRequest<MaritimePlane>): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++)
      try {
        return await http.request(request);
      } catch (error) {
        if (attempt >= 5 || !isWaking(error)) throw error;
        await delay(200 * 2 ** attempt);
      }
  }

  /**
   * Live sandboxes whose metadata has every label, across all pages. With `until` (epoch ms), no page
   * starts after it and each gets only the time left: `undefined` is returned once it passes.
   */
  async function listSandboxes(labels: Labels): Promise<MaritimeSandbox[]>;
  async function listSandboxes(
    labels: Labels,
    until: number,
  ): Promise<MaritimeSandbox[] | undefined>;
  async function listSandboxes(
    labels: Labels,
    until?: number,
  ): Promise<MaritimeSandbox[] | undefined> {
    const found: MaritimeSandbox[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 1000; page++) {
      const left = until === undefined ? undefined : until - Date.now();

      if (left !== undefined && left <= 0) return undefined;
      const query = new URLSearchParams();

      for (const state of liveStates) query.append("state", state);

      for (const [key, value] of Object.entries(labels)) query.append(`metadata[${key}]`, value);

      query.set("limit", "100");

      if (cursor !== undefined) query.set("cursor", cursor);

      const pageRequest: HttpRequest<MaritimePlane> = {
        method: "GET",
        path: `/sandboxes?${query.toString()}`,
      };

      if (left !== undefined) pageRequest.timeoutMs = left;
      const answer = parseSandboxPage(await http.json(pageRequest));

      for (const { sandbox, raw } of answer.data) {
        remember(raw);
        const live = sandbox.state === "ended" ? undefined : connectionOf(raw);

        if (live) connections.set(sandbox.id, live);
      }

      found.push(...answer.data.map((entry) => entry.sandbox));
      cursor = answer.nextCursor;

      if (cursor === undefined) break;
    }

    // Match exactly and drop ended sandboxes, in case the server's filters are looser than asked.
    return found.filter(
      (s) => s.state !== "ended" && Object.entries(labels).every(([k, v]) => s.metadata[k] === v),
    );
  }

  function forget(id: string) {
    connections.delete(id);
    natives.delete(id);

    for (const key of previews.keys()) if (key.startsWith(`${id}:`)) previews.delete(key);
  }

  /**
   * Ends a sandbox. Maritime answers a repeated end with the ended sandbox, and a 404 is gone too. An end
   * answered with a 5xx (a live `500 internal_error` on 2026-11-23) is sent again, since ending is
   * idempotent; when every try fails, a read decides: only `ended` counts as gone. With `budgetMs`,
   * every try, the waits between them and that read share one deadline.
   */
  async function destroy(id: string, budgetMs?: number) {
    const deadline = budgetMs === undefined ? undefined : createDeadline(budgetMs);
    const request: Partial<HttpRequest<MaritimePlane>> = deadline ? { deadline } : {};

    try {
      let last: unknown;

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await http.request({ method: "DELETE", ...sandboxPath(id), ...request });

          return;
        } catch (error) {
          if (isGone(error)) return;

          if ((httpStatus(error)?.status ?? 500) < 500) throw error;
          last = error;
        }

        const wait = 500 * 2 ** attempt;

        // No time left for another try and the read: the read decides now.
        if (deadline && deadline.remaining() <= wait) break;
        await delay(wait);
      }

      const { sandbox } = await readSandbox(id, request).catch(() => {
        throw last;
      });

      if (sandbox.id !== id || sandbox.state !== "ended") throw last;
    } finally {
      forget(id);
    }
  }

  /**
   * Whether a read proves the sandbox ended, on a fresh bounded deadline: it reads `ended` for the
   * same sandbox ID, or Maritime answers `404 sandbox_not_found` or `410 sandbox_ended`. A live
   * sandbox, a different sandbox ID, or no answer is not proof.
   */
  async function confirmedEnded(id: string): Promise<boolean> {
    try {
      const { sandbox } = await readSandbox(id, { timeoutMs: cleanupMs });

      return sandbox.id === id && sandbox.state === "ended";
    } catch (error) {
      const status = httpStatus(error);

      return (
        (status?.status === 404 && status.code === "sandbox_not_found") ||
        (status?.status === 410 && status.code === "sandbox_ended")
      );
    }
  }

  /**
   * Kills a command's process group in the guest, on a fresh bounded deadline. Throws `outcome_unknown`
   * when unconfirmed: the kill command's own record must show it ran to a normal exit 0, or a read must
   * show the sandbox ended. A 404 from the commands route alone proves nothing: the route may be gone
   * while the sandbox, and the command, live on.
   */
  async function killGroup(id: string, tag: string) {
    const body = { cmd: killCommand(tag), cwd: "/", timeoutSeconds: 30 };
    let last: unknown;

    for (let attempt = 0; attempt < 2; attempt++)
      try {
        // Never the caller's signal, which has already fired: a fresh deadline of its own.
        const record = await data({
          method: "POST",
          ...dataPath(id, "/commands"),
          body,
          headers: { accept: "application/json" },
          timeoutMs: cleanupMs,
        });

        if (exitedCleanly(readJson(record))) return;
        last = fail("the kill command did not exit cleanly", "outcome_unknown", { sandboxId: id });
      } catch (error) {
        last = error;

        // A sandbox that ended took the command with it, once a read confirms it ended.
        if (isGone(error) && (await confirmedEnded(id))) return;
      }

    throw fail(
      "the command was cancelled, but its process group could not be confirmed killed. It may still be running; destroy the sandbox before retrying",
      "outcome_unknown",
      { sandboxId: id, cause: last instanceof SandboxError ? last.message : undefined },
    );
  }

  const timedOut: ExecResult = { exitCode: null, timedOut: true };

  /**
   * One command over `POST {dataPlaneUrl}/commands` as server-sent events. Closing that stream does not
   * stop the command (checked live), so a timeout or abort kills the process group in the guest before
   * this settles. Once the request may have left this process, it is never sent again.
   */
  async function exec(id: string, input: ExecInput): Promise<ExecResult> {
    if (input.signal?.aborted) return timedOut;
    // Chosen before the request: the wrapper records its group under it, so a cancel finds it.
    const tag = randomUUID();
    // Ends the stream's reads once the adapter stops listening. Never the caller's signal.
    const reading = new AbortController();
    // One waiter per read in flight, removed when that read settles: racing every read against one
    // long-lived promise would keep a reaction per event until the command ends.
    const waiters = new Set<() => void>();
    let cancelled = false;

    const cancel = () => {
      cancelled = true;

      for (const stop of waiters) stop();
      waiters.clear();
    };

    /** `promise`, or `"stop"` once the command is cancelled. */
    function orStop<T>(promise: Promise<T>): Promise<T | "stop"> {
      return new Promise((resolve, reject) => {
        const stop = () => resolve("stop");

        waiters.add(stop);
        promise.then(resolve, reject).finally(() => waiters.delete(stop));

        if (cancelled) stop();
      });
    }

    // Node fires a timer longer than 2^31 - 1 ms at once; past that the command still ends at Maritime's hour.
    const timer = setTimeout(cancel, Math.min(input.timeoutMs, 2 ** 31 - 1));
    input.signal?.addEventListener("abort", cancel, { once: true });

    const body: Body = {
      cmd: wrappedCommand({ cwd: input.cwd, command: input.command, tag }),
      cwd: "/",
      timeoutSeconds: commandSeconds(input.timeoutMs),
    };

    if (Object.keys(input.env).length) body.env = input.env;

    if (input.stdin !== undefined) body.stdin = input.stdin;

    /**
     * Opens the stream. Sent again only when it provably did not run: it never left this process, or
     * Maritime refused it because the sandbox was still waking. A 401 is resent by the HTTP client after
     * reading the rotated secret, also before anything ran.
     */
    const open = async (): Promise<Response> => {
      for (let attempt = 0; ; attempt++)
        try {
          return await http.stream({
            method: "POST",
            ...dataPath(id, "/commands"),
            body,
            headers: { accept: "text/event-stream" },
            startupTimeoutMs: requestTimeoutMs,
            signal: reading.signal,
          });
        } catch (error) {
          if (attempt >= 4 || cancelled || !(neverSent(error) || isWaking(error))) throw error;
          await delay(250 * 2 ** attempt);
        }
    };

    const opening = open();

    // Rejections are read below or dropped after a cancel.
    opening.catch(() => {});

    try {
      let opened: Response | "stop";

      try {
        opened = await orStop(opening);
      } catch (error) {
        // The command may have been sent and started: stop it by its tag before reporting.
        if (isUnknown(error)) await killGroup(id, tag);
        throw error;
      }

      if (opened === "stop") {
        reading.abort();
        await killGroup(id, tag);

        return timedOut;
      }

      if (!opened.body) {
        // A 2xx without a stream says nothing of whether the command started.
        await killGroup(id, tag).catch(() => {});
        throw fail("the command stream had no body", "outcome_unknown", { sandboxId: id });
      }

      const events = sse(opened.body, { provider: name, sandboxId: id })[Symbol.asyncIterator]();

      /** Stops the command after a failure that leaves its outcome unknown, then reports that. */
      const unknown = async (message: string, cause?: unknown): Promise<never> => {
        reading.abort();
        await killGroup(id, tag).catch(() => {});
        throw fail(message, "outcome_unknown", {
          sandboxId: id,
          cause: cause instanceof SandboxError ? cause.message : undefined,
        });
      };

      for (;;) {
        let next: IteratorResult<ServerSentEvent> | "stop";

        try {
          next = await orStop(events.next());
        } catch (error) {
          if (cancelled) next = "stop";
          else return await unknown("the command stream broke before the command finished", error);
        }

        if (next === "stop") {
          reading.abort();
          await killGroup(id, tag);

          return timedOut;
        }

        if (next.done) {
          if (cancelled) {
            await killGroup(id, tag);

            return timedOut;
          }

          return await unknown("the command stream ended without a result");
        }

        const event = next.value;
        let payload: JsonValue | undefined;

        try {
          payload = JSON.parse(event.data);
        } catch {
          return await unknown("the command stream sent an event that is not JSON");
        }

        switch (event.event) {
          case "stdout":
          case "stderr":
            if (!isString(payload))
              return await unknown("the command stream sent output that is not text");

            if (payload) input.onChunk({ stream: event.event, text: payload });
            break;

          case "result": {
            const outcome = parseCommand(payload);

            switch (outcome.kind) {
              case "exited":
                return { exitCode: outcome.exitCode, timedOut: false };
              case "killed":
                return { exitCode: 128 + outcome.signal, timedOut: false };
              case "running":
              case "unreadable":
                return await unknown("the command stream sent a result it does not document");
              default: {
                const exhaustive: never = outcome;

                return exhaustive;
              }
            }
          }

          case "error": {
            const code = isJsonObject(payload) && isString(payload.code) ? payload.code : undefined;

            // Maritime's own deadline killed the process it started; the group may outlive it.
            if (code === "command_timeout") {
              reading.abort();
              await killGroup(id, tag);

              return timedOut;
            }

            // A sandbox that ended took the command with it, once a read confirms it ended.
            if (codeOf(code) === "not_found" && (await confirmedEnded(id)))
              throw fail("the sandbox ended while the command ran", "not_found", { sandboxId: id });

            // The code is text from the network: only one of Maritime's documented codes is shown.
            const shown = shownCode(code);

            return await unknown(`the command stream failed${shown ? ` (${shown})` : ""}`);
          }

          default:
            // Comments and events the adapter does not use.
            break;
        }
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      reading.abort();
    }
  }

  /** A short command for the adapter itself: its stdout, or a failure on a non-zero exit. */
  async function shell(id: string, command: string, timeoutMs = 120_000) {
    let stdout = "";

    const result = await exec(id, {
      command,
      cwd: "/",
      env: {},
      timeoutMs,
      onChunk: (chunk) => {
        if (chunk.stream === "stdout") stdout += chunk.text;
      },
    });

    if (result.timedOut) throw fail("a guest command timed out", "timeout", { sandboxId: id });

    if (result.exitCode !== 0)
      throw fail(`a guest command failed (exit ${result.exitCode})`, "provider", { sandboxId: id });

    return stdout;
  }

  async function readFile(id: string, path: string): Promise<Uint8Array> {
    const response = await data({
      method: "GET",
      ...dataPath(id, "/files"),
      query: { path },
      headers: { accept: "application/octet-stream" },
      timeoutMs: 300_000,
      maxBytes: 2 ** 32,
    });

    return response.body;
  }

  async function writeFile(id: string, path: string, bytes: Uint8Array) {
    await data({
      method: "PUT",
      ...dataPath(id, "/files"),
      query: { path },
      // A copy owns a plain ArrayBuffer, which fetch's BodyInit requires.
      body: new Uint8Array(bytes),
      headers: { "content-type": "application/octet-stream" },
      timeoutMs: 300_000,
    });
  }

  const guest = (id: string): Guest => ({
    name,
    raw: (command) => shell(id, command),
    upload: (path, bytes) => writeFile(id, path, bytes),
    read: async (path, range) => {
      const bytes = await readFile(id, path);

      return range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
    },
  });

  const shared = guestFiles(
    async (id) => guest(id),
    async (_id, action) => action(),
  );

  const files: ProviderFiles = {
    writeCreatesParents: true,
    // The guest metadata program lists in os.listdir order.
    listOrder: "directory",
    read: readFile,
    write: async (id, path, bytes) => {
      await writeFile(id, path, bytes);
    },
    list: shared.list,
    stat: shared.stat,
    mkdir: shared.mkdir,
    remove: shared.remove,
  };

  /** Ends a sandbox this call made, on a fresh deadline, then reports `cause`; `outcome_unknown` when the end is unconfirmed. */
  async function abandon(id: string, cause: unknown): Promise<never> {
    try {
      await destroy(id, cleanupMs);
    } catch {
      throw fail(
        `sandbox ${id} was created but did not finish setting up, and it could not be confirmed ended. End it before retrying`,
        "outcome_unknown",
        { sandboxId: id },
      );
    }

    if (cause instanceof SandboxError) throw cause;
    throw fail("the sandbox did not finish setting up", "provider", { sandboxId: id });
  }

  function createBody(input: CreateInput, alloc: string): Body {
    const network = input.network ?? "all";
    const allowList = isString(network) ? undefined : network.allow;

    if (allowList !== undefined && allowList.length > 0)
      throw fail(
        "host allow lists are not enforced: Maritime's allowlist egress blocked its own allowed host in a live test (2026-11-23). Use network 'all' or 'none'",
        "unsupported",
      );

    const metadata: Labels = { ...input.labels, [allocLabel]: alloc };

    if (input.key !== undefined) metadata[keyLabel] = input.key;

    // Never `name`: Maritime returns the live sandbox that already has a name, which could be another
    // caller's. The key lives in metadata instead.
    const body: Body = {
      from: input.from ?? options.template ?? "base",
      metadata,
      timeLimitSeconds: seconds(
        input.timeoutMs ?? options.timeoutMs ?? defaultLifetimeMs,
        "timeoutMs",
        1,
        maxLifetimeSeconds,
      ),
    };

    if (input.size !== undefined) Object.assign(body, sizeFields(input.size));

    if (input.idleTimeoutMs !== undefined)
      body.idleTimeoutSeconds = seconds(
        input.idleTimeoutMs,
        "idleTimeoutMs",
        60,
        maxLifetimeSeconds,
      );

    if (input.env !== undefined && Object.keys(input.env).length) body.env = input.env;

    if (network === "none" || allowList !== undefined) body.network = { egress: "none" };

    return body;
  }

  /**
   * The create's idempotency key as a plain header, not the HTTP client's `idempotencyKey`: the client
   * would then resend a create whose first answer was lost and report the resend's refusal (such as a
   * 429) as if nothing had been made. The adapter replays it itself, and checks what comes back.
   */
  const keyed = (key: string) => ({ "Idempotency-Key": key });

  /** Whether a failed create was refused for capacity before anything ran. */
  const capacityRefusal = (cause: unknown) => {
    const code = httpStatus(cause)?.code;

    return (
      cause instanceof SandboxError &&
      cause.code === "unavailable" &&
      code !== undefined &&
      refusals.has(code) &&
      code !== "sandbox_starting"
    );
  };

  /** Whether a create's answer names the sandbox this call made: it carries this call's marker. */
  const ours = (answer: SandboxAnswer, alloc: string) =>
    answer.kind !== "unreadable" && answer.sandbox.metadata[allocLabel] === alloc;

  /**
   * After a create whose answer was lost or did not carry this call's marker: within one fresh
   * {@link cleanupMs} deadline, send the same request with the same key, which returns the sandbox the
   * first answer named (or makes the one it did not), else find the sandbox by this call's allocation
   * marker. Only an answer carrying the marker is returned. No request starts after the deadline, and
   * each gets only the time left. `unknown` is thrown when nothing settles it.
   */
  async function reconcile(body: Body, key: string, alloc: string, unknown: SandboxError) {
    const until = Date.now() + cleanupMs;
    const left = () => until - Date.now();

    try {
      const answer = parseSandboxAnswer(
        remember(
          readJson(
            await http.request({
              method: "POST",
              path: "/sandboxes",
              body,
              headers: keyed(key),
              timeoutMs: left(),
            }),
          ),
        ),
      );

      if (ours(answer, alloc)) return answer;
    } catch (error) {
      // A refusal of the replay says nothing about the first send; look it up by the marker.
      void error;
    }

    let found: MaritimeSandbox[] | undefined;

    try {
      found = await listSandboxes({ [allocLabel]: alloc }, until);
    } catch {
      throw unknown;
    }

    const [first] = found ?? [];

    if (!first || found?.length !== 1 || left() <= 0) throw unknown;

    const { raw } = await readSandbox(first.id, { timeoutMs: left() }).catch(() => {
      throw unknown;
    });

    return parseSandboxAnswer(raw);
  }

  /** Waits for a sandbox this call made to run; `starting` is brief. */
  async function untilRunning(id: string, signal: AbortSignal | undefined) {
    const end = Date.now() + 120_000;

    for (;;) {
      if (signal?.aborted) throw fail("creation aborted", "aborted", { sandboxId: id });
      const { sandbox } = await readSandbox(id);

      if (sandbox.state === "running") return;

      if (!["starting", "resuming"].includes(sandbox.state))
        throw fail(`the sandbox is ${sandbox.state}, not running`, "provider", { sandboxId: id });

      if (Date.now() >= end)
        throw fail("the sandbox did not start in two minutes", "timeout", { sandboxId: id });
      await delay(500, signal);
    }
  }

  const provider: MaritimeProvider = {
    name,
    keyMode: "best-effort",
    capabilities: new Set<MaritimeCapability>([
      "pause",
      "snapshot",
      "snapshot-delete",
      "network-policy",
      "size",
    ]),
    api,

    async create(input) {
      // Names this call's sandbox in its metadata, so a lost or replayed answer is trusted only when it is ours.
      const alloc = randomUUID();
      const body = createBody(input, alloc);
      let key = randomUUID();
      let answer: SandboxAnswer;
      const capacityEnd = Date.now() + capacityBudgetMs;

      for (let attempt = 0; ; attempt++) {
        try {
          // Not the caller's signal: once sent, the answer names the sandbox to end. An abort is honoured after it arrives.
          answer = parseSandboxAnswer(
            remember(
              readJson(
                await http.request({
                  method: "POST",
                  path: "/sandboxes",
                  body,
                  headers: keyed(key),
                }),
              ),
            ),
          );
        } catch (error) {
          // No host had room. Maritime ended the sandbox it named (`create_failed`) and holds the key to
          // that answer, so a later try needs a new key.
          const wait = capacityBackoffMs(attempt);

          if (capacityRefusal(error) && Date.now() + wait < capacityEnd && !input.signal?.aborted) {
            await delay(wait, input.signal);

            // Nothing was made, and an abort during the wait means no further create is sent.
            if (input.signal?.aborted) throw fail("creation aborted", "aborted");
            key = randomUUID();
            continue;
          }

          if (!isUnknown(error)) throw error;
          answer = await reconcile(body, key, alloc, error);
          break;
        }

        if (answer.kind === "unreadable")
          answer = await reconcile(
            body,
            key,
            alloc,
            fail(
              "the create was answered but its answer could not be read, so a sandbox may exist",
              "outcome_unknown",
            ),
          );
        // An answer naming a sandbox without readable metadata may still be this call's: the replay
        // with the same key returns its full record. One carrying another call's marker is left alone.
        else if (answer.sandbox.metadata[allocLabel] === undefined)
          answer = await reconcile(
            body,
            key,
            alloc,
            fail(
              `the create answered with sandbox ${answer.sandbox.id} but no readable metadata, so whose it is is unknown; it was left alone`,
              "outcome_unknown",
              { sandboxId: answer.sandbox.id },
            ),
          );
        break;
      }

      if (answer.kind === "unreadable")
        throw fail(
          "the create's answer could not be read, so a sandbox may exist",
          "outcome_unknown",
        );

      const id = answer.sandbox.id;

      // Never return or end a sandbox another call made.
      if (answer.sandbox.metadata[allocLabel] !== alloc)
        throw fail(
          `the create answered with sandbox ${id}, which this call did not make; it was left alone`,
          "outcome_unknown",
          { sandboxId: id },
        );

      if (answer.kind === "sandbox") connections.set(id, answer.connection);
      const aborted = () => fail("creation aborted", "aborted", { sandboxId: id });

      try {
        if (input.signal?.aborted) throw aborted();

        if (answer.kind === "incomplete" || answer.sandbox.state !== "running")
          await untilRunning(id, input.signal);
        await connection(id);
        await shell(id, setupCommand, 60_000);

        if (input.signal?.aborted) throw aborted();
      } catch (error) {
        return abandon(id, error);
      }

      return {
        id,
        key: input.key,
        labels: { ...input.labels },
        state: "running",
        createdAt: answer.sandbox.createdAt || Date.now(),
      };
    },

    async find(key) {
      // An errored sandbox never runs again: a key that names only those makes a new sandbox.
      const first = (await listSandboxes({ [keyLabel]: key })).find((s) => s.state !== "error");

      return first ? toInfo(first) : undefined;
    },

    async connect(id) {
      // A read only: it never resumes a paused sandbox.
      const { sandbox } = await readSandbox(id);

      if (sandbox.state === "ended") {
        forget(id);
        throw fail("the sandbox has ended", "not_found", { sandboxId: id });
      }

      return toInfo(sandbox);
    },

    async list(labels) {
      return (await listSandboxes(labels)).map(toInfo);
    },

    destroy: (id) => destroy(id),

    async close(id) {
      forget(id);
    },

    exec,
    files,

    async previewUrl(id, port) {
      const cached = options.public ? previews.get(`${id}:${port}`) : undefined;

      if (cached) return { url: cached };

      // Never resumes the sandbox. With `token: true` the port stays private and the URL carries the
      // sandbox's URL token; `token: false` makes the port public.
      const url = parseUrl(
        await http.json({
          method: "POST",
          ...sandboxPath(id, "/urls"),
          body: { port, token: !options.public },
          ...idempotent(),
        }),
      );

      for (const token of tokensIn(url)) tokens.add(token);

      for (const value of new URL(url).searchParams.values()) if (value) tokens.add(value);

      // A private URL carries the sandbox's URL token, which Maritime can rotate: never served from a cache.
      if (options.public) previews.set(`${id}:${port}`, url);

      return { url };
    },

    native(id) {
      let value = natives.get(id);

      if (!value) {
        value = createNativeApi<MaritimePlane, MaritimeSandboxSdk>({
          http: nativeHttp,
          placeholder: "id",
          sandboxId: id,
          sdk: binding,
        });
        natives.set(id, value);
      }

      return value;
    },

    async usage(id) {
      // Measurements are extra: a sandbox that is not running reports nulls, which are left out.
      return parseUsage(
        await http.json({ method: "GET", ...sandboxPath(id, "/usage") }).catch(() => undefined),
      );
    },

    async pause(id) {
      try {
        await http.request({ method: "POST", ...sandboxPath(id, "/pause"), ...idempotent() });
      } catch (error) {
        // Already paused (or pausing) is the outcome asked for.
        if (httpStatus(error)?.code !== "invalid_state") throw error;
        const { sandbox } = await readSandbox(id);

        if (sandbox.state !== "paused" && sandbox.state !== "pausing") throw error;
      }
    },

    async resume(id) {
      // Maritime has no resume route: any data-plane call wakes a paused sandbox, in under a second. A
      // command that ran to exit 0 proves it awake; the control plane went on reading `paused` for 6+
      // seconds after such a wake (2026-11-23), so its state is not waited for.
      const record = await data({
        method: "POST",
        ...dataPath(id, "/commands"),
        body: { cmd: ["true"], cwd: "/", timeoutSeconds: 30 },
        headers: { accept: "application/json" },
        ...idempotent(),
      });

      if (!exitedCleanly(readJson(record)))
        throw fail("the wake command did not exit cleanly", "provider", { sandboxId: id });
    },

    async snapshot(id, snapshotOptions) {
      if (snapshotOptions?.expiresInMs)
        throw fail("snapshots are kept until deleted; omit expiresInMs", "unsupported", {
          sandboxId: id,
        });
      const snapshotName = `sandbox-sdk-${randomUUID()}`;

      // The name was chosen before the request, so a lost or unreadable answer can be looked up, and
      // only a snapshot of this sandbox counts. When there is none, `cause` is the result.
      const lookUp = async (cause: unknown) => {
        const found = await http
          .cleanup({ method: "GET", path: "/snapshots/{name}", params: { name: snapshotName } })
          .then((response) => parseSnapshot(response.json()))
          .catch(() => {
            throw cause;
          });

        if (found.name !== snapshotName || found.sourceSandboxId !== id) throw cause;

        return { id: found.name };
      };

      let response: HttpResponse;

      try {
        response = await http.request({
          method: "POST",
          ...sandboxPath(id, "/save"),
          body: { name: snapshotName },
          ...idempotent(),
          timeoutMs: 600_000,
        });
      } catch (error) {
        // Any failure is looked up, not only an unknown one: the client resends the save with its
        // idempotency key, so a refusal of a later try (a 429 after a lost answer) can follow a try that
        // made the snapshot.
        return lookUp(error);
      }

      let answered: ReturnType<typeof parseSnapshot> | undefined;

      try {
        answered = parseSnapshot(readJson(response));
      } catch {
        answered = undefined;
      }

      // Only an answer naming this snapshot of this sandbox is taken as is.
      if (answered?.name === snapshotName && answered.sourceSandboxId === id)
        return { id: snapshotName };

      // An answer naming another snapshot, another source or none says nothing about ours: look ours up,
      // and never hand that one over.
      return lookUp(
        fail(
          `the snapshot was answered but its answer did not name it as a snapshot of this sandbox; it may exist as ${snapshotName}`,
          "outcome_unknown",
          { sandboxId: id },
        ),
      );
    },

    async deleteSnapshot(snapshotId) {
      try {
        await http.request({
          method: "DELETE",
          path: "/snapshots/{name}",
          params: { name: snapshotId },
        });

        return true;
      } catch (error) {
        if (isGone(error)) return false;
        throw error;
      }
    },
  };

  return provider;
}
