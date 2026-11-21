/** Groundbox (https://groundbox.dev) through its REST API. No other package to install.
 * Sources, retrieved 2026-11-20:
 * https://groundbox.dev/openapi.json, https://groundbox.dev/docs/api.md,
 * https://groundbox.dev/docs/sandboxes.md, https://groundbox.dev/docs/templates.md and
 * @groundbox/sdk 0.4.2 (the official TypeScript client, which calls the same routes).
 */
import { randomUUID } from "node:crypto";
import { SandboxError, type ErrorCode } from "../../errors.js";
import { createDeadline, sleep, type Deadline } from "../../http.js";
import {
  createNativeApi,
  sdkCall,
  sdkConstruct,
  type NativeApi,
  type NativeSdkBinding,
} from "../../native.js";
import type {
  CreateInput,
  ExecInput,
  ExecResult,
  Labels,
  Preview,
  Provider,
  TemplateSpec,
} from "../../provider.js";
import type { JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { userAgent } from "../../version.js";
import {
  createGroundboxClient,
  ended,
  field,
  keyLabel,
  parseBuild,
  parseCommands,
  parseEntries,
  parseEntry,
  parseExec,
  parseLogs,
  parsePreview,
  parseSandbox,
  parseSandboxPage,
  parseSnapshot,
  parseTemplate,
  pending,
  toInfo,
  type GroundboxPlane,
  type Sandbox,
} from "./api.js";
import { answered, createError, fail, type CreateStage } from "./errors.js";
import { hasWebSocket, streamExec, streamTerminal, type Dial, type StreamStart } from "./stream.js";

export type GroundboxCapability =
  | "pause"
  | "snapshot"
  | "snapshot-delete"
  | "templates"
  | "terminal"
  | "network-policy"
  | "size";

export interface GroundboxOptions {
  /** Defaults to GROUNDBOX_API_KEY. A `gbx_...` key with `sandboxes:write` (and `templates:write` for `buildTemplate`). */
  apiKey?: string;
  /** The API's base, ending in `/v1`. Default: GROUNDBOX_API_URL, else https://api.groundbox.dev/v1. */
  baseUrl?: string;
  /** Template for new sandboxes: an ID (`tpl_...`), a name or `name:version`. Default: the team's default template, else Groundbox's Ubuntu 24.04 image. */
  template?: string;
  /** A Docker image for new sandboxes instead of a template, such as `node:22-bookworm`. The first sandbox from an image waits while it becomes a disk. */
  image?: string;
  /** Previews anyone can open, with no token. Default: private previews, opened with the `x-groundbox-preview-token` header `previewUrl` returns. */
  publicPreviews?: boolean;
  /** Deadline for each API request. Default: 60 seconds. */
  requestTimeoutMs?: number;
  /** Deadline for a create to reach `running`, and for pause, resume and snapshot. Default: 10 minutes. */
  operationTimeoutMs?: number;
}

/** The structural shape of `@groundbox/sdk` that `native.sdk()` needs. */
export interface GroundboxSdkModule {
  Groundbox: new (options: { apiKey?: string; baseUrl?: string }) => {
    sandbox(id: string): object;
  };
}

/** `box.native.sdk(() => import("@groundbox/sdk"))`: the client, and its handle on this sandbox. */
export type GroundboxSandboxSdk = <M extends GroundboxSdkModule>(
  load: () => Promise<M>,
) => Promise<{
  client: InstanceType<M["Groundbox"]>;
  sandbox: ReturnType<InstanceType<M["Groundbox"]>["sandbox"]>;
}>;

/** `provider.api.sdk(() => import("@groundbox/sdk"))`: the `Groundbox` client. */
export type GroundboxClientSdk = <M extends GroundboxSdkModule>(
  load: () => Promise<M>,
) => Promise<InstanceType<M["Groundbox"]>>;

/**
 * `box.native`: Groundbox's API with this adapter's base URL, key, retries and redaction. Its one
 * plane is `"api"`, and `{id}` in a path fills from the sandbox: `box.native.request("GET", "/sandboxes/{id}/usage")`.
 */
export type GroundboxNative = NativeApi<GroundboxPlane, GroundboxSandboxSdk>;

/** Groundbox-only features on `box.ext.groundbox`. */
export type GroundboxExtension = {
  /** Copy the running sandbox, memory, files and processes, into a new one. Resolves with the new sandbox's ID; connect to it with `connectSandbox`. */
  fork(): Promise<{ id: string }>;
};

export type GroundboxProvider = Provider<
  GroundboxNative,
  GroundboxCapability,
  { groundbox: GroundboxExtension }
> & {
  /** Groundbox's API with no sandbox bound, for account calls such as `GET /snapshots`. */
  readonly api: NativeApi<GroundboxPlane, GroundboxClientSdk>;
};

const name = "groundbox";
const defaultBaseUrl = "https://api.groundbox.dev/v1";

/** 2 GiB per vCPU, Groundbox's default ratio; memory up to 4 GiB per vCPU is included in the price. */
const presets = {
  small: { cpus: 2, memory_gb: 4 },
  medium: { cpus: 4, memory_gb: 8 },
  large: { cpus: 8, memory_gb: 16 },
} as const;

/** `POST /v1/sandboxes/{id}/exec` takes at most 512 KiB of stdin and waits at most an hour. */
const inlineStdinBytes = 512 * 1024;
const maxExecSeconds = 3600;

/** Groundbox's file routes take files up to 100 MB. */
const maxFileBytes = 100 * 1024 * 1024 + 1;

/** Run once at create: `/workspace` for the exec user, the SDK's tmp dir, and the tools the core needs. */
const setupCommand = [
  "set -e",
  "if [ ! -d /workspace ]; then mkdir -p /workspace 2>/dev/null || sudo -n mkdir -p /workspace; fi",
  'if [ ! -w /workspace ]; then sudo -n chown "$(id -u):$(id -g)" /workspace; fi',
  "mkdir -p /tmp/.sandbox-sdk",
  "for tool in python3 git tar nohup setsid; do command -v $tool >/dev/null; done",
].join("\n");

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** `POST /v1/sandboxes`. */
interface CreateBody {
  cpus?: number;
  memory_gb?: number;
  disk_gb?: number;
  timeout_minutes?: number;
  idle_timeout_seconds?: number;
  env?: Record<string, string>;
  metadata: Labels;
  allow_hosts?: string[];
  template?: string;
  image?: string;
  snapshot_id?: string;
}

/** `POST /v1/sandboxes/{id}/exec`: a line for `sh -c`. */
interface ExecBody {
  cmd: string;
  cwd: string;
  env: Record<string, string>;
  timeout_s: number;
  stdin?: string;
}

/** `POST /v1/templates` (with `name`) and `POST /v1/templates/{id}/builds`. */
interface TemplateBody {
  run: string[];
  image?: string;
  cpus?: number;
  memory_gb?: number;
}

function quote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function absolute(path: string) {
  if (!path.startsWith("/")) throw fail(`path must be absolute: ${path}`, "invalid_argument");

  return path;
}

/** Whole vCPUs and whole GiB; anything else is refused, never rounded. */
function sizeOf(size: CreateInput["size"]): Pick<CreateBody, "cpus" | "memory_gb" | "disk_gb"> {
  if (size === undefined) return {};

  if (isString(size)) return presets[size];

  if (!Number.isInteger(size.cpu) || size.memoryMb % 1024 !== 0)
    throw fail(
      "sizes are whole vCPUs and whole GiB of memory (memoryMb a multiple of 1024)",
      "unsupported",
    );

  const body: Pick<CreateBody, "cpus" | "memory_gb" | "disk_gb"> = {
    cpus: size.cpu,
    memory_gb: size.memoryMb / 1024,
  };

  if (size.diskGb !== undefined) {
    if (!Number.isInteger(size.diskGb)) throw fail("diskGb must be a whole number", "unsupported");
    body.disk_gb = size.diskGb;
  }

  return body;
}

/** The lifetime in whole minutes, at least one. */
function lifetimeMinutes(ms: number) {
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** The idle pause in whole seconds; Groundbox takes 30 seconds or more. */
function idleSeconds(ms: number) {
  const seconds = Math.ceil(ms / 1000);

  if (seconds < 30) throw fail("idleTimeoutMs must be at least 30 seconds", "unsupported");

  return seconds;
}

function allowList(network: CreateInput["network"]): string[] | undefined {
  if (network === undefined || network === "all") return undefined;

  if (network === "none") return [];

  return [...network.allow];
}

/** Groundbox through its REST API. Each sandbox is a Linux VM of its own. */
export function createGroundboxProvider(options: GroundboxOptions = {}): GroundboxProvider {
  const baseUrl = (options.baseUrl ?? process.env.GROUNDBOX_API_URL ?? defaultBaseUrl).replace(
    /\/+$/,
    "",
  );

  const operationTimeoutMs = options.operationTimeoutMs ?? 600_000;
  const previews = new Map<string, Preview>();

  function apiKey() {
    const key = options.apiKey ?? process.env.GROUNDBOX_API_KEY;

    if (!key?.trim())
      throw fail("no API key; set GROUNDBOX_API_KEY or pass apiKey", "auth", { retryable: false });

    return key.trim();
  }

  const http = createGroundboxClient({
    apiKey,
    baseUrl,
    requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
  });

  interface Call {
    method: Method;
    path: string;
    sandboxId?: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    idempotent?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    deadline?: Deadline;
  }

  function json(call: Call): Promise<JsonValue | undefined> {
    return http.json({
      method: call.method,
      path: call.path,
      sandboxId: call.sandboxId,
      params: call.path.includes("{id}") && call.sandboxId ? { id: call.sandboxId } : undefined,
      query: call.query,
      body: call.body,
      idempotencyKey: call.idempotent ? randomUUID() : undefined,
      signal: call.signal,
      timeoutMs: call.timeoutMs,
      deadline: call.deadline,
    });
  }

  async function getSandbox(id: string, deadline?: Deadline): Promise<Sandbox> {
    return parseSandbox(
      await json({ method: "GET", path: "/sandboxes/{id}", sandboxId: id, deadline }),
    );
  }

  /** Polls until the sandbox has left queued, starting, resuming and pausing. */
  async function settle(first: Sandbox, deadline: Deadline): Promise<Sandbox> {
    let sandbox = first;

    while (pending.has(sandbox.status)) {
      if (deadline.remaining() === 0)
        throw fail(`sandbox is still ${sandbox.status}`, "timeout", {
          sandboxId: sandbox.id,
          retryable: true,
        });
      await sleep(500, deadline, name);
      sandbox = await getSandbox(sandbox.id, deadline);
    }

    return sandbox;
  }

  async function listSandboxes(labels: Labels): Promise<Sandbox[]> {
    const sandboxes: Sandbox[] = [];
    let cursor: string | null = null;

    const filter = Object.fromEntries(
      Object.entries(labels).map(([key, value]) => [`metadata[${key}]`, value]),
    );

    do {
      const page = parseSandboxPage(
        await json({
          method: "GET",
          path: "/sandboxes",
          query: { live: true, limit: 200, cursor: cursor ?? undefined, ...filter },
        }),
      );

      sandboxes.push(...page.sandboxes);
      cursor = page.nextCursor;
    } while (cursor);

    // Match exactly, in case the server's filter is looser than equality.
    return sandboxes.filter(
      (sandbox) =>
        !ended.has(sandbox.status) &&
        Object.entries(labels).every(([key, value]) => sandbox.metadata[key] === value),
    );
  }

  /**
   * Ends a command whose request was abandoned. Groundbox runs `POST .../exec` under its supervisor,
   * which can outlive the request, so the command is found by the marker on its first line and
   * killed, with everything it started.
   */
  async function killMarked(id: string, marker: string) {
    const until = Date.now() + 3000;

    for (;;) {
      let found: { id: string; cmd: string }[] = [];

      try {
        const listed = await http.cleanup({
          method: "GET",
          path: "/sandboxes/{id}/commands",
          params: { id },
          sandboxId: id,
          query: { state: "running", limit: 500 },
        });

        found = parseCommands(listed.json()).filter((command) => command.cmd.startsWith(marker));
      } catch {
        return;
      }

      for (const command of found)
        await http
          .cleanup({
            method: "POST",
            path: "/sandboxes/{id}/commands/{exec}/kill",
            params: { id, exec: command.id },
            sandboxId: id,
            body: {},
          })
          .catch(() => undefined);

      if (found.length > 0 || Date.now() > until) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Runs one command through `POST .../exec` and hands its output over once it has ended. */
  async function execBuffered(
    id: string,
    command: string,
    input: Pick<ExecInput, "cwd" | "env" | "stdin" | "signal" | "onChunk"> & { timeoutMs: number },
  ): Promise<ExecResult> {
    const marker = `# sandbox-sdk ${randomUUID()}`;

    const body: ExecBody = {
      cmd: `${marker}\n${command}`,
      cwd: input.cwd,
      env: input.env,
      // The guest's own limit backs up the client deadline, which aborts first.
      timeout_s: Math.min(maxExecSeconds, Math.ceil(input.timeoutMs / 1000) + 1),
    };

    if (input.stdin !== undefined) body.stdin = input.stdin;

    let raw: JsonValue | undefined;

    try {
      raw = await http.json({
        method: "POST",
        path: "/sandboxes/{id}/exec",
        params: { id },
        sandboxId: id,
        body,
        signal: input.signal,
        timeoutMs: input.timeoutMs + 30_000,
      });
    } catch (error) {
      if (input.signal?.aborted) {
        await killMarked(id, marker);

        return { exitCode: null, timedOut: true };
      }

      throw error;
    }

    const answer = parseExec(raw, id);

    if (answer.timedOut) return { exitCode: null, timedOut: true };

    if (answer.stdout) input.onChunk({ stream: "stdout", text: answer.stdout });

    if (answer.stderr) input.onChunk({ stream: "stderr", text: answer.stderr });

    return { exitCode: answer.exitCode, timedOut: false };
  }

  function dial(id: string, path = "/sandboxes/{id}/exec/stream"): Dial {
    return {
      url: `${baseUrl.replace(/^http/, "ws")}${path.replace("{id}", encodeURIComponent(id))}`,
      headers: { Authorization: `Bearer ${apiKey()}`, "User-Agent": userAgent },
      sandboxId: id,
    };
  }

  /** A short helper command; fails on an exit code not in `allowed`. */
  async function guest(id: string, command: string, deadline?: Deadline) {
    let stderr = "";

    const result = await execBuffered(id, command, {
      cwd: "/",
      env: {},
      timeoutMs: Math.min(60_000, deadline?.remaining() ?? 60_000),
      signal: deadline?.signal,
      onChunk(chunk) {
        if (chunk.stream === "stderr") stderr += chunk.text;
      },
    });

    if (result.timedOut) throw fail("a setup command timed out", "timeout", { sandboxId: id });

    if (result.exitCode !== 0)
      throw fail(
        `the sandbox setup failed (exit ${result.exitCode}): ${stderr.trim().slice(0, 300)}`,
        "unsupported",
        { sandboxId: id },
      );
  }

  async function destroy(id: string) {
    try {
      await json({ method: "DELETE", path: "/sandboxes/{id}", sandboxId: id });
    } catch (error) {
      if (error instanceof SandboxError && error.code === "not_found") return;
      throw error;
    } finally {
      for (const key of previews.keys()) if (key.startsWith(`${id}:`)) previews.delete(key);
    }
  }

  /** After this call admitted sandbox `id`: delete it, and report the failure with its evidence. */
  async function abandon(id: string, stage: CreateStage, cause: unknown): Promise<never> {
    let cleanupCode: ErrorCode | undefined;

    try {
      await destroy(id);
    } catch (cleanup) {
      cleanupCode = cleanup instanceof SandboxError ? cleanup.code : "provider";
    }

    throw createError(cause, { sandboxId: id, stage, cleanupCode });
  }

  async function lifecycle(id: string, action: "pause" | "resume" | "start") {
    const deadline = createDeadline(operationTimeoutMs);

    const sandbox = parseSandbox(
      await json({
        method: "POST",
        path: `/sandboxes/{id}/${action}`,
        sandboxId: id,
        // A command, a file or a preview wakes a sandbox paused here, as after an idle pause.
        body: action === "pause" ? { wake_on_request: true } : undefined,
        deadline,
      }),
    );

    const settled = await settle(sandbox, deadline);
    const want = action === "pause" ? "paused" : "running";

    if (settled.status !== want)
      throw fail(`${action} left the sandbox ${settled.status}`, "provider", { sandboxId: id });
  }

  async function buildTemplate(
    spec: TemplateSpec,
    settings: { timeoutMs?: number; signal?: AbortSignal; onLog?(line: string): void },
  ) {
    const deadline = createDeadline(settings.timeoutMs ?? 30 * 60_000, settings.signal);

    // Build-only env and workdir go in front of each step; Groundbox's own `env` would reach every sandbox.
    const prefix = [
      ...Object.entries(spec.env ?? {}).map(([key, value]) => `export ${key}=${quote(value)}`),
      ...(spec.workdir ? [`mkdir -p ${quote(spec.workdir)}`, `cd ${quote(spec.workdir)}`] : []),
    ];

    const run = (spec.run ?? []).map((step) =>
      prefix.length ? `${prefix.join("; ")}; ${step}` : step,
    );

    const build: TemplateBody = { run };

    if (spec.image) build.image = spec.image;

    if (spec.size) {
      build.cpus = spec.size.cpu;
      build.memory_gb = Math.ceil(spec.size.memoryMb / 1024);
    }

    let template;
    let version: number;

    try {
      template = parseTemplate(
        await json({
          method: "POST",
          path: "/templates",
          body: { name: spec.name, ...build },
          idempotent: true,
          deadline,
        }),
      );
      version = template.build?.version ?? 1;
    } catch (error) {
      // The name is taken: build a new version of that template.
      if (!(error instanceof SandboxError && answered(error, { status: 409 }))) throw error;
      const path = `/templates/${encodeURIComponent(spec.name)}`;
      template = parseTemplate(await json({ method: "GET", path, deadline }));
      version = parseBuild(
        await json({
          method: "POST",
          path: `${path}/builds`,
          body: build,
          idempotent: true,
          deadline,
        }),
      ).version;
    }

    let after = -1;

    for (;;) {
      const page = parseLogs(
        await json({
          method: "GET",
          path: `/templates/${encodeURIComponent(template.id)}/builds/${version}/logs`,
          query: {
            after,
            wait_s: Math.max(0, Math.min(25, Math.floor(deadline.remaining() / 1000) - 5)),
          },
          deadline,
        }),
      );

      for (const line of page.lines) settings.onLog?.(line);
      after = page.next;

      if (page.done) {
        if (page.status !== "ready")
          throw fail(
            `template ${template.name} version ${version} ended ${page.status}`,
            "provider",
          );

        return { id: template.id, name: template.name, buildId: String(version) };
      }

      if (deadline.remaining() === 0)
        throw fail(`template ${template.name} version ${version} is still building`, "timeout", {
          retryable: true,
        });
    }
  }

  // `native.sdk()` builds the caller's own Groundbox client against the same base URL and key.
  const binding: NativeSdkBinding = {
    package: "@groundbox/sdk",
    connect(module, sandboxId) {
      const client = sdkConstruct(
        module,
        "Groundbox",
        [{ apiKey: apiKey(), baseUrl }],
        "@groundbox/sdk",
      );

      if (sandboxId === undefined) return client;

      return sdkCall(client, "sandbox", [sandboxId], "@groundbox/sdk").then((sandbox) => ({
        client,
        sandbox,
      }));
    },
  };

  const provider: GroundboxProvider = {
    name,
    keyMode: "best-effort",
    capabilities: new Set<GroundboxCapability>([
      "pause",
      "snapshot",
      "snapshot-delete",
      "templates",
      "terminal",
      "network-policy",
      "size",
    ]),

    async create(input) {
      const labels: Labels = { ...input.labels };

      if (input.key !== undefined) labels[keyLabel] = input.key;

      // Groundbox metadata: names of 1 to 64 characters, values of at most 512.
      for (const [label, value] of Object.entries(labels))
        if (label.length < 1 || label.length > 64 || value.length > 512)
          throw fail(
            "label names take 1 to 64 characters and values at most 512 (the key is a label too)",
            "unsupported",
          );
      const fromSnapshot = input.from?.startsWith("snap_") ? input.from : undefined;
      const template = fromSnapshot ? undefined : (input.from ?? options.template);

      const body: CreateBody = {
        // A snapshot keeps its own size; Groundbox refuses another one.
        ...sizeOf(input.size),
        metadata: labels,
      };

      if (fromSnapshot) body.snapshot_id = fromSnapshot;
      else if (template) body.template = template;
      else if (options.image) body.image = options.image;

      if (input.timeoutMs !== undefined) body.timeout_minutes = lifetimeMinutes(input.timeoutMs);

      if (input.idleTimeoutMs !== undefined)
        body.idle_timeout_seconds = idleSeconds(input.idleTimeoutMs);

      // Every command gets the sandbox's env, so a fresh connect can read the secrets' names back.
      if (input.env && Object.keys(input.env).length > 0) body.env = input.env;
      const allow = allowList(input.network);

      if (allow !== undefined) body.allow_hosts = allow;

      // The admission request ignores the caller's signal: aborting it mid-flight could leave a
      // sandbox whose ID never arrived. An abort is honoured once the ID is known, by deleting it.
      const admitted = parseSandbox(
        await json({ method: "POST", path: "/sandboxes", body, idempotent: true }),
      );

      const id = admitted.id;
      let stage: CreateStage = "start";
      const aborted = () => fail("create aborted", "aborted", { sandboxId: id });

      try {
        const deadline = createDeadline(operationTimeoutMs, input.signal);
        const sandbox = await settle(admitted, deadline);

        if (input.signal?.aborted) throw aborted();

        if (sandbox.status !== "running")
          throw fail(`the sandbox ended ${sandbox.status} before it ran`, "provider", {
            sandboxId: id,
          });
        stage = "prepare";
        await guest(id, setupCommand, deadline);

        if (input.signal?.aborted) throw aborted();
        stage = "read";

        return toInfo(sandbox);
      } catch (error) {
        return abandon(
          id,
          stage,
          input.signal?.aborted && !(error instanceof SandboxError && error.code === "aborted")
            ? aborted()
            : error,
        );
      }
    },

    async find(key) {
      const [first] = await listSandboxes({ [keyLabel]: key });

      return first ? toInfo(first) : undefined;
    },

    async connect(id) {
      const sandbox = await getSandbox(id);

      if (ended.has(sandbox.status))
        throw fail(`sandbox ${id} is ${sandbox.status}`, "not_found", { sandboxId: id });

      return toInfo(sandbox);
    },

    async list(labels) {
      return (await listSandboxes(labels)).map(toInfo);
    },

    destroy,

    async exec(id, input) {
      if (input.timeoutMs > maxExecSeconds * 1000)
        throw fail(
          "a command runs for at most an hour; use box.start for longer work",
          "unsupported",
          {
            sandboxId: id,
          },
        );

      // Live chunks in arrival order over the exec stream; a buffered call costs one request.
      if (input.streaming === true && hasWebSocket()) {
        const start: StreamStart = {
          cmd: input.command,
          cwd: input.cwd,
          env: input.env,
          timeout_s: Math.min(maxExecSeconds, Math.ceil(input.timeoutMs / 1000) + 1),
        };

        return streamExec(dial(id), start, input);
      }

      const stdin = input.stdin === undefined ? undefined : new TextEncoder().encode(input.stdin);

      if (stdin === undefined || stdin.byteLength <= inlineStdinBytes)
        return execBuffered(id, input.command, input);

      // Larger stdin goes up as a file the command reads and deletes first.
      const staged = `/tmp/.sandbox-sdk/stdin-${randomUUID()}`;
      const started = Date.now();

      await http.request({
        method: "PUT",
        path: "/sandboxes/{id}/files",
        params: { id },
        sandboxId: id,
        query: { path: staged },
        body: stdin,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
      });

      return execBuffered(id, `exec < ${quote(staged)}; rm -f ${quote(staged)}\n${input.command}`, {
        ...input,
        stdin: undefined,
        timeoutMs: Math.max(1, input.timeoutMs - (Date.now() - started)),
      });
    },

    files: {
      writeCreatesParents: true,

      async read(id, path) {
        const response = await http.request({
          method: "GET",
          path: "/sandboxes/{id}/files",
          params: { id },
          sandboxId: id,
          query: { path: absolute(path) },
          timeoutMs: 300_000,
          maxBytes: maxFileBytes,
        });

        return new Uint8Array(response.body);
      },

      async write(id, path, data) {
        await http.request({
          method: "PUT",
          path: "/sandboxes/{id}/files",
          params: { id },
          sandboxId: id,
          query: { path: absolute(path) },
          body: data,
          timeoutMs: 300_000,
        });
      },

      async list(id, path) {
        return parseEntries(
          await json({
            method: "GET",
            path: "/sandboxes/{id}/files",
            sandboxId: id,
            query: { dir: absolute(path) },
          }),
          id,
        );
      },

      async stat(id, path) {
        return parseEntry(
          await json({
            method: "GET",
            path: "/sandboxes/{id}/files/stat",
            sandboxId: id,
            query: { path: absolute(path) },
          }),
          id,
        );
      },

      async remove(id, path, removeOptions) {
        const answer = await json({
          method: "DELETE",
          path: "/sandboxes/{id}/files",
          sandboxId: id,
          query: { path: absolute(path), recursive: removeOptions.recursive ? "true" : undefined },
        });

        if (field(answer, "deleted") === false)
          throw fail(`no such file: ${path}`, "file_not_found", { sandboxId: id });
      },

      async mkdir(id, path) {
        await json({
          method: "POST",
          path: "/sandboxes/{id}/files/mkdir",
          sandboxId: id,
          query: { path: absolute(path) },
        });
      },
    },

    async previewUrl(id, port) {
      const key = `${id}:${port}`;
      const cached = previews.get(key);

      // A share token works for 24 hours; ask for a fresh one when less than an hour is left.
      if (cached && (cached.expiresAt === undefined || cached.expiresAt - Date.now() > 3_600_000))
        return cached;

      const answer = parsePreview(
        await json({
          method: "POST",
          path: "/sandboxes/{id}/previews",
          sandboxId: id,
          body: options.publicPreviews ? { port, public: true } : { port },
        }),
        id,
      );

      const preview: Preview = { url: answer.url };

      // A private preview opens with its share token in a header, until the token expires.
      if (answer.token) {
        preview.headers = { "x-groundbox-preview-token": answer.token };

        if (answer.expiresAt !== undefined) preview.expiresAt = answer.expiresAt;
      }

      previews.set(key, preview);

      return preview;
    },

    native: (id) =>
      createNativeApi<GroundboxPlane, GroundboxSandboxSdk>({
        http,
        placeholder: "id",
        sandboxId: id,
        sdk: binding,
      }),

    api: createNativeApi<GroundboxPlane, GroundboxClientSdk>({
      http,
      placeholder: "id",
      sdk: binding,
    }),

    async usage(id) {
      const [sandbox, usage] = await Promise.all([
        getSandbox(id),
        json({ method: "GET", path: "/sandboxes/{id}/usage", sandboxId: id }).catch(
          () => undefined,
        ),
      ]);

      const cost = field(usage, "cost_micros");

      const sample = {
        cpuCount: sandbox.cpus,
        memoryLimitBytes: sandbox.memoryGb * 1024 ** 3,
        diskLimitBytes: sandbox.diskGb * 1024 ** 3,
      };

      // Compute plus paused storage so far, from Groundbox's own meter.
      return isNumber(cost) ? { ...sample, costUsd: cost / 1_000_000 } : sample;
    },

    async pause(id) {
      await lifecycle(id, "pause");
    },

    async resume(id) {
      const sandbox = await getSandbox(id);

      if (sandbox.status === "running") return;

      // A sandbox shut down with its disk kept boots again with start; a paused one resumes.
      await lifecycle(id, sandbox.status === "shut_down" ? "start" : "resume");
    },

    async snapshot(id, snapshotOptions) {
      if (snapshotOptions?.expiresInMs)
        throw fail(
          "snapshots are kept until deleted (or 30 days unused); omit expiresInMs",
          "unsupported",
          { sandboxId: id },
        );

      const deadline = createDeadline(operationTimeoutMs);

      let snapshot = parseSnapshot(
        await json({
          method: "POST",
          path: "/snapshots",
          sandboxId: id,
          body: { sandbox_id: id },
          idempotent: true,
          deadline,
        }),
      );

      while (snapshot.status === "creating") {
        await sleep(500, deadline, name);
        snapshot = parseSnapshot(
          await json({
            method: "GET",
            path: `/snapshots/${encodeURIComponent(snapshot.id)}`,
            sandboxId: id,
            deadline,
          }),
        );
      }

      if (snapshot.status !== "ready")
        throw fail(`snapshot ${snapshot.id} ended ${snapshot.status}`, "provider", {
          sandboxId: id,
        });

      return { id: snapshot.id };
    },

    async deleteSnapshot(snapshotId) {
      const path = `/snapshots/${encodeURIComponent(snapshotId)}`;

      try {
        // Deleting a deleted snapshot answers 200 again, so read it first to tell the two apart.
        if (parseSnapshot(await json({ method: "GET", path })).status === "deleted") return false;
        await json({ method: "DELETE", path });

        return true;
      } catch (error) {
        if (error instanceof SandboxError && error.code === "not_found") return false;
        throw error;
      }
    },

    buildTemplate,

    async terminal(id, settings) {
      return streamTerminal(dial(id), {
        cmd: "exec bash -l",
        cwd: settings.cwd,
        env: settings.env,
        timeout_s: maxExecSeconds,
        rows: settings.rows,
        cols: settings.cols,
      });
    },

    extensions: {
      groundbox: (id) => ({
        async fork() {
          // The copy keeps the source's labels, so the SDK lists it, but not its key.
          const { [keyLabel]: _key, ...metadata } = (await getSandbox(id)).metadata;

          const forked = parseSandbox(
            await json({
              method: "POST",
              path: "/sandboxes/{id}/fork",
              sandboxId: id,
              body: { metadata },
              idempotent: true,
              timeoutMs: operationTimeoutMs,
            }),
          );

          return { id: forked.id };
        },
      }),
    },
  };

  return provider;
}
