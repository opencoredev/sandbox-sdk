/**
 * Buddy (https://buddy.works) Sandboxes through its REST API, with `fetch` and no other package. Sources,
 * retrieved 2026-11-24: https://buddy.works/openapi.json, https://buddy.works/docs/sandboxes/configuration.md,
 * https://buddy.works/docs/sandboxes/lifecycle.md and the wire protocol of @buddy-works/sandbox-sdk 0.3.0.
 * Every behaviour the adapter leans on was checked against the live API the same day; the provider page
 * lists what was found.
 *
 * One API host per region (`https://api.buddy.works`, `https://api.eu.buddy.works`,
 * `https://api.asia.buddy.works`), `Authorization: Bearer <personal access token>`, every sandbox route
 * under `/workspaces/{workspace}/sandboxes`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { SandboxError } from "../../errors.js";
import {
  createDeadline,
  createHttpClient,
  httpStatus,
  neverSent,
  sleep,
  type Deadline,
  type Fetch,
  type HttpRequest,
  type HttpResponse,
} from "../../http.js";
import { createNativeApi, type NativeApi } from "../../native.js";
import type {
  CreateInput,
  ExecInput,
  ExecResult,
  Labels,
  Preview,
  Provider,
  ProviderFiles,
  SandboxInfo,
} from "../../provider.js";
import { files as guestFiles, type Guest } from "../../shared/guest.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../../shared/json.js";
import { isString } from "../../shared/narrow.js";
import { quote } from "../../shared/shell.js";
import { bootRepairScript } from "../../shell/process-records.js";
import {
  authOf,
  isSdkIdentifier,
  keyedIdentifier,
  noteText,
  parseExec,
  parseExecs,
  parseLog,
  parseSandbox,
  parseSnapshot,
  parseSnapshots,
  parseSummaries,
  parseSyncResult,
  preservedEndpoint,
  sdkTag,
  toInfo,
  unkeyedIdentifier,
  urlOf,
  type BuddyExec,
  type BuddySandbox,
  type BuddySnapshot,
  type SyncResult,
} from "./api.js";
import { causeOf, fail, isFault, leakPatterns, mapError, provider as name } from "./errors.js";
import {
  FrameError,
  FrameReader,
  LineSplitter,
  commandDir,
  envDir,
  envRoot,
  execRoot,
  inlineCommandBytes,
  installBridge,
  killCommand,
  launcher,
  maxAsyncCommandBytes,
  notStarted,
  parseKillState,
  parseSpool,
  removeCommand,
  spoolCommand,
  stageCommands,
  type KillState,
  type StagedFile,
} from "./exec.js";

/**
 * Buddy's API surfaces: `workspace` (`/workspaces/{workspace}` on the API host, where every sandbox route
 * lives) and `api` (the API host's root, for routes such as `/workspaces`).
 */
export type BuddyPlane = "workspace" | "api";

export type BuddyCapability = "pause" | "snapshot" | "snapshot-delete" | "size";

export type BuddyRegion = "US" | "EU" | "AS";

export interface BuddyOptions {
  /** A personal access token with the `Sandboxes: Manage` scope. Defaults to BUDDY_TOKEN. */
  token?: string;
  /** The workspace domain (the `my-company` of `app.buddy.works/my-company`). Defaults to BUDDY_WORKSPACE. */
  workspace?: string;
  /**
   * A project to create and look up sandboxes in (Buddy's `project_name`). Defaults to BUDDY_PROJECT;
   * without one, sandboxes are workspace-scoped. A key names one sandbox per project.
   */
  project?: string;
  /** The API region: `US` (default), `EU` or `AS`. Defaults to BUDDY_REGION. */
  region?: BuddyRegion;
  /** The API host, which wins over `region`. Defaults to BUDDY_API_URL. */
  baseUrl?: string;
  /** The operating system of new sandboxes. Default: `ubuntu:24.04`. */
  os?: "ubuntu:24.04" | "ubuntu:22.04";
  /**
   * Make previewed ports public (`auth_type: NONE`): anyone with the URL reaches them. Default: false, and
   * `preview()` returns a URL with an `Authorization: Basic` header to send.
   */
  public?: boolean;
  /** Deadline for each API request, retries included. Default: 60 seconds. */
  requestTimeoutMs?: number;
  /** For tests. */
  fetch?: Fetch;
}

/** `box.native`: Buddy's API with this adapter's token, `{sandbox_id}` bound to the sandbox. */
export type BuddyNative = NativeApi<BuddyPlane>;

export type BuddyProvider = Provider<BuddyNative, BuddyCapability> & {
  /** Workspace-level calls, such as `api.request("GET", "/sandboxes/snapshots")`. */
  readonly api: NativeApi<BuddyPlane>;
};

const regions: Record<BuddyRegion, string> = {
  US: "https://api.buddy.works",
  EU: "https://api.eu.buddy.works",
  AS: "https://api.asia.buddy.works",
};

const isRegion = (value: string): value is BuddyRegion => Object.hasOwn(regions, value);

/** Buddy's fixed sizes: `<vCPU>x<GB>`, 2 GB per vCPU from 1 to 12 vCPU, always a 50 GB disk. */
const presets = { small: "2x4", medium: "4x8", large: "8x16" } as const;

const diskGb = 50;

/**
 * Buddy's `resources` for a size. Buddy's RAM is decimal GB (a `2x4` guest sees 3814 MiB), so an exact
 * size matches a tier when `memoryMb` is the tier's GB in MiB (2048 per vCPU) or in decimal MB (2000).
 * Buddy has no custom size: its `CUSTOM` falls back to `2x4`, so anything else is refused.
 */
export function resourcesOf(size: NonNullable<CreateInput["size"]>): string {
  if (isString(size)) return presets[size];

  const { cpu, memoryMb } = size;

  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 12)
    throw fail(`cpu must be a whole number from 1 to 12, not ${cpu}`, "unsupported");

  if (memoryMb !== cpu * 2048 && memoryMb !== cpu * 2000)
    throw fail(
      `Buddy sizes have 2 GB of memory per vCPU: ${cpu} vCPU takes memoryMb ${cpu * 2048}, not ${memoryMb}`,
      "unsupported",
    );

  // The disk is fixed: any other size asked for could not be honoured.
  if (size.diskGb !== undefined && size.diskGb !== diskGb)
    throw fail(`every Buddy sandbox has a ${diskGb} GB disk, not ${size.diskGb}`, "unsupported");

  return `${cpu}x${cpu * 2}`;
}

/** How long cleanup after a failed or aborted create may take, on its own deadline. */
const cleanupMs = 30_000;

/** How long a sandbox may take to reach `RUNNING` with its setup done. */
const readyMs = 180_000;

/** Cap on full-file downloads so a growing guest file cannot exhaust host memory. */
const maxReadBytes = 32 * 1024 * 1024;

/**
 * Run on every sandbox before it is returned (create, find, resume): the base image has no /workspace,
 * the SDK's working directory. Commands run as `buddy` (uid 1001) with passwordless sudo. It also checks
 * the tools the bridge needs and installs the bridge.
 */
const setupCommand = [
  `[ -w /workspace ] || { mkdir -p /workspace 2>/dev/null || sudo -n mkdir -p /workspace; [ -w /workspace ] || sudo -n chown "$(id -u):$(id -g)" /workspace; }`,
  "command -v python3 setsid flock base64 >/dev/null || exit 1",
  "umask 077",
  `mkdir -p ${execRoot} || exit 1`,
  installBridge,
  "test -d /workspace && test -w /workspace",
].join("; ");

/** Readable JSON of a 2xx body, or `undefined` when it is empty or not JSON. */
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

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);

    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }

    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

/** The URL path of a guest path: absolute, each segment encoded. */
export function guestPath(path: string): string {
  if (path.includes("\0")) throw fail("paths cannot contain NUL bytes", "invalid_argument");

  return posix
    .resolve("/workspace", path)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/** What each sandbox's guest holds that this client put there: the bridge, and shared env files. */
interface GuestState {
  bridge: boolean;
  /** Whether stale pre-boot process records have been repaired on this handle. */
  bootRepaired: boolean;
  /** Env JSON to the private file that holds it. */
  envs: Map<string, string>;
  /** Commands that ended, whose directories the next launch removes. */
  finished: string[];
}

/** Preview credentials kept in the guest (`0600`), so another client reattaches without a new password. */
interface PreviewCredentials {
  port: number;
  login: string;
  password: string;
}

function parseCredentials(text: string, port: number): PreviewCredentials | undefined {
  let value: JsonValue;

  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!isJsonObject(value)) return undefined;
  const { login, password } = value;

  return value.port === port && isString(login) && login && isString(password) && password
    ? { port, login, password }
    : undefined;
}

const previewDir = "/tmp/.sandbox-sdk/previews";
const lockDir = "/tmp/.sandbox-sdk/locks/endpoints.lock";

/**
 * Takes the guest lock on the sandbox's endpoints: an atomic `mkdir`, with `owner` inside. A lock older
 * than `leaseMinutes` is a crashed client's lease and is broken. Exits 75 when the lock stays taken for
 * about 20 seconds.
 */
const lockCommand = (owner: string, leaseMinutes: number) =>
  [
    "umask 077",
    "mkdir -p /tmp/.sandbox-sdk/locks || exit 1",
    `l=${lockDir}`,
    "i=0",
    `while ! mkdir "$l" 2>/dev/null; do`,
    `  if [ -n "$(find "$l" -maxdepth 0 -mmin +${leaseMinutes} 2>/dev/null)" ]; then rm -rf "$l"; continue; fi`,
    "  i=$((i + 1)); [ $i -lt 200 ] || exit 75; sleep 0.1",
    "done",
    `printf %s ${quote(owner)} > "$l/owner"`,
  ].join("\n");

/** Writes `credentials` to their private file only while `owner` still holds the endpoint lock. Exits 75 if lost. */
const writeCredentialsCommand = (owner: string, credentials: PreviewCredentials) =>
  [
    "umask 077",
    `l=${lockDir}`,
    `[ "$(cat "$l/owner" 2>/dev/null)" = ${quote(owner)} ] || exit 75`,
    `mkdir -p ${previewDir} || exit 1`,
    `printf %s ${quote(Buffer.from(JSON.stringify(credentials)).toString("base64"))} | base64 -d > ${previewDir}/${credentials.port}.part && mv -f ${previewDir}/${credentials.port}.part ${previewDir}/${credentials.port} || exit 1`,
  ].join("\n");

/** Releases the endpoint lock if `owner` still holds it. */
const unlockCommand = (owner: string) =>
  [
    `l=${lockDir}`,
    `[ "$(cat "$l/owner" 2>/dev/null)" = ${quote(owner)} ] && rm -rf "$l"`,
    "exit 0",
  ].join("\n");

/** What a create's reconciliation found: this call's sandbox, another call's, or none. */
type Reconciled = { kind: "ours"; sandbox: BuddySandbox } | { kind: "foreign" } | { kind: "none" };

/** How one `POST /exec` is bounded: its own `timeoutMs`, a `deadline` it shares with other steps, or an abort `signal`. */
interface RunRequest {
  timeoutMs?: number;
  deadline?: Deadline;
  signal?: AbortSignal;
  readOnly?: boolean;
}

const basic = (credentials: PreviewCredentials) =>
  `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`).toString("base64")}`;

export function createBuddyProvider(options: BuddyOptions = {}): BuddyProvider {
  const regionName = (options.region ?? process.env.BUDDY_REGION)?.trim().toUpperCase();

  if (regionName && !isRegion(regionName))
    throw fail(`region must be US, EU or AS, not ${regionName}`, "invalid_argument");

  const root = (
    options.baseUrl ??
    process.env.BUDDY_API_URL ??
    regions[regionName && isRegion(regionName) ? regionName : "US"]
  ).replace(/\/+$/, "");

  const project = (options.project ?? process.env.BUDDY_PROJECT)?.trim() || undefined;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const natives = new Map<string, BuddyNative>();
  const guests = new Map<string, GuestState>();
  const previews = new Map<string, Preview>();
  const previewQueues = new Map<string, Promise<unknown>>();
  /** Values to redact scoped per live sandbox, plus in-flight creates before an ID exists. */
  const sandboxTokens = new Map<string, Set<string>>();
  const pendingCreateTokens = new Set<Set<string>>();

  function addSandboxToken(id: string, value: string) {
    let set = sandboxTokens.get(id);

    if (!set) {
      set = new Set<string>();
      sandboxTokens.set(id, set);
    }

    set.add(value);
  }

  function addSandboxTokens(id: string, values: Iterable<string>) {
    let set = sandboxTokens.get(id);

    if (!set) {
      set = new Set<string>();
      sandboxTokens.set(id, set);
    }

    for (const value of values) set.add(value);
  }

  const configuredToken = (options.token ?? process.env.BUDDY_TOKEN)?.trim();
  const configuredWorkspace = (options.workspace ?? process.env.BUDDY_WORKSPACE)?.trim();

  function token() {
    if (!configuredToken)
      throw fail(
        "the token is missing. Authentication is required. Set BUDDY_TOKEN or pass token",
        "auth",
      );

    return configuredToken;
  }

  function workspace() {
    if (!configuredWorkspace)
      throw fail(
        "the workspace is missing. Set BUDDY_WORKSPACE or pass workspace (the domain in app.buddy.works/<workspace>)",
        "invalid_argument",
      );

    return configuredWorkspace;
  }

  const bearer = () => ({ Authorization: `Bearer ${token()}` });

  const http = createHttpClient<BuddyPlane>({
    provider: name,
    label: "Buddy",
    planes: {
      // Buddy's API never redirects; refuse every redirect so no read, write or delete is sent elsewhere.
      workspace: {
        baseUrl: () => `${root}/workspaces/${encodeURIComponent(workspace())}`,
        auth: bearer,
        redirects: false,
        redirectWrites: false,
      },
      api: { baseUrl: root, auth: bearer, redirects: false, redirectWrites: false },
    },
    defaultPlane: "workspace",
    fetch: options.fetch,
    timeoutMs: requestTimeoutMs,
    secrets: () => {
      const values: (string | undefined)[] = [configuredToken];

      for (const set of pendingCreateTokens) for (const value of set) values.push(value);

      for (const set of sandboxTokens.values()) for (const value of set) values.push(value);

      return values;
    },
    credentialPatterns: leakPatterns,
    authHint:
      "Set BUDDY_TOKEN to a Buddy personal access token with the Sandboxes: Manage scope, and BUDDY_WORKSPACE to its workspace.",
    mapError,
    cause: causeOf,
  });

  const api = createNativeApi<BuddyPlane>({ http, placeholder: "sandbox_id" });

  const sandboxPath = (id: string, route = "") => ({
    path: `/sandboxes/{id}${route}`,
    params: { id },
    sandboxId: id,
  });

  const scoped = project === undefined ? {} : { query: { project_name: project } };

  function guestOf(id: string): GuestState {
    let state = guests.get(id);

    if (!state) {
      state = { bridge: false, bootRepaired: false, envs: new Map(), finished: [] };
      guests.set(id, state);
    }

    return state;
  }

  function forget(id: string) {
    guests.delete(id);
    natives.delete(id);

    for (const key of previews.keys()) if (key.startsWith(`${id}:`)) previews.delete(key);
  }

  async function readSandbox(id: string, request: Partial<HttpRequest<BuddyPlane>> = {}) {
    return parseSandbox(await http.json({ method: "GET", ...sandboxPath(id), ...request }));
  }

  /** Every sandbox in the workspace (or project), without notes. */
  async function listSummaries(request: Partial<HttpRequest<BuddyPlane>> = {}) {
    return parseSummaries(
      await http.json({ method: "GET", path: "/sandboxes", ...scoped, ...request }),
    );
  }

  /**
   * One command on `POST /exec`: Buddy runs it and answers with its output, and never records it in
   * `GET /execs`. For the adapter's own short steps only: Buddy cuts it at 60 seconds.
   */
  async function run(id: string, command: string, request: RunRequest = {}): Promise<SyncResult> {
    return parseSyncResult(
      await http.json({
        method: "POST",
        ...sandboxPath(id, "/exec"),
        body: { command, runtime: "BASH" },
        ...(request.deadline
          ? { deadline: request.deadline }
          : { timeoutMs: request.timeoutMs ?? 75_000 }),
        signal: request.signal,
        readOnly: request.readOnly === true,
      }),
    );
  }

  /** {@link run}'s stdout, or a failure on a non-zero exit. */
  async function shell(id: string, command: string, request: RunRequest = {}) {
    const result = await run(id, command, request);

    if (result.exitCode !== 0)
      throw fail(`a guest command failed (exit ${result.exitCode})`, "provider", { sandboxId: id });

    return result.stdout;
  }

  /** Waits for `RUNNING` with setup `SUCCESS`; a failed sandbox or setup ends the wait. */
  async function untilReady(
    id: string,
    deadline: Deadline,
    accept: { stopped?: boolean } = {},
  ): Promise<BuddySandbox> {
    for (;;) {
      const sandbox = await readSandbox(id, { deadline });

      if (sandbox.status === "RUNNING" && sandbox.setupStatus === "SUCCESS") return sandbox;

      if (
        sandbox.status === "FAILED" ||
        sandbox.setupStatus === "FAILED" ||
        sandbox.setupStatus === "STALE"
      )
        throw fail(
          `the sandbox is ${sandbox.status ?? "unknown"} with setup ${sandbox.setupStatus ?? "unknown"}, not running`,
          "provider",
          { sandboxId: id },
        );

      if ((sandbox.status === "STOPPED" || sandbox.status === "STOPPING") && !accept.stopped)
        throw fail("the sandbox stopped while starting", "provider", { sandboxId: id });
      await sleep(200, deadline, name);
    }
  }

  /** Runs the setup command, which makes /workspace, installs the bridge and repairs pre-boot process records. */
  async function setUp(id: string, deadline: Deadline) {
    await shell(id, setupCommand, { deadline });
    await shell(id, bootRepairScript(), { deadline });
    const state = guestOf(id);
    state.bridge = true;
    state.bootRepaired = true;
  }

  async function ensureBootRepaired(id: string, path: string) {
    const resolved = posix.resolve("/workspace", path);

    if (
      resolved !== "/tmp/.sandbox-sdk/procs" &&
      !resolved.startsWith("/tmp/.sandbox-sdk/procs/") &&
      resolved !== "/tmp/.sandbox-sdk/runs" &&
      !resolved.startsWith("/tmp/.sandbox-sdk/runs/")
    )
      return;

    const state = guestOf(id);

    if (state.bootRepaired) return;
    await shell(id, bootRepairScript(), { readOnly: true });
    state.bootRepaired = true;
  }

  /** Readiness for a sandbox another call made or a stopped one woke: running, set up, /workspace there. */
  async function ready(id: string, signal?: AbortSignal, accept: { stopped?: boolean } = {}) {
    const deadline = createDeadline(readyMs, signal);
    const sandbox = await untilReady(id, deadline, accept);
    await setUp(id, deadline);

    return sandbox;
  }

  /**
   * Deletes a sandbox. A 404 is gone. A 5xx is sent again (deleting is idempotent); when every try fails,
   * a read decides: only a 404 counts as gone. With `budgetMs`, every try and the read share one deadline.
   */
  async function destroy(id: string, budgetMs?: number) {
    const deadline = budgetMs === undefined ? undefined : createDeadline(budgetMs);
    const request: Partial<HttpRequest<BuddyPlane>> = deadline ? { deadline } : {};

    let gone = false;

    try {
      let last: unknown;

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await http.request({ method: "DELETE", ...sandboxPath(id), ...request });
          gone = true;

          return;
        } catch (error) {
          if (isGone(error)) {
            gone = true;

            return;
          }

          if (error instanceof SandboxError && !error.retryable) throw error;

          if ((httpStatus(error)?.status ?? 500) < 500) throw error;
          last = error;
        }

        const wait = 500 * 2 ** attempt;

        if (deadline && deadline.remaining() <= wait) break;
        await delay(wait);
      }

      try {
        await readSandbox(id, request);
      } catch (error) {
        if (isGone(error)) {
          gone = true;

          return;
        }
      }

      throw last;
    } finally {
      forget(id);

      // Release per-sandbox redaction entries only once the sandbox is confirmed gone; a refused
      // DELETE leaves the sandbox live, so later errors must still redact its secrets.
      if (gone) sandboxTokens.delete(id);
    }
  }

  /** Whether a read proves the sandbox is gone, on a fresh bounded deadline. */
  async function confirmedGone(id: string): Promise<boolean> {
    try {
      await readSandbox(id, { timeoutMs: cleanupMs });

      return false;
    } catch (error) {
      return isGone(error);
    }
  }

  /**
   * Kills a command's process group in the guest, on a fresh bounded deadline, through `POST /exec`.
   * Returns what the killer found only when it exits 0 (the group is gone, or the command never started
   * and now never will), or `gone` when a read shows the sandbox gone; otherwise `outcome_unknown`. With
   * `keep`, a killed command's directory stays, for its spool to be read.
   */
  async function killGroup(id: string, tag: string, keep = false): Promise<KillState> {
    let last: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));

      try {
        const result = await run(id, killCommand(tag, keep), { timeoutMs: cleanupMs });
        const state = result.exitCode === 0 ? parseKillState(result.stdout) : undefined;

        if (state) return state;
        last = fail(
          "the cancel command did not confirm the process group gone",
          "outcome_unknown",
          {
            sandboxId: id,
          },
        );
      } catch (error) {
        last = error;

        if (isGone(error) && (await confirmedGone(id))) return "gone";
      }
    }

    throw fail(
      "the command was cancelled, but its process group could not be confirmed killed. It may still be running; destroy the sandbox before retrying",
      "outcome_unknown",
      { sandboxId: id, cause: last instanceof SandboxError ? last.message : undefined },
    );
  }

  const timedOut: ExecResult = { exitCode: null, timedOut: true };

  /** What one launch of a command came to: a result, or a refusal by the bridge before anything ran. */
  type Attempt = { kind: "result"; result: ExecResult } | { kind: "not-started" };

  /**
   * Writes what the launcher must not carry into the guest through `POST /exec`, privately: per-run env,
   * stdin, a long command, and (once per client) the bridge and the handle's shared env file.
   */
  async function stage(
    id: string,
    tag: string,
    input: ExecInput,
    finished: readonly string[],
    signal: AbortSignal,
  ) {
    const state = guestOf(id);
    const dir = `${execRoot}/${tag}`;
    const files: StagedFile[] = [];
    const shared: StagedFile[] = [];
    const preludes: string[] = [];
    let staged = "";
    let envFile: string | undefined;
    let command: string | undefined = input.command;

    if (Object.keys(input.env).length) {
      const text = JSON.stringify(input.env);

      if (input.envMode === "sandbox") {
        envFile = state.envs.get(text);

        if (envFile === undefined) {
          envFile = `${envRoot}/${randomUUID()}.json`;
          shared.push({ path: envFile, bytes: Buffer.from(text) });
        }
      } else {
        files.push({ path: `${dir}/env.json`, bytes: Buffer.from(text) });
        staged += "e";
      }
    }

    if (input.stdin !== undefined && input.stdin.length > 0) {
      files.push({ path: `${dir}/stdin`, bytes: Buffer.from(input.stdin) });
      staged += "s";
    }

    // Check both raw command size AND the POSIX-quoted launcher size (apostrophes expand 4x under quoting)
    // so the encoded launcher never exceeds Buddy's 16 KiB `POST /execs` limit.
    let launchFinished = finished;
    let launchCwd = input.cwd;
    let launchActivityPath = input.activityPath;

    const candidateLauncher =
      Buffer.byteLength(input.command) <= inlineCommandBytes
        ? launcher({
            tag,
            cwd: launchCwd,
            activityPath: launchActivityPath,
            envFile,
            staged,
            finished: launchFinished,
            command: input.command,
          })
        : undefined;

    if (
      candidateLauncher === undefined ||
      Buffer.byteLength(candidateLauncher) > maxAsyncCommandBytes
    ) {
      files.push({ path: `${dir}/cmd`, bytes: Buffer.from(input.command) });
      staged += "c";
      command = undefined;
    }

    const measureLauncher = () =>
      Buffer.byteLength(
        launcher({
          tag,
          cwd: launchCwd,
          activityPath: launchActivityPath,
          envFile,
          staged,
          finished: launchFinished,
          command,
        }),
      );

    // If non-command arguments (finished IDs, quote-heavy cwd or activityPath) still push the
    // launcher over 16 KiB, omit finished IDs first (the bridge's sweep handles them), then stage
    // cwd and activityPath in `meta.json`.
    if (measureLauncher() > maxAsyncCommandBytes && launchFinished.length > 0) launchFinished = [];

    if (measureLauncher() > maxAsyncCommandBytes) {
      files.push({
        path: `${dir}/meta.json`,
        bytes: Buffer.from(JSON.stringify({ cwd: input.cwd, act: input.activityPath ?? "" })),
      });
      staged += "m";
      launchCwd = "";
      launchActivityPath = undefined;
    }

    if (!state.bridge) preludes.push(installBridge);

    if (shared.length) preludes.push(envDir);

    if (files.length) preludes.push(commandDir(tag));

    if (preludes.length || files.length || shared.length) {
      const steps = stageCommands(
        preludes.join("; ") || ":",
        [...shared, ...files],
        files.length > 0 ? tag : undefined,
      );

      for (const step of steps) await shell(id, step, { timeoutMs: 75_000, signal });
      state.bridge = true;

      if (input.envMode === "sandbox" && envFile !== undefined && shared.length)
        state.envs.set(JSON.stringify(input.env), envFile);
    }

    return {
      envFile,
      staged,
      command,
      cwd: launchCwd,
      activityPath: launchActivityPath,
      finished: launchFinished,
    };
  }

  /**
   * Starts the launcher on `POST /execs`. A `409` (Buddy refused it, nothing ran) or a request that never
   * left this process is sent again a few times; any other failure stands. A `2xx` whose body is not an
   * execution was accepted, but names none: `undefined`, for the caller to find it by its tag.
   */
  async function launch(
    id: string,
    command: string,
    signal: AbortSignal,
  ): Promise<BuddyExec | undefined> {
    for (let attempt = 0; ; attempt++) {
      let response: HttpResponse;

      try {
        response = await http.request({
          method: "POST",
          ...sandboxPath(id, "/execs"),
          body: { command, runtime: "BASH" },
          signal,
        });
      } catch (error) {
        const refused = isFault(error, "busy") || neverSent(error);

        if (!refused || attempt >= 4 || signal.aborted) throw error;
        await delay(500 * 2 ** attempt, signal);
        continue;
      }

      try {
        const text = await response.text();
        const raw: JsonValue = JSON.parse(text);

        return parseExec(raw);
      } catch {
        return undefined;
      }
    }
  }

  /** Removes a command's private directory, on a fresh bounded deadline; best effort. */
  async function discard(id: string, tag: string) {
    await run(id, removeCommand(tag), { timeoutMs: 10_000 }).catch(() => {});
  }

  /** Cancels any late in-flight staging under the command's lock and deletes private staged files. */
  async function cancelStaging(id: string, tag: string): Promise<SandboxError | undefined> {
    try {
      await killGroup(id, tag, true);

      return undefined;
    } catch (error) {
      return error instanceof SandboxError
        ? error
        : fail("staging cancellation could not be confirmed", "outcome_unknown", { sandboxId: id });
    }
  }

  /** Finds a launch whose answer was lost, by its tag in the recorded command. */
  async function findLaunch(
    id: string,
    tag: string,
    signal?: AbortSignal,
  ): Promise<BuddyExec | undefined> {
    try {
      const execs = parseExecs(
        await http.json({
          method: "GET",
          ...sandboxPath(id, "/execs"),
          query: { limit: 20 },
          timeoutMs: cleanupMs,
          signal,
        }),
      );

      return execs.find((exec) => exec.command.includes(tag));
    } catch {
      return undefined;
    }
  }

  async function attempt(id: string, input: ExecInput): Promise<Attempt> {
    // Chosen before anything is sent: the bridge records the command's group under it, so a cancel finds it.
    const tag = randomUUID();
    // Ends the adapter's waits once it stops listening. Never the caller's signal.
    const reading = new AbortController();
    let cancelled = false;

    const cancel = () => {
      cancelled = true;
      reading.abort();
    };

    // Node fires a timer longer than 2^31 - 1 ms at once; past that Buddy's 90-minute cap ends the command.
    const timer = setTimeout(cancel, Math.min(input.timeoutMs, 2 ** 31 - 1));
    input.signal?.addEventListener("abort", cancel, { once: true });

    if (input.signal?.aborted) cancel();

    let execId: string | undefined;

    /**
     * Stops the command: the guest killer first, which under the command's lock either stops it from
     * starting or kills its group and confirms it gone, and only then Buddy's `DELETE /execs/{id}`, which
     * ends the bridge. Deleting first could kill the bridge while the command it started runs on. The
     * killed command's directory is kept for its spool; `outcome_unknown` when the stop is unconfirmed.
     */
    const stop = async (): Promise<KillState> => {
      const state = await killGroup(id, tag, true);

      if (execId !== undefined && state !== "gone")
        await http
          .request({ method: "DELETE", ...sandboxPath(id, `/execs/${execId}`), timeoutMs: 10_000 })
          .catch(() => {});

      return state;
    };

    try {
      // Snapshot finished directories to clean on launch without removing them until we launch.
      const state = guestOf(id);
      const finished = state.finished.slice(0, 16);
      let prepared: Awaited<ReturnType<typeof stage>>;

      const stopUncertainLaunch = async (): Promise<Attempt> => {
        // Immediately write the guest cancel marker and kill the process group by tag first,
        // without waiting on Buddy's launch or history endpoints.
        const killState = await killGroup(id, tag, true);
        const found = await findLaunch(id, tag, AbortSignal.timeout(10_000));

        if (found !== undefined && killState !== "gone")
          await http
            .request({
              method: "DELETE",
              ...sandboxPath(id, `/execs/${found.id}`),
              timeoutMs: 10_000,
            })
            .catch(() => {});

        if (killState === "killed" || killState === "refused") await discard(id, tag);

        return { kind: "result", result: timedOut };
      };

      try {
        prepared = await stage(id, tag, input, finished, reading.signal);
      } catch (error) {
        // Nothing was launched: write the cancel marker under lock and remove any staged files so
        // a late server-side staging command cannot recreate private input afterwards. Re-check
        // `cancelled` AFTER cleanup so an abort arriving mid-cleanup never returns `timedOut` when
        // cancellation failed.
        const cancelError = await cancelStaging(id, tag);

        if (cancelled) {
          if (cancelError !== undefined) throw cancelError;

          return { kind: "result", result: timedOut };
        }

        throw error;
      }

      if (cancelled) {
        // Nothing was launched: lock-guarded cancel removes staged env/stdin/cmd and blocks late writes.
        if (prepared.staged) {
          const cancelError = await cancelStaging(id, tag);

          if (cancelError !== undefined) throw cancelError;
        }

        return { kind: "result", result: timedOut };
      }

      state.finished.splice(0, prepared.finished.length);

      const command = launcher({
        tag,
        cwd: prepared.cwd,
        activityPath: prepared.activityPath,
        envFile: prepared.envFile,
        staged: prepared.staged,
        finished: prepared.finished,
        command: prepared.command,
      });

      let launched: BuddyExec | undefined;

      try {
        launched = await launch(id, command, reading.signal);
      } catch (error) {
        if (cancelled) {
          if (neverSent(error)) {
            if (prepared.staged) {
              const cancelError = await cancelStaging(id, tag);

              if (cancelError !== undefined) throw cancelError;
            }

            return { kind: "result", result: timedOut };
          }

          return stopUncertainLaunch();
        }

        if (!isUnknown(error)) {
          // Refused before anything ran: the staged input goes with it.
          if (prepared.staged) await discard(id, tag);

          throw error;
        }
      }

      // The launch may have reached Buddy (a lost or unreadable answer): find it by its tag, else make
      // sure it never starts. Only the guest's own record that it refused proves it never ran: a miss
      // in Buddy's history does not, since a fast command can run and end before the read.
      if (launched === undefined) {
        if (cancelled) return stopUncertainLaunch();

        launched = await findLaunch(id, tag, reading.signal);

        if (cancelled) return stopUncertainLaunch();

        if (launched === undefined) {
          const state = await killGroup(id, tag);

          if (state === "refused")
            throw fail(
              "the command's start was not confirmed, and it was stopped before it could run. Retry it",
              "unavailable",
              { sandboxId: id, retryable: true },
            );

          throw fail(
            "the command's start was not confirmed and Buddy's history does not show it. It cannot start any more, but it may have run; check the sandbox before retrying",
            "outcome_unknown",
            { sandboxId: id },
          );
        }
      }

      execId = launched.id;

      const outcome = await follow(id, tag, execId, input, {
        reading,
        cancelled: () => cancelled,
        stop,
      });

      // A command that ran to its exit frame leaves its directory for the next launch to remove.
      if (outcome.kind === "result" && !outcome.result.timedOut) guestOf(id).finished.push(tag);

      return outcome;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      reading.abort();
    }
  }

  /**
   * Reads a running command's frames until its exit frame: from Buddy's log, and from the guest spool when
   * the log has a gap, is cut, or the execution ended without the exit frame.
   */
  async function follow(
    id: string,
    tag: string,
    execId: string,
    input: ExecInput,
    control: {
      reading: AbortController;
      cancelled(): boolean;
      stop(): Promise<KillState>;
    },
  ): Promise<Attempt> {
    const reader = new FrameReader(input.onChunk, id);
    const streaming = input.streaming === true;
    const splitter = new LineSplitter(id);
    let offset = 0;
    let spoolOffset = 0;
    let spool = false;
    let terminal: BuddyExec | undefined;
    let hold = streaming ? 1000 : 25_000;

    const result = (): Attempt => ({
      kind: "result",
      result: { exitCode: reader.exitCode ?? null, timedOut: false },
    });

    /**
     * Stops the command, then hands on the output it wrote before the stop, on a short deadline of its
     * own: Buddy's log first, then the spool when the log was cut, had a gap or could not be read. Only
     * then does a killed command's directory go.
     */
    const stopped = async (): Promise<Attempt> => {
      const state = await control.stop();

      if (!spool) {
        await drainLog(AbortSignal.timeout(5000)).catch(() => {});
      }

      // Always drain the guest spool on abort/timeout too: Buddy's log can lag or return empty with
      // `truncated: false` even after the bridge wrote frames to the spool. FrameReader deduplicates by
      // sequence number, so frames already delivered from the log are skipped cleanly.
      if (state !== "gone" && reader.exitCode === undefined)
        await drainSpool(createDeadline(5000)).catch(() => {});

      if (state === "killed") await discard(id, tag);

      return { kind: "result", result: timedOut };
    };

    /** An error this reader decided on: the command is stopped first, then the error stands as is. */
    let settled: SandboxError | undefined;

    /** Stops whatever may still run, then reports `error`. */
    const abandon = async (error: SandboxError): Promise<never> => {
      settled = error;
      await killGroup(id, tag);
      throw error;
    };

    const execPath = (route = "", signal = control.reading.signal) => ({
      path: `/sandboxes/{id}/execs/{exec}${route}`,
      params: { id, exec: execId },
      sandboxId: id,
      signal,
    });

    async function drainLog(signal?: AbortSignal) {
      for (;;) {
        const slice = parseLog(
          await http.json({
            method: "GET",
            ...execPath("/log", signal),
            query: { offset, limit: 1000 },
          }),
          offset,
        );

        offset = slice.nextOffset;

        for (const line of slice.lines) {
          if (reader.line(line, "log") === "gap") {
            spool = true;

            return;
          }

          if (reader.exitCode !== undefined) return;
        }

        if (slice.truncated) {
          spool = true;

          return;
        }

        if (slice.lines.length < 1000) return;
      }
    }

    async function status(waitMs: number) {
      const view = parseExec(
        await http.json({
          method: "GET",
          ...execPath(),
          query: { wait: waitMs },
          timeoutMs: waitMs + requestTimeoutMs,
        }),
      );

      if (view.truncated) spool = true;

      if (view.status !== "INPROGRESS") terminal = view;
    }

    /** Feeds spool bytes from `spoolOffset`; whether the exit frame arrived. */
    function feed(bytes: Uint8Array): boolean {
      spoolOffset += bytes.length;

      for (const line of splitter.push(bytes)) {
        reader.line(line, "spool");

        if (reader.exitCode !== undefined) return true;
      }

      return false;
    }

    const readSpool = async () => {
      const read = parseSpool(
        await shell(id, spoolCommand(tag, spoolOffset), {
          readOnly: true,
          signal: control.reading.signal,
        }),
      );

      if (read === undefined)
        return abandon(
          fail("the command's output spool could not be read", "provider", { sandboxId: id }),
        );

      return read;
    };

    /** Reads the rest of a stopped command's spool within `deadline`. */
    async function drainSpool(deadline: Deadline) {
      for (;;) {
        const read = parseSpool(
          await shell(id, spoolCommand(tag, spoolOffset), { readOnly: true, deadline }),
        );

        if (read?.kind !== "bytes" || feed(read.bytes) || !read.more) return;
      }
    }

    /** The execution ended with no exit frame anywhere: a platform failure, or a bridge that never ran. */
    const failed = async (ended: BuddyExec): Promise<Attempt> => {
      const refused = reader.preface.some(
        (line) => line === notStarted.bridge || line === notStarted.stage,
      );

      if (!reader.framed && refused) return { kind: "not-started" };

      if (ended.failureReason === "TIMEOUT")
        return abandon(
          fail("Buddy stopped the command at its 90-minute limit", "timeout", { sandboxId: id }),
        );

      if (ended.status === "CANCELLED")
        return abandon(
          fail("the command was cancelled outside this client", "provider", { sandboxId: id }),
        );

      return abandon(
        fail(
          reader.framed
            ? "the command ended without reporting its exit code"
            : "the command bridge did not start (python3, setsid and flock are required in the sandbox)",
          "provider",
          { sandboxId: id },
        ),
      );
    };

    /** One step of reading. `undefined` to go on. */
    async function step(first: boolean): Promise<Attempt | undefined> {
      if (!spool) {
        // A buffered command waits on its status first: one held request until it ends.
        if (first && !streaming) await status(hold);
        await drainLog();

        if (reader.exitCode !== undefined) return result();

        if (spool) return undefined;

        if (terminal) {
          // Ended and fully read with no exit frame. The launcher's own refusal has no frames and no
          // spool; otherwise the spool may hold what the log lost.
          if (!reader.framed && reader.preface.length > 0) return failed(terminal);
          spool = true;

          return undefined;
        }

        await status(hold);

        return undefined;
      }

      const read = await readSpool();

      if (read.kind === "missing") {
        if (terminal) return failed(terminal);
        await status(hold);

        return undefined;
      }

      if (feed(read.bytes)) return result();

      if (read.more) return undefined;

      if (read.done)
        return abandon(
          fail("the command's output spool ended without its exit code", "provider", {
            sandboxId: id,
          }),
        );

      if (!terminal) {
        await status(hold);

        return undefined;
      }

      // The execution ended and the bridge has not: Buddy stopped it. One more read settles it.
      const last = await readSpool();

      if (last.kind === "bytes") {
        if (feed(last.bytes)) return result();

        if (last.more) return undefined;
      }

      return failed(terminal);
    }

    // Cancelled while the launch was answered or looked up: stop it before reading anything.
    if (control.cancelled()) return stopped();

    for (let first = true; ; first = false) {
      const before = reader.next;
      let outcome: Attempt | undefined;

      try {
        outcome = await step(first);
      } catch (error) {
        if (settled !== undefined) throw error;

        if (control.cancelled()) return stopped();

        // Output that cannot be decoded, or a command that cannot be followed: stop it, then report it.
        settled = fail(
          "the command's output could not be read before it finished",
          "outcome_unknown",
          { sandboxId: id, cause: error instanceof SandboxError ? error.message : undefined },
        );
        await killGroup(id, tag);

        throw error instanceof FrameError ? error : settled;
      }

      if (outcome) return outcome;

      if (control.cancelled()) return stopped();

      if (streaming) hold = reader.next > before ? 1000 : Math.min(5000, Math.ceil(hold * 1.5));
    }
  }

  /**
   * One command on `POST /execs` under the bridge. A timeout or abort cancels the execution and kills the
   * command's process group in the guest before this settles. Once the launch may have reached Buddy, it
   * is never sent again; a bridge that refused to start (its file or staged input missing) is staged and
   * launched once more, since nothing ran.
   */
  async function exec(id: string, input: ExecInput): Promise<ExecResult> {
    if (input.signal?.aborted) return timedOut;

    for (let round = 0; ; round++) {
      const outcome = await attempt(id, input);

      if (outcome.kind === "result") return outcome.result;

      if (round >= 1)
        throw fail("the command bridge could not be started in the sandbox", "provider", {
          sandboxId: id,
        });
      // The guest lost what this client put there (a restart, a wiped /tmp): put it back.
      guests.delete(id);
    }
  }

  function assertDownloadFile(headers: Headers, id: string, path: string) {
    const type = (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    const disposition = headers.get("content-disposition") ?? "";

    if (type === "application/octet-stream") return;

    if (type === "application/gzip" || /\.tar\.gz"?\s*$/i.test(disposition))
      throw fail(`${path} is a directory, not a file`, "invalid_argument", { sandboxId: id });

    throw fail("the download answered with a content type the adapter does not know", "provider", {
      sandboxId: id,
    });
  }

  async function readFile(id: string, path: string): Promise<Uint8Array> {
    await ensureBootRepaired(id, path);

    const response = await http.request({
      method: "GET",
      path: `/sandboxes/{id}/download/${guestPath(path)}`,
      params: { id },
      sandboxId: id,
      timeoutMs: 300_000,
      maxBytes: maxReadBytes,
    });

    assertDownloadFile(response.headers, id, path);

    return response.body;
  }

  /**
   * Streams only `range` of a file so a large or growing file is never buffered whole in host memory.
   */
  async function readFileRange(
    id: string,
    path: string,
    range: { offset: number; length: number },
  ): Promise<Uint8Array> {
    await ensureBootRepaired(id, path);

    const response = await http.stream({
      method: "GET",
      path: `/sandboxes/{id}/download/${guestPath(path)}`,
      params: { id },
      sandboxId: id,
      timeoutMs: 300_000,
    });

    try {
      assertDownloadFile(response.headers, id, path);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }

    if (range.length <= 0) {
      await response.body?.cancel().catch(() => {});

      return new Uint8Array(0);
    }

    const end = range.offset + range.length;
    const kept: Uint8Array[] = [];
    let seen = 0;
    let size = 0;
    const reader = response.body?.getReader();

    try {
      while (reader && seen < end) {
        const { done, value } = await reader.read();

        if (done) break;
        const from = Math.max(range.offset - seen, 0);
        const to = Math.min(end - seen, value.byteLength);

        if (to > from) {
          kept.push(value.slice(from, to));
          size += to - from;
        }

        seen += value.byteLength;
      }
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw fail("the file read broke off", "unavailable", { sandboxId: id });
    } finally {
      await reader?.cancel().catch(() => {});
    }

    const bytes = new Uint8Array(size);
    let at = 0;

    for (const part of kept) {
      bytes.set(part, at);
      at += part.byteLength;
    }

    return bytes;
  }

  async function writeFile(id: string, path: string, bytes: Uint8Array) {
    const form = new FormData();
    const fileName = posix.basename(posix.resolve("/workspace", path)) || "file";

    // A copy owns a plain ArrayBuffer, which Blob requires.
    form.append("file", new Blob([new Uint8Array(bytes)]), fileName);
    await http.request({
      method: "POST",
      path: `/sandboxes/{id}/content/upload/${guestPath(path)}`,
      params: { id },
      sandboxId: id,
      query: { userName: "buddy" },
      body: form,
      // Writing the same bytes to the same path twice is the same as once, so a lost answer is retried.
      idempotencyKey: randomUUID(),
      timeoutMs: 300_000,
    });
  }

  const guest = (id: string): Guest => ({
    name,
    raw: (command) => shell(id, command),
    upload: (path, bytes) => writeFile(id, path, bytes),
    read: (path, range) => (range ? readFileRange(id, path, range) : readFile(id, path)),
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
    readRange: readFileRange,
    write: async (id, path, bytes) => {
      await writeFile(id, path, bytes);
    },
    list: async (id, path) => {
      await ensureBootRepaired(id, path);

      return shared.list(id, path);
    },
    stat: async (id, path) => {
      await ensureBootRepaired(id, path);

      return shared.stat(id, path);
    },
    mkdir: shared.mkdir,
    remove: shared.remove,
  };

  /** Deletes a sandbox this call made, on a fresh deadline, then reports `cause`; `outcome_unknown` when unconfirmed. */
  async function abandon(id: string, cause: unknown): Promise<never> {
    try {
      await destroy(id, cleanupMs);
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

  function createBody(input: CreateInput, alloc: string, identifier: string): JsonObject {
    if (input.timeoutMs !== undefined)
      throw fail(
        "Buddy has no lifetime limit. Use idleTimeoutMs, which stops the sandbox after that long without activity",
        "unsupported",
      );

    const note = noteText({
      alloc,
      key: input.key,
      labels: { ...input.labels },
      secrets: [...(input.secretNames ?? [])],
    });

    // The SDK marker goes in the tags and the note on a clean create and a restore alike: Buddy stores
    // both with the sandbox, so a sandbox is never findable without them.
    const body: JsonObject = { name: identifier, identifier, tags: [sdkTag], note };

    if (input.from !== undefined) body.snapshot_id = input.from;
    else body.os = options.os ?? "ubuntu:24.04";

    if (input.size !== undefined) body.resources = resourcesOf(input.size);

    if (input.idleTimeoutMs !== undefined) {
      const seconds = Math.ceil(input.idleTimeoutMs / 1000);

      if (!Number.isSafeInteger(seconds) || seconds < 1)
        throw fail("idleTimeoutMs must be at least one second", "unsupported");
      body.timeout = seconds;
    }

    // Every create-time variable is encrypted at Buddy: its value is never returned in plain text, and
    // Buddy puts it in the environment of every command, before and after a restart.
    const env = Object.entries(input.env ?? {});

    if (env.length)
      body.variables = env.map(([key, value]) => ({ key, value, type: "VAR", encrypted: true }));

    return body;
  }

  /**
   * After a create whose answer was lost, unreadable or refused for a taken identifier: within one fresh
   * {@link cleanupMs} deadline, find the sandbox holding the identifier this call sent, and return it only
   * when its note carries this call's allocation ID. The inventory is read again with backoff until the
   * deadline while it shows no holder (or a read fails): a create Buddy took can be missing from one
   * listing. `none` when no read in the window showed a holder; `foreign` when another call's sandbox
   * holds the identifier.
   */
  async function reconcile(identifier: string, alloc: string): Promise<Reconciled> {
    const deadline = createDeadline(cleanupMs);

    for (let wait = 250; ; wait = Math.min(wait * 2, 4000)) {
      const found = await holderOf(identifier, alloc, deadline).catch(() => undefined);

      if (found) return found;

      const left = deadline.remaining();

      if (left <= 100) return { kind: "none" };
      await delay(Math.min(wait, Math.max(100, left - 400)));
    }
  }

  /** One inventory read for {@link reconcile}: `undefined` when no sandbox shows the identifier yet. */
  async function holderOf(
    identifier: string,
    alloc: string,
    deadline: Deadline,
  ): Promise<Exclude<Reconciled, { kind: "none" }> | undefined> {
    const holders = (await listSummaries({ deadline })).filter((s) => s.identifier === identifier);
    let foreign = false;

    for (const holder of holders) {
      let sandbox: BuddySandbox;

      try {
        sandbox = await readSandbox(holder.id, { deadline });
      } catch (error) {
        // Deleted since the listing: it holds nothing now.
        if (isGone(error)) continue;
        throw error;
      }

      if (sandbox.identifier === identifier && sandbox.note?.alloc === alloc)
        return { kind: "ours", sandbox };
      foreign = true;
    }

    return foreign ? { kind: "foreign" } : undefined;
  }

  async function createSandbox(input: CreateInput): Promise<BuddySandbox> {
    const alloc = randomUUID();

    const identifier =
      input.key === undefined ? unkeyedIdentifier(alloc) : keyedIdentifier(input.key, project);

    const body = createBody(input, alloc, identifier);

    const taken = () =>
      fail(
        input.key === undefined
          ? `another sandbox already holds the identifier ${identifier}`
          : "another create made the sandbox for this key first",
        "unavailable",
        { retryable: true },
      );

    let answer: BuddySandbox | undefined;

    try {
      // Not the caller's signal: once sent, the answer names the sandbox to delete. An abort is honoured after it arrives.
      const raw = readJson(
        await http.request({ method: "POST", path: "/sandboxes", ...scoped, body }),
      );

      try {
        answer = parseSandbox(raw);
      } catch {
        answer = undefined;
      }
    } catch (error) {
      const held = isFault(error, "identifier_taken");

      if (!held && !isUnknown(error)) throw error;
      const found = await reconcile(identifier, alloc).catch(() => undefined);

      if (found?.kind === "ours") return found.sandbox;

      // Identifiers are unique: another call's sandbox holding this one proves ours was not made.
      if (found?.kind === "foreign" || held) throw taken();
      throw error;
    }

    // An answer naming no sandbox, or one without this call's note, is checked by a read.
    if (answer?.note?.alloc === alloc && answer.identifier === identifier) return answer;
    const found = await reconcile(identifier, alloc).catch(() => undefined);

    if (found?.kind === "ours") return found.sandbox;

    if (found?.kind === "foreign") throw taken();
    throw fail(
      "the create was answered, but its answer did not name this call's sandbox, so a sandbox may exist; it was left alone",
      "outcome_unknown",
      answer ? { sandboxId: answer.id } : {},
    );
  }

  /** Serializes one sandbox's preview changes in this process. */
  function queued<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = previewQueues.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(action);
    const tail = next.catch(() => {});
    previewQueues.set(id, tail);
    void tail.then(() => {
      if (previewQueues.get(id) === tail) previewQueues.delete(id);
    });

    return next;
  }

  async function readCredentials(id: string, port: number) {
    const text = await shell(id, `cat ${previewDir}/${port} 2>/dev/null || true`, {
      readOnly: true,
    });

    const found = parseCredentials(text.trim(), port);

    if (found) {
      addSandboxToken(id, found.password);
      addSandboxToken(id, basic(found));
    }

    return found;
  }

  /**
   * The preview an existing endpoint already gives, or undefined when it must be made or changed. A
   * private endpoint's credentials are read from the guest only when the endpoint is there.
   */
  async function existing(id: string, sandbox: BuddySandbox, port: number) {
    const endpoint = sandbox.endpoints.find((e) => e.name === `sbx-p${port}`);

    if (!endpoint || endpoint.endpoint !== String(port)) return undefined;
    const url = urlOf(endpoint);
    const auth = authOf(endpoint);

    if (!url) return undefined;

    if (options.public) return auth === "NONE" ? { url } : undefined;

    if (auth !== "BASIC") return undefined;
    const credentials = await readCredentials(id, port);

    return credentials ? { url, headers: { Authorization: basic(credentials) } } : undefined;
  }

  async function makePreview(id: string, port: number): Promise<Preview> {
    const endpointName = `sbx-p${port}`;
    const auth = options.public ? "NONE" : "BASIC";
    const owner = randomUUID();
    const lockLeaseMinutes = Math.max(2, Math.ceil((requestTimeoutMs * 2 + 60_000) / 60_000));
    const locked = await run(id, lockCommand(owner, lockLeaseMinutes), { timeoutMs: 40_000 });

    if (locked.exitCode === 75)
      throw fail("another client is changing this sandbox's endpoints; retry", "unavailable", {
        sandboxId: id,
        retryable: true,
      });

    if (locked.exitCode !== 0)
      throw fail(`the endpoint lock could not be taken (exit ${locked.exitCode})`, "provider", {
        sandboxId: id,
      });

    const lockDeadline = createDeadline((lockLeaseMinutes * 60 - 30) * 1000);
    let released = false;

    try {
      const sandbox = await readSandbox(id, { deadline: lockDeadline });
      const reused = await existing(id, sandbox, port);

      if (reused) return reused;

      // Every endpoint is checked before any is dropped or replaced, the one under this preview's name
      // included: a change must keep all others exactly, and may replace only an HTTP endpoint on this
      // port with nothing it would lose. Messages never carry Buddy's endpoint values.
      const checked = sandbox.endpoints.map((e) => ({ endpoint: e, kept: preservedEndpoint(e) }));

      if (checked.some((c) => c.kept === undefined))
        throw fail(
          "the sandbox has an endpoint with TLS or encrypted settings that a change would not keep; previews were not changed",
          "provider",
          { sandboxId: id },
        );

      if (
        checked.some(
          (c) =>
            c.endpoint.name === endpointName &&
            (c.endpoint.type !== "HTTP" || c.endpoint.endpoint !== String(port)),
        )
      )
        throw fail(
          `an endpoint named ${endpointName} has settings this preview would not keep; previews were not changed`,
          "provider",
          { sandboxId: id },
        );

      const others = checked.flatMap((c) =>
        c.endpoint.name !== endpointName && c.kept ? [c.kept] : [],
      );

      // Reuse any saved password on disk (e.g. after switching private -> public -> private) or persist
      // the new credentials under the lock BEFORE patching Buddy, so Buddy never holds a BASIC password
      // that disagrees with the guest's preview credential file.
      let made: PreviewCredentials | undefined;

      if (auth === "BASIC") {
        const saved = await readCredentials(id, port);

        if (saved) {
          made = saved;
          addSandboxToken(id, basic(saved).slice("Basic ".length));
        } else {
          made = { port, login: "sbx", password: randomBytes(24).toString("base64url") };
          addSandboxToken(id, made.password);
          addSandboxToken(id, basic(made));
          addSandboxToken(id, basic(made).slice("Basic ".length));

          const wrote = await run(id, writeCredentialsCommand(owner, made), {
            deadline: lockDeadline,
          });

          if (wrote.exitCode === 75)
            throw fail(
              "the endpoint lock expired before saving credentials; retry",
              "unavailable",
              {
                sandboxId: id,
                retryable: true,
              },
            );

          if (wrote.exitCode !== 0)
            throw fail(
              `the preview credentials could not be saved (exit ${wrote.exitCode})`,
              "provider",
              {
                sandboxId: id,
              },
            );
        }
      }

      const ours: JsonObject = {
        name: endpointName,
        endpoint: String(port),
        type: "HTTP",
        http: made
          ? { auth_type: "BASIC", login: made.login, password: made.password }
          : { auth_type: "NONE" },
      };

      const existed = sandbox.endpoints.some((e) => e.name === endpointName);
      let after: BuddySandbox;

      try {
        after = parseSandbox(
          await http.json({
            method: "PATCH",
            ...sandboxPath(id),
            body: { endpoints: [...others, ours] },
            deadline: lockDeadline,
          }),
        );
      } catch (error) {
        if (!isUnknown(error)) throw error;

        // Under the lock no other client changed the endpoints: a new endpoint of ours with the asked
        // port and auth means the change took. A changed one cannot be told apart, so that stays unknown.
        const check = await readSandbox(id, { deadline: lockDeadline }).catch(() => {
          throw error;
        });

        const applied = check.endpoints.find((e) => e.name === endpointName);

        if (existed || !applied || applied.endpoint !== String(port) || authOf(applied) !== auth)
          throw error;
        after = check;
      }

      const endpoint = after.endpoints.find((e) => e.name === endpointName);
      const url = endpoint ? urlOf(endpoint) : undefined;

      if (!url)
        throw fail("the endpoint was saved but Buddy returned no URL for it", "provider", {
          sandboxId: id,
        });

      await shell(id, unlockCommand(owner), { timeoutMs: 30_000 });
      released = true;

      return made ? { url, headers: { Authorization: basic(made) } } : { url };
    } finally {
      if (!released) await shell(id, unlockCommand(owner), { timeoutMs: 30_000 }).catch(() => {});
    }
  }

  const provider: BuddyProvider = {
    name,
    // Buddy identifiers are unique across the workspace, and a keyed sandbox's identifier is its key's.
    keyMode: "exact",
    inlineActivity: true,
    // The secret names live in the sandbox's note, written with the sandbox itself.
    recordsSecretNames: true,
    capabilities: new Set<BuddyCapability>(["pause", "snapshot", "snapshot-delete", "size"]),
    api,

    async create(input) {
      const pending = new Set<string>();

      for (const secret of input.secretNames ?? []) {
        const value = input.env?.[secret];

        if (value) pending.add(value);
      }

      if (pending.size > 0) pendingCreateTokens.add(pending);

      try {
        const sandbox = await createSandbox(input);
        const id = sandbox.id;

        if (pending.size > 0) {
          addSandboxTokens(id, pending);
          pendingCreateTokens.delete(pending);
        }

        const aborted = () => fail("creation aborted", "aborted", { sandboxId: id });

        try {
          if (input.signal?.aborted) throw aborted();
          const deadline = createDeadline(readyMs, input.signal);

          if (sandbox.status !== "RUNNING" || sandbox.setupStatus !== "SUCCESS")
            await untilReady(id, deadline);
          await setUp(id, deadline);

          if (input.signal?.aborted) throw aborted();
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
      } finally {
        pendingCreateTokens.delete(pending);
      }
    },

    async find(key, findOptions) {
      const identifier = keyedIdentifier(key, project);
      const holder = (await listSummaries()).find((s) => s.identifier === identifier);

      if (!holder) return undefined;
      let sandbox: BuddySandbox;

      try {
        sandbox = await readSandbox(holder.id);
      } catch (error) {
        if (isGone(error)) return undefined;
        throw error;
      }

      if (sandbox.note?.key !== key) return undefined;

      // A failed sandbox never runs again, and it holds the key's identifier: delete it so a new one can be made.
      if (sandbox.status === "FAILED" || sandbox.setupStatus === "FAILED") {
        await destroy(sandbox.id);

        return undefined;
      }

      if (sandbox.status === "STOPPED" || sandbox.status === "STOPPING") return toInfo(sandbox);

      // Another create may still be starting it: wait until it runs, is set up and has /workspace.
      return toInfo(await ready(sandbox.id, findOptions?.signal));
    },

    async connect(id) {
      // A read only: it never starts a stopped sandbox.
      return toInfo(await readSandbox(id));
    },

    async isStopped(id) {
      const { status } = await readSandbox(id);

      return status === "STOPPED" || status === "FAILED";
    },

    async list(labels: Labels): Promise<SandboxInfo[]> {
      const ours = (await listSummaries()).filter((s) => isSdkIdentifier(s.identifier));
      const found: SandboxInfo[] = [];

      for (let start = 0; start < ours.length; start += 8) {
        const page = await Promise.all(
          ours.slice(start, start + 8).map((s) =>
            readSandbox(s.id).catch((error) => {
              if (isGone(error)) return undefined;
              throw error;
            }),
          ),
        );

        for (const sandbox of page) {
          if (!sandbox?.note) continue;
          const info = toInfo(sandbox);

          if (Object.entries(labels).every(([k, v]) => info.labels[k] === v)) found.push(info);
        }
      }

      return found;
    },

    destroy: (id) => destroy(id),

    async close(id) {
      forget(id);
      sandboxTokens.delete(id);
    },

    exec,
    files,

    async previewUrl(id, port) {
      const key = `${id}:${port}`;
      const cached = previews.get(key);

      if (cached) return cached;

      return queued(id, async () => {
        const again = previews.get(key);

        if (again) return again;

        // Most calls find the endpoint and its credentials already there: no lock and no change.
        const preview =
          (await existing(id, await readSandbox(id), port)) ?? (await makePreview(id, port));

        previews.set(key, preview);

        return preview;
      });
    },

    native(id) {
      let value = natives.get(id);

      if (!value) {
        value = createNativeApi<BuddyPlane>({ http, placeholder: "sandbox_id", sandboxId: id });
        natives.set(id, value);
      }

      return value;
    },

    async readSecretEnvironment(id) {
      const sandbox = await readSandbox(id);
      const names = sandbox.note?.secrets ?? [];

      if (names.length === 0) return undefined;

      // `POST /exec` is not recorded, so the values never enter Buddy's command history.
      const text = await shell(
        id,
        `python3 -c ${quote("import base64,json,os,sys;sys.stdout.write(base64.b64encode(json.dumps(dict(os.environ)).encode()).decode())")}`,
        { readOnly: true },
      );

      let environment: JsonValue;

      try {
        environment = JSON.parse(Buffer.from(text.trim(), "base64").toString());
      } catch {
        throw fail("the sandbox environment could not be read", "provider", { sandboxId: id });
      }

      if (!isJsonObject(environment))
        throw fail("the sandbox environment could not be read", "provider", { sandboxId: id });

      const values: Record<string, string> = {};

      for (const [key, value] of Object.entries(environment))
        if (isString(value)) values[key] = value;

      // Re-arm provider redaction for recovered secrets after reconnect.
      for (const secretName of names) {
        const value = values[secretName];

        if (value) addSandboxToken(id, value);
      }

      return { record: JSON.stringify(names), environment: values };
    },

    async pause(id) {
      try {
        await http.request({ method: "POST", ...sandboxPath(id, "/stop") });
      } catch (error) {
        // Already stopped (or stopping) is the outcome asked for.
        if (!isFault(error, "not_running")) throw error;
      }

      const deadline = createDeadline(readyMs);

      for (;;) {
        const sandbox = await readSandbox(id, { deadline });

        if (sandbox.status === "STOPPED") break;

        if (sandbox.status !== "STOPPING" && sandbox.status !== "RUNNING")
          throw fail(`the sandbox is ${sandbox.status ?? "unknown"}, not stopping`, "provider", {
            sandboxId: id,
          });
        await sleep(250, deadline, name);
      }

      forget(id);
    },

    async resume(id) {
      let sandbox = await readSandbox(id);
      forget(id);

      if (sandbox.status === "STOPPING") {
        const deadline = createDeadline(readyMs);

        while (sandbox.status === "STOPPING") {
          await sleep(250, deadline, name);
          sandbox = await readSandbox(id, { deadline });
        }
      }

      if (sandbox.status === "STOPPED")
        await http.request({ method: "POST", ...sandboxPath(id, "/start") });

      await ready(id, undefined, { stopped: true });
    },

    async snapshot(id, snapshotOptions) {
      if (snapshotOptions?.expiresInMs)
        throw fail("snapshots are kept until deleted; omit expiresInMs", "unsupported", {
          sandboxId: id,
        });
      // The name is chosen before the request, so a lost or malformed answer can be looked up by it.
      const snapshotName = `sandbox-sdk-${randomUUID()}`;

      const lookUpOnce = async (lookupDeadline: Deadline) =>
        parseSnapshots(
          await http.json({
            method: "GET",
            ...sandboxPath(id, "/snapshots"),
            deadline: lookupDeadline,
          }),
        ).find((s) => s.name === snapshotName);

      const lookUp = async () => {
        const lookupDeadline = createDeadline(10_000);

        for (let delayMs = 200; ; delayMs = Math.min(delayMs * 2, 2000)) {
          if (lookupDeadline.remaining() <= 0) return undefined;
          const hit = await lookUpOnce(lookupDeadline).catch(() => undefined);

          if (hit) return hit;

          const left = lookupDeadline.remaining();

          if (left <= 0) return undefined;
          await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, left)));
        }
      };

      let made: BuddySnapshot | undefined;
      let cause: string | undefined;

      try {
        const response = await http.request({
          method: "POST",
          ...sandboxPath(id, "/snapshots"),
          body: { name: snapshotName },
          timeoutMs: 120_000,
        });

        let answer: BuddySnapshot | undefined;

        try {
          const text = await response.text();
          const raw: JsonValue = JSON.parse(text);

          answer = parseSnapshot(raw);
        } catch (error) {
          cause = error instanceof SandboxError ? error.message : undefined;
        }

        made = answer?.name === snapshotName ? answer : await lookUp();
      } catch (error) {
        if (!neverSent(error) && isUnknown(error)) {
          cause = error instanceof SandboxError ? error.message : undefined;
          made = await lookUp();
        } else {
          throw error;
        }
      }

      if (!made)
        throw fail(
          `the snapshot save was not confirmed; it may exist as ${snapshotName}`,
          "outcome_unknown",
          { sandboxId: id, cause },
        );

      const snapshotId = made.id;
      const deadline = createDeadline(600_000);
      let transientMisses = 0;

      for (let status = made.status; status !== "CREATED";) {
        if (status === "FAILED" || status === "DELETING")
          throw fail(`the snapshot ${snapshotId} failed`, "provider", { sandboxId: id });

        try {
          await sleep(500, deadline, name);
          status = parseSnapshot(
            await http.json({
              method: "GET",
              path: "/sandboxes/{id}/snapshots/{snapshot}",
              params: { id, snapshot: snapshotId },
              sandboxId: id,
              deadline,
            }),
          ).status;
          transientMisses = 0;
        } catch (error) {
          // Buddy can briefly return 404 right after snapshot creation; retry a few times before
          // reporting outcome_unknown with the accepted snapshot's ID and name.
          if (isGone(error) && transientMisses < 5 && deadline.remaining() > 0) {
            transientMisses++;
            continue;
          }

          throw fail(
            `the snapshot ${snapshotId} (${snapshotName}) did not confirm completion; check or delete it before retrying`,
            "outcome_unknown",
            { sandboxId: id, cause: error instanceof SandboxError ? error.message : undefined },
          );
        }
      }

      return { id: snapshotId };
    },

    async deleteSnapshot(snapshotId) {
      try {
        await http.request({
          method: "DELETE",
          path: "/sandboxes/snapshots/{snapshot}",
          params: { snapshot: snapshotId },
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
