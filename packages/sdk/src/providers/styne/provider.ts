/**
 * Styne (https://styne.ai) through its REST API, with `fetch` and no other package. Sources, retrieved
 * 2026-11-23: https://docs.styne.ai (sandboxes, exec, files, ports, pause-tiers, snapshots, errors,
 * limits, billing, regions) and https://api.styne.ai/openapi.json. Every behaviour the adapter leans on
 * was checked against the live API the same day; the provider page lists what was found.
 */
import { randomUUID } from "node:crypto";
import { SandboxError, type ErrorCode } from "../../errors.js";
import { createHttpClient, httpStatus, neverSent, type Fetch } from "../../http.js";
import { createNativeApi, type NativeApi } from "../../native.js";
import type {
  CreateInput,
  ExecInput,
  ExecResult,
  Labels,
  Provider,
  ProviderFiles,
} from "../../provider.js";
import { files as guestFiles, type Guest } from "../../shared/guest.js";
import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isString } from "../../shared/narrow.js";
import { ndjson } from "../../streams.js";
import {
  keyLabel,
  parseConnection,
  parseExecFrame,
  parseMetrics,
  parseSandbox,
  parseSandboxList,
  parseSnapshot,
  toInfo,
  type Connection,
  type StyneSandbox,
} from "./api.js";
import { codeOf, fail, mapError, provider as name } from "./errors.js";

/** Styne has one API surface, `https://api.styne.ai`. */
export type StynePlane = "api";

export type StyneCapability = "pause" | "snapshot" | "snapshot-delete" | "network-policy" | "size";

export interface StyneOptions {
  /** Defaults to STYNE_API_KEY. */
  apiKey?: string;
  /** Default: STYNE_API_URL, else https://api.styne.ai. */
  baseUrl?: string;
  /**
   * Template for new sandboxes, from `GET /templates`. Default: `base` (4 vCPU, 8 GiB, 51 GiB disk).
   * A template other than `base` or `default` owns its size, so `size` is refused with it.
   */
  template?: string;
  /** `ash` (US East) or `ams`, which Styne serves in Ashburn for now. Default: Styne's, `ash`. */
  region?: string;
  /**
   * Lifetime of a sandbox created without `timeoutMs`, in running time: Styne stops the clock while a
   * sandbox sleeps or is paused. 1 second to 24 hours. Default: 1 hour (Styne's own default is 5 minutes).
   */
  timeoutMs?: number;
  /**
   * Serve every port without the traffic token (`network.allowPublicTraffic`). Default: false, and
   * `preview()` returns the `e2b-traffic-access-token` header the URL needs.
   */
  public?: boolean;
  /** Where `pause()` keeps the sandbox: `memory` (Styne's default), `standby` or `archived`. */
  pauseTier?: "memory" | "standby" | "archived";
  /** Deadline for each control-plane request, retries included. Default: 60 seconds. */
  requestTimeoutMs?: number;
  /** For tests. */
  fetch?: Fetch;
}

/** `box.native`: Styne's API with this adapter's key, `{id}` bound to the sandbox. */
export type StyneNative = NativeApi<StynePlane>;

export type StyneProvider = Provider<StyneNative, StyneCapability> & {
  /** Account-level calls, such as `api.request("GET", "/snapshots")`. */
  readonly api: NativeApi<StynePlane>;
};

/** Styne's sizes (https://docs.styne.ai/limits#sandbox-sizes): vCPU, MiB of memory, GiB of disk. */
const sizes = {
  small: { cpu: 2, memoryMb: 4096, diskGb: 51 },
  default: { cpu: 4, memoryMb: 8192, diskGb: 51 },
  large: { cpu: 8, memoryMb: 16384, diskGb: 111 },
  xlarge: { cpu: 16, memoryMb: 32768, diskGb: 251 },
} as const;

type StyneSize = keyof typeof sizes;

/** The portable presets. `xlarge` is `{ cpu: 16, memoryMb: 32768 }`. */
const presets = { small: "small", medium: "default", large: "large" } as const;

const sizedTemplates: ReadonlySet<string> = new Set(["base", "default"]);

function sizeOf(size: NonNullable<CreateInput["size"]>): StyneSize {
  if (isString(size)) return presets[size];
  const allowed = Object.entries(sizes);

  const match = allowed.find(
    ([, s]) =>
      s.cpu === size.cpu &&
      s.memoryMb === size.memoryMb &&
      (size.diskGb === undefined || size.diskGb === s.diskGb),
  );

  if (!match)
    throw fail(
      `no size has ${size.cpu} vCPU / ${size.memoryMb} MiB${size.diskGb === undefined ? "" : ` / ${size.diskGb} GiB`}. Styne offers ${allowed.map(([n, s]) => `${n} (${s.cpu} vCPU / ${s.memoryMb} MiB / ${s.diskGb} GiB)`).join(", ")}`,
      "unsupported",
    );

  const [found] = match;

  // Object.entries widens the key; the find above only returns keys of `sizes`.
  return found === "small" || found === "large" || found === "xlarge" ? found : "default";
}

/** Whole seconds in `min..max`, rounded up; outside that, `unsupported` naming the option. */
function seconds(ms: number, option: string, max: number) {
  const value = Math.ceil(ms / 1000);

  if (!Number.isFinite(value) || value < 1 || value > max)
    throw fail(`${option} must be between 1 second and ${max} seconds`, "unsupported");

  return value;
}

/** Where every command's process-group record and cancel marker live. */
const execDir = "/tmp/.sandbox-sdk/exec";

/**
 * Every command runs under this wrapper: argv is `cwd command tag`. It records its PID (Styne makes the
 * started process a process-group leader) before it checks for a cancel marker, and a cancel writes the
 * marker before it reads the PID. So a cancel that reaches the guest before the command either stops it
 * from starting or finds its group to kill. A missing cwd is a non-zero exit, like a failed `cd`.
 */
const wrapper = [
  `d=${execDir}; t="$d/$3"`,
  `{ echo $$ > "$t"; } 2>/dev/null || { mkdir -p "$d" && echo $$ > "$t"; }`,
  `if [ -e "$t.cancel" ]; then rm -f "$t" "$t.cancel"; exit 137; fi`,
  `cd -- "$1" || { rm -f "$t"; exit 1; }`,
  `sh -c "$2"; s=$?`,
  `rm -f "$t"`,
  `exit $s`,
].join("\n");

/** Kills a command's process group: argv is `tag pid`, the PID empty when the command never reported one. */
const killer = [
  `d=${execDir}; t="$d/$1"`,
  `{ : > "$t.cancel"; } 2>/dev/null || { mkdir -p "$d" && : > "$t.cancel"; }`,
  `p=$2`,
  `[ -n "$p" ] || read -r p < "$t" 2>/dev/null`,
  // dash, the image's sh, refuses `--` before a negative PID: `kill -KILL -PID` names the group.
  `if [ -n "$p" ]; then kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null; fi`,
  `rm -f "$t"`,
  `exit 0`,
].join("\n");

/**
 * Run once at create, also on a sandbox restored from a snapshot. /workspace is the SDK's working
 * directory. Styne's file API creates new files and folders as `user` (uid 1000) while commands run as
 * root, so git would refuse a repository in a folder the file API made ("dubious ownership").
 */
const setupCommand = [
  "set -e",
  `mkdir -p /workspace ${execDir}`,
  "if command -v git >/dev/null; then git config --system --get-all safe.directory 2>/dev/null | grep -qxF '*' || git config --system --add safe.directory '*'; fi",
  "command -v python3 tar nohup setsid >/dev/null",
].join("; ");

/** Styne's lifetime limit, in seconds (https://docs.styne.ai/limits). */
const maxLifetimeSeconds = 86_400;
const maxIdleSeconds = 3600;
const defaultLifetimeMs = 3_600_000;

/** A command's stdin goes in base64 lines of this many bytes. */
const stdinChunkBytes = 1024 * 1024;

type Body = JsonObject;

export function createStyneProvider(options: StyneOptions = {}): StyneProvider {
  const baseUrl = (options.baseUrl ?? process.env.STYNE_API_URL ?? "https://api.styne.ai").replace(
    /\/+$/,
    "",
  );

  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const connections = new Map<string, Connection>();
  const natives = new Map<string, StyneNative>();

  function apiKey() {
    const key = (options.apiKey ?? process.env.STYNE_API_KEY)?.trim();

    if (!key)
      throw fail(
        "the API key is missing. Authentication is required. Set STYNE_API_KEY or pass apiKey",
        "auth",
      );

    return key;
  }

  const http = createHttpClient<StynePlane>({
    provider: name,
    label: "Styne",
    planes: { api: { baseUrl, auth: () => ({ Authorization: `Bearer ${apiKey()}` }) } },
    defaultPlane: "api",
    fetch: options.fetch,
    timeoutMs: requestTimeoutMs,
    secrets: () => [
      options.apiKey ?? process.env.STYNE_API_KEY,
      ...[...connections.values()].map((c) => c.trafficAccessToken),
    ],
    idempotencyHeader: "Idempotency-Key",
    authHint: "Set STYNE_API_KEY to a valid Styne API key.",
    mapError,
  });

  const api = createNativeApi<StynePlane>({ http, placeholder: "id" });

  const sandboxPath = (id: string, route = "") => ({
    path: `/sandboxes/{id}${route}`,
    params: { id },
    sandboxId: id,
  });

  /** A write that may need a retry carries a key, so Styne applies it once (verified on create). */
  const idempotent = () => ({ idempotencyKey: randomUUID() });

  async function getSandbox(id: string): Promise<StyneSandbox> {
    return parseSandbox(await http.json({ method: "GET", ...sandboxPath(id) }));
  }

  async function listSandboxes(labels: Labels): Promise<StyneSandbox[]> {
    const found: StyneSandbox[] = [];
    const filter = new URLSearchParams(labels).toString();
    let nextToken: string | undefined;

    for (let page = 0; page < 1000; page++) {
      const response = await http.request({
        method: "GET",
        path: "/sandboxes",
        query: { metadata: filter || undefined, limit: 100, nextToken },
      });

      found.push(...parseSandboxList(response.json()));
      nextToken = response.headers.get("x-next-token") ?? undefined;

      if (!nextToken) break;
    }

    // Match exactly, in case the server's filter is looser than equality.
    return found.filter((s) => Object.entries(labels).every(([k, v]) => s.metadata[k] === v));
  }

  /** The traffic token and domain: from the create, or a connect, which GET does not return. */
  async function connection(id: string): Promise<Connection> {
    const known = connections.get(id);

    if (known) return known;

    // A connect resumes a paused sandbox and keeps it alive at least 5 more minutes; a preview needs it running.
    const fresh = parseConnection(
      await http.json({ method: "POST", ...sandboxPath(id, "/connect"), body: {}, readOnly: true }),
    );

    connections.set(id, fresh);

    return fresh;
  }

  async function destroy(id: string) {
    try {
      await http.request({ method: "DELETE", ...sandboxPath(id) });
    } catch (error) {
      // A second delete answers 404, an ended sandbox 410: either way it is gone.
      if (!(error instanceof SandboxError && error.code === "not_found")) throw error;
    } finally {
      connections.delete(id);
      natives.delete(id);
    }
  }

  /** Kills a command's process group in the guest, on a fresh short deadline. Throws when unconfirmed. */
  async function killGroup(id: string, tag: string, pid: number | undefined) {
    const body = {
      argv: ["sh", "-c", killer, "sandbox-sdk", tag, pid === undefined ? "" : String(pid)],
    };

    let last: unknown;

    for (let attempt = 0; attempt < 2; attempt++)
      try {
        await http.cleanup({ method: "POST", ...sandboxPath(id, "/commands"), body });

        return;
      } catch (error) {
        last = error;

        // A sandbox that ended took the command with it.
        if (error instanceof SandboxError && error.code === "not_found") return;
      }

    throw fail(
      "the command was cancelled, but its process group could not be confirmed killed. It may still be running; destroy the sandbox before retrying",
      "outcome_unknown",
      { sandboxId: id, cause: last instanceof SandboxError ? last.message : undefined },
    );
  }

  function execBody(
    input: Pick<ExecInput, "command" | "cwd" | "env" | "stdin" | "timeoutMs">,
    tag: string,
  ) {
    const start: Body = {
      argv: ["sh", "-c", wrapper, "sandbox-sdk", input.cwd, input.command, tag],
      envs: input.env,
      // Styne's own kill, which takes the whole group, backs up the adapter's own deadline.
      timeoutMs: input.timeoutMs + 10_000,
    };

    const lines: Body[] = [start];

    if (input.stdin !== undefined) {
      start.stdin = true;
      const bytes = new TextEncoder().encode(input.stdin);

      for (let offset = 0; offset < bytes.length; offset += stdinChunkBytes)
        lines.push({
          stdin: Buffer.from(bytes.subarray(offset, offset + stdinChunkBytes)).toString("base64"),
        });
      lines.push({ closeStdin: true });
    }

    return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  }

  const timedOut: ExecResult = { exitCode: null, timedOut: true };

  /**
   * One command over `POST /sandboxes/{id}/exec`. Closing that stream does not stop the command (checked
   * live), so a timeout or abort kills the process group in the guest before this settles.
   */
  async function exec(id: string, input: ExecInput): Promise<ExecResult> {
    if (input.signal?.aborted) return timedOut;
    const tag = randomUUID();
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    // Ends the stream's reads once the adapter stops listening. Never the caller's signal: a stream
    // cut before `started` would hide the PID.
    const reading = new AbortController();
    let pid: number | undefined;
    let wake: () => void = () => {};
    const stopped = new Promise<"stop">((resolve) => (wake = () => resolve("stop")));
    let cancelled = false;

    const cancel = () => {
      cancelled = true;
      wake();
    };

    const timer = setTimeout(cancel, input.timeoutMs);
    input.signal?.addEventListener("abort", cancel, { once: true });

    const emit = (stream: "stdout" | "stderr", data?: Uint8Array) => {
      const text = data
        ? decoders[stream].decode(data, { stream: true })
        : decoders[stream].decode();

      if (text) input.onChunk({ stream, text });
    };

    const body = execBody(input, tag);

    /** Opens the stream; a request that never left this process (a refused or failed connect) is sent again. */
    const open = async (): Promise<Response> => {
      for (let attempt = 0; ; attempt++)
        try {
          return await http.stream({
            method: "POST",
            ...sandboxPath(id, "/exec"),
            body,
            headers: { "content-type": "application/json" },
            startupTimeoutMs: requestTimeoutMs,
            signal: reading.signal,
          });
        } catch (error) {
          if (attempt >= 2 || cancelled || !neverSent(error)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
    };

    const opening = open();

    // Rejections are read below or dropped after a cancel.
    opening.catch(() => {});
    let frames: AsyncIterator<JsonValue | undefined> | undefined;

    /** After a confirmed kill: give the stream a moment to report the exit, then let it go. */
    async function release() {
      if (frames) {
        const iterator = frames;
        const deadline = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 1000));

        for (;;) {
          const next = await Promise.race([iterator.next(), deadline]).catch(() => "late" as const);

          if (next === "late" || next.done) break;
          const frame = parseExecFrame(next.value);

          if (frame.kind === "exit") break;
        }
      }

      reading.abort();
    }

    try {
      let opened: Response | "stop";

      try {
        opened = await Promise.race([opening, stopped]);
      } catch (error) {
        // The command may have been sent and started: stop it by its tag before reporting.
        if (error instanceof SandboxError && error.code === "outcome_unknown")
          await killGroup(id, tag, undefined);
        throw error;
      }

      if (opened === "stop") {
        await killGroup(id, tag, undefined);
        reading.abort();

        return timedOut;
      }

      if (!opened.body)
        throw fail("the command stream had no body", "outcome_unknown", { sandboxId: id });
      frames = ndjson(opened.body, { provider: name, sandboxId: id })[Symbol.asyncIterator]();

      for (;;) {
        let next: IteratorResult<JsonValue | undefined> | "stop";

        try {
          next = await Promise.race([frames.next(), stopped]);
        } catch (error) {
          if (cancelled) next = "stop";
          else {
            await killGroup(id, tag, pid).catch(() => {});
            throw fail("the command stream broke before the command finished", "outcome_unknown", {
              sandboxId: id,
              cause: error instanceof SandboxError ? error.message : undefined,
            });
          }
        }

        if (next === "stop") {
          await killGroup(id, tag, pid);
          await release();

          return timedOut;
        }

        if (next.done) {
          if (cancelled) {
            await killGroup(id, tag, pid);

            return timedOut;
          }

          await killGroup(id, tag, pid).catch(() => {});
          throw fail("the command stream ended without an exit", "outcome_unknown", {
            sandboxId: id,
          });
        }

        const frame = parseExecFrame(next.value);

        switch (frame.kind) {
          case "started":
            pid = frame.pid;
            break;
          case "output":
            emit(frame.stream, frame.data);
            break;
          case "exit": {
            emit("stdout");
            emit("stderr");

            // Read the stream to its end, so its connection can serve the next request.
            await drain(frames);

            // Styne's own deadline killed the group; its `command_timeout` line was read above.
            if (frame.timedOut) return timedOut;

            if (frame.exitCode >= 0) return { exitCode: frame.exitCode, timedOut: false };

            return { exitCode: frame.signal > 0 ? 128 + frame.signal : null, timedOut: false };
          }

          case "error": {
            if (frame.code === "command_timeout") return timedOut;
            const mapped = codeOf(frame.code);

            // A sandbox that ended took the command with it; otherwise a started command may still run.
            const code: ErrorCode =
              mapped === "not_found"
                ? mapped
                : pid === undefined
                  ? (mapped ?? "provider")
                  : "outcome_unknown";

            if (code === "outcome_unknown") await killGroup(id, tag, pid).catch(() => {});
            throw fail(`the command stream failed${frame.code ? ` (${frame.code})` : ""}`, code, {
              sandboxId: id,
            });
          }

          case "other":
            break;
          default: {
            const exhaustive: never = frame;
            void exhaustive;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      // A stream read to its end is already released; any other is let go here.
      reading.abort();
    }
  }

  /** Reads a finished stream briefly to its end; gives up after a second. */
  async function drain(frames: AsyncIterator<JsonValue | undefined>) {
    const deadline = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 1000));

    try {
      for (;;) {
        const next = await Promise.race([frames.next(), deadline]);

        if (next === "late" || next.done) break;
      }
    } catch {
      // The exit already arrived; a broken tail changes nothing.
    } finally {
      if (frames.return) void Promise.resolve(frames.return()).catch(() => {});
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
    try {
      const response = await http.request({
        method: "GET",
        ...sandboxPath(id, "/files"),
        query: { path },
        timeoutMs: 300_000,
        maxBytes: 2 ** 32,
      });

      return response.body;
    } catch (error) {
      // A file route's 404 is a missing path, or a sandbox Styne no longer knows; GET tells them apart.
      if (error instanceof SandboxError && error.code === "file_not_found") await getSandbox(id);
      throw error;
    }
  }

  async function writeFile(id: string, path: string, data: Uint8Array) {
    await http.request({
      method: "PUT",
      ...sandboxPath(id, "/files"),
      query: { path },
      // A copy owns a plain ArrayBuffer, which fetch's BodyInit requires.
      body: new Uint8Array(data),
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
    write: async (id, path, data) => {
      await writeFile(id, path, data);
    },
    list: shared.list,
    stat: shared.stat,
    mkdir: shared.mkdir,
    remove: shared.remove,
  };

  /** After this call made sandbox `id`: destroy it and report `cause`, or `outcome_unknown` when the destroy is unconfirmed. */
  async function abandon(id: string, cause: unknown): Promise<never> {
    try {
      await destroy(id);
    } catch {
      throw fail(
        `sandbox ${id} was created but did not finish setting up, and it could not be confirmed destroyed. Destroy it before retrying`,
        "outcome_unknown",
        { sandboxId: id },
      );
    }

    if (cause instanceof SandboxError) throw cause;
    throw fail("the sandbox did not finish setting up", "provider", { sandboxId: id });
  }

  function createBody(input: CreateInput): Body {
    const network = input.network ?? "all";
    const allowList = isString(network) ? undefined : network.allow;

    if (allowList !== undefined && allowList.length > 0)
      throw fail(
        "host allow lists are not enforced: with all outbound traffic denied, Styne's allowOut opens neither hosts nor addresses. Use network 'all' or 'none'",
        "unsupported",
      );
    const none = network === "none" || allowList !== undefined;

    if (input.from !== undefined && input.size !== undefined)
      throw fail("a sandbox from a snapshot has the snapshot's size; omit size", "unsupported");
    const template = options.template ?? "base";

    if (input.from === undefined && input.size !== undefined && !sizedTemplates.has(template))
      throw fail(
        `template ${template} has a fixed size; omit size or use the base template`,
        "unsupported",
      );

    const metadata: Labels = { ...input.labels };

    if (input.key !== undefined) metadata[keyLabel] = input.key;

    const body: Body = {
      metadata,
      timeout: seconds(
        input.timeoutMs ?? options.timeoutMs ?? defaultLifetimeMs,
        "timeoutMs",
        maxLifetimeSeconds,
      ),
    };

    if (input.from !== undefined) body.snapshot = input.from;
    else if (input.size !== undefined) body.size = sizeOf(input.size);
    else body.templateID = template;

    if (input.idleTimeoutMs !== undefined)
      body.idleTimeout = seconds(input.idleTimeoutMs, "idleTimeoutMs", maxIdleSeconds);

    if (input.env !== undefined && Object.keys(input.env).length) body.envVars = input.env;

    if (options.region !== undefined) body.region = options.region;
    const policy: Body = {};

    if (none) {
      body.allow_internet_access = false;
      policy.denyOut = ["0.0.0.0/0"];
    }

    if (options.public) policy.allowPublicTraffic = true;

    if (Object.keys(policy).length) body.network = policy;

    return body;
  }

  const provider: StyneProvider = {
    name,
    keyMode: "best-effort",
    // Every command runs as root in the VM's one PID namespace.
    procActivity: true,
    capabilities: new Set<StyneCapability>([
      "pause",
      "snapshot",
      "snapshot-delete",
      "network-policy",
      "size",
    ]),
    api,

    async create(input) {
      const body = createBody(input);
      const key = idempotent();
      let made: Connection;

      // Not the caller's signal: once sent, the answer names the sandbox to destroy. An abort is
      // honoured after it arrives.
      try {
        made = parseConnection(
          await http.json({ method: "POST", path: "/sandboxes", body, ...key }),
        );
      } catch (error) {
        if (!(error instanceof SandboxError && error.code === "outcome_unknown")) throw error;
        // The same idempotency key returns the sandbox the lost answer named, or makes the one it did not.
        made = parseConnection(
          await http
            .cleanup({ method: "POST", path: "/sandboxes", body, ...key })
            .then((response) => response.json())
            .catch(() => {
              throw error;
            }),
        );
      }

      const id = made.id;
      connections.set(id, made);
      const aborted = () => fail("creation aborted", "aborted", { sandboxId: id });

      try {
        if (input.signal?.aborted) throw aborted();
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
        createdAt: Date.now(),
      };
    },

    async find(key) {
      const [first] = await listSandboxes({ [keyLabel]: key });

      return first ? toInfo(first) : undefined;
    },

    async connect(id) {
      // A read only: a connect would wake a paused sandbox and move its deadline.
      return toInfo(await getSandbox(id));
    },

    async list(labels) {
      return (await listSandboxes(labels)).map(toInfo);
    },

    destroy,

    async close(id) {
      connections.delete(id);
      natives.delete(id);
    },

    exec,
    files,

    async previewUrl(id, port) {
      if (options.public) {
        const domain = connections.get(id)?.domain ?? (await getSandbox(id)).domain;

        if (!domain) throw fail("the sandbox has no preview domain", "provider", { sandboxId: id });

        return { url: `https://${port}-${id}.${domain}` };
      }

      const { domain, trafficAccessToken } = await connection(id);

      if (!trafficAccessToken)
        throw fail("Styne returned no traffic access token for this sandbox", "provider", {
          sandboxId: id,
        });

      return {
        url: `https://${port}-${id}.${domain}`,
        headers: { "e2b-traffic-access-token": trafficAccessToken },
      };
    },

    native(id) {
      let value = natives.get(id);

      if (!value) {
        value = createNativeApi<StynePlane>({ http, placeholder: "id", sandboxId: id });
        natives.set(id, value);
      }

      return value;
    },

    async usage(id) {
      // Metrics are extra: a sandbox that is gone, paused or not yet sampled still reports the core counters.
      return parseMetrics(
        await http.json({ method: "GET", ...sandboxPath(id, "/metrics") }).catch(() => undefined),
      );
    },

    async pause(id) {
      try {
        await http.request({
          method: "POST",
          ...sandboxPath(id, "/pause"),
          body: options.pauseTier ? { tier: options.pauseTier } : {},
          ...idempotent(),
        });
      } catch (error) {
        if (httpStatus(error)?.code !== "already_paused") throw error;
      }
    },

    async resume(id) {
      try {
        connections.set(
          id,
          parseConnection(
            await http.json({
              method: "POST",
              ...sandboxPath(id, "/resume"),
              body: {},
              ...idempotent(),
            }),
          ),
        );
      } catch (error) {
        if (httpStatus(error)?.code !== "already_running") throw error;
      }
    },

    async snapshot(id, snapshotOptions) {
      if (snapshotOptions?.expiresInMs)
        throw fail("snapshots are kept until deleted; omit expiresInMs", "unsupported", {
          sandboxId: id,
        });
      const snapshotName = `sbx-${randomUUID()}`;

      try {
        const saved = parseSnapshot(
          await http.json({
            method: "POST",
            ...sandboxPath(id, "/snapshots"),
            body: { name: snapshotName },
            ...idempotent(),
            timeoutMs: 600_000,
          }),
        );

        return { id: saved.name };
      } catch (error) {
        if (!(error instanceof SandboxError && error.code === "outcome_unknown")) throw error;

        // The name was chosen before the request, so a lost answer can be looked up.
        const found = await http
          .cleanup({
            method: "GET",
            path: "/snapshots/{name}",
            params: { name: snapshotName },
          })
          .then((response) => parseSnapshot(response.json()))
          .catch(() => {
            throw error;
          });

        return { id: found.name };
      }
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
        if (error instanceof SandboxError && error.code === "not_found") return false;
        throw error;
      }
    },
  };

  return provider;
}
