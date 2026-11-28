/**
 * Agent 37 (https://www.agent37.com) cloud sandboxes through its Sandbox API, with `fetch` and no other
 * package. Sources, retrieved 2026-11-28: https://www.agent37.com/docs/llms-full.txt (instances, exec,
 * lifecycle, fork, public ports, signed URLs, billing, errors). Every behaviour the adapter leans on was
 * checked against the live API the same day; the provider page lists what was found.
 *
 * Two planes take the same `sk_live_` workspace key: `control` (`https://api.agent37.com/v1`,
 * `Authorization: Bearer`) creates, reads, sleeps, forks and deletes instances; `exec`
 * (`https://sandbox.agent37.app/v1`, `X-Agent37-Key`) runs commands on the instance's own host.
 */
import { randomUUID } from "node:crypto";
import { SandboxError } from "../../errors.js";
import {
  createDeadline,
  createHttpClient,
  httpStatus,
  neverSent,
  type Fetch,
  type HttpRequest,
} from "../../http.js";
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
import { quote } from "../../shared/shell.js";
import {
  allocLabel,
  coming,
  ending,
  keyLabel,
  leakPatterns,
  parseExec,
  parseInstance,
  parseInstanceAnswer,
  parseInstanceList,
  parsePublicPort,
  parsePublicPorts,
  parseSignedUrl,
  snapshotLabel,
  toInfo,
  tokensIn,
  type Agent37Instance,
  type ExecAnswer,
  type InstanceAnswer,
} from "./api.js";
import { fail, mapError, provider as name } from "./errors.js";
import {
  discardCommand,
  inlineBytes,
  joinCommand,
  killCommand,
  readChunkBytes,
  readCommand,
  trailerPrefix,
  wrappedCommand,
  writeChunkBytes,
  writeCommand,
} from "./exec.js";

/** Agent 37's API surfaces: `control` (`/v1` on the API host) and `exec` (`/v1` on the exec host). */
export type Agent37Plane = "control" | "exec";

export type Agent37Capability =
  | "pause"
  | "snapshot"
  | "snapshot-delete"
  | "network-policy"
  | "size";

export interface Agent37Options {
  /** Defaults to AGENT37_API_KEY. */
  apiKey?: string;
  /** The Sandbox API host. Default: AGENT37_API_URL, else https://api.agent37.com. */
  baseUrl?: string;
  /** The exec host. Default: AGENT37_EXEC_URL, else https://sandbox.agent37.app. */
  execUrl?: string;
  /** The template new sandboxes start from. Default: `agent37-base` (Debian 12 with Node.js, Python 3 and git). */
  template?: string;
  /** Where new sandboxes run: `us` (the default and the only region with `default` instances), `eu` or `ap-south`. */
  region?: "us" | "eu" | "ap-south";
  /** The instance type: `default` (shared CPU), `vm` (2.5x) or `performance` (4x, dedicated cores). Default: `default`. */
  type?: "default" | "vm" | "performance";
  /**
   * Make previewed ports public: each gets a permanent unauthenticated URL with an unguessable slug. Default:
   * false, and `preview()` returns a signed URL that carries an `a37_token` and expires.
   */
  public?: boolean;
  /** How long a signed preview URL lives. Default: 1 hour. */
  previewTtlMs?: number;
  /** Deadline for each control-plane request, retries included. Default: 60 seconds. */
  requestTimeoutMs?: number;
  /** For tests. */
  fetch?: Fetch;
}

/** `box.native`: Agent 37's API with this adapter's key, `{id}` bound to the sandbox. */
export type Agent37Native = NativeApi<Agent37Plane>;

export type Agent37Provider = Provider<Agent37Native, Agent37Capability> & {
  /** Account-level calls, such as `api.request("GET", "/billing")`. */
  readonly api: NativeApi<Agent37Plane>;
};

/** Agent 37's sizes (https://www.agent37.com/docs/agents-api/instance-sizing): vCPU, MiB, and disk range in GB. */
const tiers = [
  { cpu: 2, memoryMb: 4096, disk: [2, 12] },
  { cpu: 4, memoryMb: 8192, disk: [2, 20] },
  { cpu: 4, memoryMb: 16384, disk: [2, 40] },
  { cpu: 4, memoryMb: 32768, disk: [2, 80] },
] as const;

const presets = { small: tiers[0], medium: tiers[1], large: tiers[2] } as const;

/** The `resources` of a create body: one of Agent 37's four sizes, else `unsupported`. */
function resourcesOf(size: NonNullable<CreateInput["size"]>): JsonObject {
  const wanted = isString(size) ? presets[size] : size;
  const tier = tiers.find((t) => t.cpu === wanted.cpu && t.memoryMb === wanted.memoryMb);

  if (!tier)
    throw fail(
      "size must be one of Agent 37's sizes: 2 vCPU / 4096 MiB, or 4 vCPU with 8192, 16384 or 32768 MiB",
      "unsupported",
    );
  const resources: JsonObject = { cpu: tier.cpu, memory: tier.memoryMb / 1024 };
  const diskGb = isString(size) ? undefined : size.diskGb;

  if (diskGb !== undefined) {
    const [min, max] = tier.disk;

    if (!Number.isInteger(diskGb) || diskGb < min || diskGb > max)
      throw fail(
        `diskGb must be a whole number from ${min} to ${max} for this size`,
        "unsupported",
      );
    resources.disk = diskGb;
  }

  return resources;
}

/**
 * Run once as root at create, also on a sandbox made from a snapshot. Commands run as root (the exec
 * `user`), since the image user has no sudo, and the base image has no /workspace, the SDK's working
 * directory.
 */
const setupCommand = [
  "set -e",
  "mkdir -p /workspace /tmp/.sandbox-sdk/exec",
  "command -v python3 setsid base64 tail head wc >/dev/null",
].join("; ");

/** How long cleanup after a failed or aborted create, and a cancel, may take, on its own deadline. */
const cleanupMs = 30_000;

/** A create refused for capacity (`503 no_capacity`), which nothing ran for, is tried again for up to this long. */
const capacityBudgetMs = 120_000;

const backoffMs = (attempt: number) => Math.min(10_000, 500 * 2 ** attempt);

/** Longest wait for a create, start or fork to reach `running`. */
const runningWaitMs = 600_000;

/**
 * One exec request's own deadline. Agent 37 answers `504 try_again` once a command has run 15 minutes on
 * the exec host, and the same request sent again with the same `name` waits for that same run.
 */
const execRequestMs = 910_000;

/** Deadline for one of the adapter's own guest commands (setup, a file chunk, a kill). */
const shellMs = 120_000;

const isUnknown = (cause: unknown): cause is SandboxError =>
  cause instanceof SandboxError && cause.code === "outcome_unknown";

const isGone = (cause: unknown) => cause instanceof SandboxError && cause.code === "not_found";

/** Chunks of one file transfer in flight at once. */
const transferConcurrency = 4;

/** Runs `work` on each item, {@link transferConcurrency} at a time, and returns the results in order. */
async function pool<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const queue = items.entries();

  const worker = async () => {
    for (const [index, item] of queue) results[index] = await work(item);
  };

  await Promise.all(Array.from({ length: Math.min(transferConcurrency, items.length) }, worker));

  return results;
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

/** Whether an exec answer is a refusal made before anything ran, so the same request may be sent again. */
const execRefused = (cause: unknown) => {
  const status = httpStatus(cause);

  return (
    neverSent(cause) ||
    (status !== undefined &&
      status.status !== 504 &&
      cause instanceof SandboxError &&
      cause.code === "unavailable")
  );
};

/** `504 try_again`: the command is still running on the exec host; the same request waits on. */
const stillRunning = (cause: unknown) => {
  const status = httpStatus(cause);

  return status?.status === 504 && status.code === "try_again";
};

export function createAgent37Provider(options: Agent37Options = {}): Agent37Provider {
  const root = (
    options.baseUrl ??
    process.env.AGENT37_API_URL ??
    "https://api.agent37.com"
  ).replace(/\/+$/, "");

  const execRoot = (
    options.execUrl ??
    process.env.AGENT37_EXEC_URL ??
    "https://sandbox.agent37.app"
  ).replace(/\/+$/, "");

  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const previewTtlSeconds = Math.ceil((options.previewTtlMs ?? 3_600_000) / 1000);
  const natives = new Map<string, Agent37Native>();
  /** Public preview URLs, whose slug is their only credential. */
  const previews = new Map<string, string>();
  /** Every signed-URL token and public URL an answer carried. Kept for the client's life. */
  const tokens = new Set<string>();

  if (!Number.isFinite(previewTtlSeconds) || previewTtlSeconds < 60 || previewTtlSeconds > 604_800)
    throw fail("previewTtlMs must be between 1 minute and 7 days", "invalid_argument");

  function apiKey() {
    const key = (options.apiKey ?? process.env.AGENT37_API_KEY)?.trim();

    if (!key)
      throw fail(
        "the API key is missing. Authentication is required. Set AGENT37_API_KEY or pass apiKey",
        "auth",
      );

    return key;
  }

  const http = createHttpClient<Agent37Plane>({
    provider: name,
    label: "Agent 37",
    planes: {
      // Agent 37 never redirects a write, so none is followed: it is never sent twice.
      control: {
        baseUrl: `${root}/v1`,
        auth: () => ({ Authorization: `Bearer ${apiKey()}` }),
        redirectWrites: false,
      },
      exec: {
        baseUrl: `${execRoot}/v1`,
        auth: () => ({ "X-Agent37-Key": apiKey() }),
        redirectWrites: false,
        // A 401 is never stale credentials: one key serves both planes.
        unauthorized: () => false,
      },
    },
    defaultPlane: "control",
    fetch: options.fetch,
    timeoutMs: requestTimeoutMs,
    secrets: () => [options.apiKey ?? process.env.AGENT37_API_KEY, ...tokens],
    credentialPatterns: leakPatterns,
    authHint: "Set AGENT37_API_KEY to a valid Agent 37 workspace key (sk_live_...).",
    mapError,
  });

  const api = createNativeApi<Agent37Plane>({ http, placeholder: "id" });

  const instancePath = (id: string, route = "") => ({
    plane: "control" as const,
    path: `/instances/{id}${route}`,
    params: { id },
    sandboxId: id,
  });

  async function readInstance(id: string, request: Partial<HttpRequest<Agent37Plane>> = {}) {
    return parseInstance(await http.json({ method: "GET", ...instancePath(id), ...request }));
  }

  /**
   * Every instance whose metadata has every label, snapshots left out unless `snapshots` is set.
   * `GET /v1/instances` returns the whole workspace in one page. Deleting and deleted ones are dropped.
   */
  async function listInstances(
    labels: Labels,
    request: Partial<HttpRequest<Agent37Plane>> = {},
    snapshots = false,
  ): Promise<Agent37Instance[]> {
    const all = parseInstanceList(
      await http.json({ method: "GET", path: "/instances", ...request }),
    );

    return all.filter(
      (instance) =>
        !ending.has(instance.status) &&
        (snapshots || instance.metadata[snapshotLabel] === undefined) &&
        Object.entries(labels).every(([key, value]) => instance.metadata[key] === value),
    );
  }

  function forget(id: string) {
    natives.delete(id);

    for (const key of previews.keys()) if (key.startsWith(`${id}:`)) previews.delete(key);
  }

  /**
   * Deletes an instance. A 404 is gone. A delete answered with a 5xx is sent again, since deleting is
   * idempotent; when every try fails, a read decides: only a 404 or `deleting`/`deleted` counts as gone.
   * With `budgetMs`, every try, the waits between them and that read share one deadline.
   */
  async function destroy(id: string, budgetMs?: number) {
    const deadline = budgetMs === undefined ? undefined : createDeadline(budgetMs);
    const request: Partial<HttpRequest<Agent37Plane>> = deadline ? { deadline } : {};

    try {
      let last: unknown;

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await http.request({ method: "DELETE", ...instancePath(id), ...request });

          return;
        } catch (error) {
          if (isGone(error)) return;

          const retryable =
            (httpStatus(error)?.status ?? 500) >= 500 ||
            (error instanceof SandboxError && error.code === "unavailable");

          if (!retryable) throw error;
          last = error;
        }

        const wait = 500 * 2 ** attempt;

        if (deadline && deadline.remaining() <= wait) break;
        await delay(wait);
      }

      let instance: Agent37Instance | undefined;

      try {
        instance = await readInstance(id, request);
      } catch (error) {
        if (!isGone(error)) throw last;
      }

      if (instance !== undefined && !ending.has(instance.status)) throw last;
    } finally {
      forget(id);
    }
  }

  /** Waits for an instance to reach `running` through the statuses on the way there. */
  async function untilRunning(id: string, signal?: AbortSignal) {
    const end = Date.now() + runningWaitMs;

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw fail("creation aborted", "aborted", { sandboxId: id });
      const instance = await readInstance(id);

      if (instance.status === "running") return;

      if (!coming.has(instance.status))
        throw fail(`the instance is ${instance.status}, not running`, "provider", {
          sandboxId: id,
        });

      if (Date.now() >= end)
        throw fail("the instance did not start in ten minutes", "timeout", { sandboxId: id });
      await delay(Math.min(2000, 250 * 2 ** attempt), signal);
    }
  }

  /**
   * Sends one exec request, sent again with the same `name` while Agent 37 says the command is still
   * running (`504 try_again`), refused it before it ran, or the answer was lost: Agent 37 runs a named
   * command once and answers a resend with that run's result, while it runs and for 5 minutes after.
   */
  async function execRequest(
    id: string,
    body: JsonObject,
    signal: AbortSignal | undefined,
  ): Promise<ExecAnswer> {
    let lost = 0;
    let refused = 0;

    for (;;) {
      if (signal?.aborted) throw fail("the command was cancelled", "aborted", { sandboxId: id });

      try {
        return parseExec(
          await http.json({
            method: "POST",
            plane: "exec",
            path: "/instances/{id}/exec",
            params: { id },
            sandboxId: id,
            body,
            signal,
            timeoutMs: execRequestMs,
          }),
        );
      } catch (error) {
        if (signal?.aborted) throw error;

        if (stillRunning(error)) continue;

        if (execRefused(error) && refused < 8) {
          await delay(backoffMs(refused++), signal);
          continue;
        }

        if (isUnknown(error) && lost < 3) {
          lost++;
          continue;
        }

        throw error;
      }
    }
  }

  /**
   * Kills a command's process group in the guest, on a fresh bounded deadline. Throws `outcome_unknown`
   * unless the kill command exits 0, or the instance is confirmed gone.
   */
  async function killGroup(id: string, tag: string) {
    const deadline = createDeadline(cleanupMs);
    let last: unknown;

    for (let attempt = 0; attempt < 2; attempt++)
      try {
        const answer = await execRequest(
          id,
          { command: killCommand(tag), user: "root", name: `kill-${randomUUID()}` },
          deadline.signal,
        );

        if (answer.exitCode === 0) return;
        last = fail("the kill command did not exit cleanly", "outcome_unknown", { sandboxId: id });
      } catch (error) {
        last = error;

        if (isGone(error)) {
          const gone = await readInstance(id, { timeoutMs: cleanupMs }).then(
            (instance) => ending.has(instance.status),
            (cause: unknown) => isGone(cause),
          );

          if (gone) return;
        }
      }

    throw fail(
      "the command was cancelled, but its process group could not be confirmed killed. It may still be running; destroy the sandbox before retrying",
      "outcome_unknown",
      { sandboxId: id, cause: last instanceof SandboxError ? last.message : undefined },
    );
  }

  /** One chunk read: the file's size and the bytes from `offset`. */
  async function readChunk(id: string, path: string, offset: number, length: number) {
    const text = await shell(id, readCommand(path, offset, length));
    const newline = text.indexOf("\n");
    const head = (newline < 0 ? text : text.slice(0, newline)).trim();

    if (head === "SDK_FILE_NOT_FOUND")
      throw fail("File does not exist", "file_not_found", { sandboxId: id });

    if (head === "SDK_NOT_A_FILE")
      throw fail("the path is not a regular file", "invalid_argument", { sandboxId: id });
    const size = Number(head);

    if (!Number.isSafeInteger(size) || size < 0 || newline < 0)
      throw fail("unexpected file read answer", "provider", { sandboxId: id });

    return { size, bytes: new Uint8Array(Buffer.from(text.slice(newline + 1).trim(), "base64")) };
  }

  /**
   * Reads a whole file, or `range` of it, in chunks whose base64 fits one exec answer: the first tells
   * the size, and the rest go {@link transferConcurrency} at a time. A file that changes size meanwhile
   * is `provider`, never a silently short read.
   */
  async function readFile(id: string, path: string, range?: { offset: number; length: number }) {
    const start = range?.offset ?? 0;

    const first = await readChunk(
      id,
      path,
      start,
      Math.min(readChunkBytes, range?.length ?? readChunkBytes),
    );

    const end = Math.min(first.size, range === undefined ? first.size : start + range.length);
    const offsets: number[] = [];

    for (let offset = start + first.bytes.byteLength; offset < end; offset += readChunkBytes)
      offsets.push(offset);

    const rest = await pool(offsets, async (offset) => {
      const chunk = await readChunk(id, path, offset, Math.min(readChunkBytes, end - offset));

      if (
        chunk.size !== first.size ||
        chunk.bytes.byteLength !== Math.min(readChunkBytes, end - offset)
      )
        throw fail("the file changed while it was read", "provider", { sandboxId: id });

      return chunk.bytes;
    });

    const parts = [first.bytes, ...rest];
    const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let at = 0;

    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }

    return out;
  }

  /**
   * Writes a file through a staging file beside it, so the target changes in one rename. Up to one
   * chunk goes in a single call; a bigger file goes as parts, {@link transferConcurrency} at a time,
   * that one last call joins.
   */
  async function writeFile(id: string, path: string, bytes: Uint8Array, mode?: number) {
    const staging = `${path}.sandbox-sdk-${randomUUID()}`;

    try {
      if (bytes.byteLength <= writeChunkBytes) {
        await shell(id, writeCommand({ file: staging, chunk: bytes, target: path, mode }));

        return;
      }

      const offsets: number[] = [];

      for (let offset = 0; offset < bytes.byteLength; offset += writeChunkBytes)
        offsets.push(offset);
      await pool(offsets, (offset) =>
        shell(
          id,
          writeCommand({
            file: `${staging}.${offset / writeChunkBytes}`,
            chunk: bytes.subarray(offset, offset + writeChunkBytes),
          }),
        ),
      );
      await shell(id, joinCommand({ staging, parts: offsets.length, target: path, mode }));
    } catch (error) {
      await shell(id, discardCommand(staging)).catch(() => {});
      throw error;
    }
  }

  /** Reads one leftover output file of a command, then removes it. */
  async function drain(id: string, path: string) {
    const bytes = await readFile(id, path);

    await shell(id, `rm -f -- ${quote(path)}`).catch(() => {});

    return Buffer.from(bytes).toString("utf8");
  }

  const timedOut: ExecResult = { exitCode: null, timedOut: true };

  /**
   * One command over `POST /v1/instances/{id}/exec`, buffered: Agent 37 answers once it exits. A
   * timeout or abort ends the request and kills the process group in the guest before this settles.
   */
  async function exec(id: string, input: ExecInput): Promise<ExecResult> {
    if (input.signal?.aborted) return timedOut;
    // Chosen before the request: the wrapper records its group under it, so a cancel finds it, and it is
    // the exec `name` that makes a resend wait for the same run.
    const tag = randomUUID();
    const stop = new AbortController();
    const cancel = () => stop.abort();
    // Node fires a timer longer than 2^31 - 1 ms at once.
    const timer = setTimeout(cancel, Math.min(input.timeoutMs, 2 ** 31 - 1));
    input.signal?.addEventListener("abort", cancel, { once: true });

    const command = wrappedCommand({
      cwd: input.cwd,
      command: input.command,
      tag,
      env: input.env,
      stdin: input.stdin,
    });

    try {
      let answer: ExecAnswer;

      try {
        answer = await execRequest(id, { command, user: "root", name: tag }, stop.signal);
      } catch (error) {
        if (stop.signal.aborted) {
          await killGroup(id, tag);

          return timedOut;
        }

        // The command may have been sent and started: stop it by its tag before reporting.
        if (isUnknown(error)) await killGroup(id, tag).catch(() => {});
        throw error;
      }

      const trailer = new RegExp(`\\n${trailerPrefix}${tag} (-?\\d+) (-?\\d+) (-?\\d+)\\n$`).exec(
        answer.stdout,
      );

      if (!trailer) {
        // The supervisor could not record or stage the command: it never ran.
        if (answer.exitCode === 125 && answer.stderr.startsWith("sandbox-sdk:")) {
          input.onChunk({ stream: "stderr", text: answer.stderr });

          return { exitCode: 125, timedOut: false };
        }

        await killGroup(id, tag).catch(() => {});
        throw fail("the exec answer did not carry the command's result", "outcome_unknown", {
          sandboxId: id,
        });
      }

      const [, status = "", outSize = "", errSize = ""] = trailer;
      let stdout = answer.stdout.slice(0, trailer.index);
      let stderr = answer.stderr;

      if (Number(outSize) > inlineBytes)
        stdout = await drain(id, `/tmp/.sandbox-sdk/exec/${tag}.out`);

      if (Number(errSize) > inlineBytes)
        stderr = await drain(id, `/tmp/.sandbox-sdk/exec/${tag}.err`);

      if (stdout) input.onChunk({ stream: "stdout", text: stdout });

      if (stderr) input.onChunk({ stream: "stderr", text: stderr });

      if (stop.signal.aborted) {
        await killGroup(id, tag);

        return timedOut;
      }

      return { exitCode: Number(status), timedOut: false };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
    }
  }

  /** A short root command for the adapter itself, outside the supervisor: its stdout, or a failure. */
  async function shell(id: string, command: string) {
    const answer = await execRequest(
      id,
      { command, user: "root", name: randomUUID() },
      createDeadline(shellMs).signal,
    );

    if (answer.truncated)
      throw fail("a guest command's output was cut short", "provider", { sandboxId: id });

    if (answer.exitCode !== 0)
      throw fail(`a guest command failed (exit ${answer.exitCode})`, "provider", { sandboxId: id });

    return answer.stdout;
  }

  const guest = (id: string): Guest => ({
    name,
    raw: (command) => shell(id, command),
    upload: (path, bytes, mode) => writeFile(id, path, bytes, mode),
    read: (path, range) => readFile(id, path, range),
  });

  const shared = guestFiles(
    async (id) => guest(id),
    async (_id, action) => action(),
  );

  const files: ProviderFiles = {
    writeCreatesParents: true,
    writeSupportsMode: true,
    // The guest metadata program lists in os.listdir order.
    listOrder: "directory",
    read: (id, path) => readFile(id, path),
    readRange: (id, path, range) => readFile(id, path, range),
    write: (id, path, bytes, writeOptions) => writeFile(id, path, bytes, writeOptions?.mode),
    list: shared.list,
    stat: shared.stat,
    mkdir: shared.mkdir,
    remove: shared.remove,
  };

  /** Deletes an instance this call made, on a fresh deadline, then reports `cause`; `outcome_unknown` when unconfirmed. */
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

  function networkOf(network: NonNullable<CreateInput["network"]>): JsonValue {
    if (network === "all") return "allow-all";

    if (network === "none") return "deny-all";

    if (network.allow.length > 100)
      throw fail("an allow list holds at most 100 domains and IPv4 addresses", "unsupported");

    return { allow: network.allow };
  }

  function createBody(input: CreateInput, alloc: string): JsonObject {
    if (input.timeoutMs !== undefined)
      throw fail(
        "Agent 37 instances have no time limit; omit timeoutMs and destroy the sandbox when done",
        "unsupported",
      );
    const metadata: Labels = { ...input.labels, [allocLabel]: alloc };

    if (input.key !== undefined) metadata[keyLabel] = input.key;

    const body: JsonObject = {
      template: options.template ?? "agent37-base",
      type: options.type ?? "default",
      name: "sandbox-sdk",
      metadata,
    };

    if (options.region !== undefined) body.region = options.region;

    if (input.size !== undefined) body.resources = resourcesOf(input.size);

    if (input.env !== undefined && Object.keys(input.env).length) body.env = input.env;

    if (input.network !== undefined) body.network = networkOf(input.network);

    if (input.idleTimeoutMs !== undefined) {
      const seconds = Math.ceil(input.idleTimeoutMs / 1000);

      if (!Number.isFinite(seconds) || seconds < 300 || seconds > 86_400)
        throw fail("idleTimeoutMs must be between 5 minutes and 1 day", "unsupported");
      body.auto_sleep = true;
      body.idle_timeout_seconds = seconds;
    }

    return body;
  }

  /** The body of a create from a snapshot: a fork of the stopped instance the snapshot is. */
  function forkBody(input: CreateInput, alloc: string): JsonObject {
    if (input.timeoutMs !== undefined)
      throw fail(
        "Agent 37 instances have no time limit; omit timeoutMs and destroy the sandbox when done",
        "unsupported",
      );

    if ((input.env !== undefined && Object.keys(input.env).length) || input.network !== undefined)
      throw fail(
        "a sandbox made from a snapshot keeps the snapshot's environment and network policy; omit env and network",
        "unsupported",
      );
    // The fork's metadata is this body's alone: the snapshot's marker does not carry over.
    const metadata: Labels = { ...input.labels, [allocLabel]: alloc };

    if (input.key !== undefined) metadata[keyLabel] = input.key;

    const body: JsonObject = { name: "sandbox-sdk", metadata };

    if (input.size !== undefined) body.resources = resourcesOf(input.size);

    return body;
  }

  /**
   * After a create whose answer was lost or unreadable: within one fresh {@link cleanupMs} deadline, find
   * the instance by this call's allocation marker. Only one instance carrying it is returned.
   */
  async function reconcile(alloc: string, unknown: SandboxError): Promise<Agent37Instance> {
    let found: Agent37Instance[];

    try {
      found = (await listInstances({ [allocLabel]: alloc }, { timeoutMs: cleanupMs }, true)).filter(
        (instance) => instance.metadata[allocLabel] === alloc,
      );
    } catch {
      throw unknown;
    }

    const [first] = found;

    if (!first || found.length !== 1) throw unknown;

    return first;
  }

  /** Sends one create or fork, retrying capacity refusals, and settles which instance it made. */
  async function make(request: HttpRequest<Agent37Plane>, alloc: string, signal?: AbortSignal) {
    const capacityEnd = Date.now() + capacityBudgetMs;

    for (let attempt = 0; ; attempt++) {
      let answer: InstanceAnswer;

      try {
        // Not the caller's signal: once sent, the answer names the instance to delete.
        answer = parseInstanceAnswer(await http.json(request));
      } catch (error) {
        const wait = backoffMs(attempt);
        const code = httpStatus(error)?.code;

        if (
          (code === "no_capacity" || code === "try_again") &&
          Date.now() + wait < capacityEnd &&
          !signal?.aborted
        ) {
          await delay(wait, signal);

          if (signal?.aborted) throw fail("creation aborted", "aborted");
          continue;
        }

        if (!isUnknown(error)) throw error;

        return reconcile(alloc, error);
      }

      if (answer.kind === "unreadable")
        return reconcile(
          alloc,
          fail(
            "the create was answered but its answer could not be read, so a sandbox may exist",
            "outcome_unknown",
          ),
        );

      if (answer.instance.metadata[allocLabel] !== alloc)
        throw fail(
          `the create answered with sandbox ${answer.instance.id}, which this call did not make; it was left alone`,
          "outcome_unknown",
          { sandboxId: answer.instance.id },
        );

      return answer.instance;
    }
  }

  /** The snapshot a create's `from` names: a stopped fork this adapter keeps, else `invalid_argument`. */
  async function snapshotOf(from: string) {
    let instance: Agent37Instance;

    try {
      instance = await readInstance(from);
    } catch (error) {
      if (isGone(error)) throw fail(`snapshot ${from} does not exist`, "not_found");
      throw error;
    }

    if (!instance.metadata[snapshotLabel])
      throw fail(
        "from must be a snapshot ID from snapshot(); choose a template with the template option",
        "invalid_argument",
      );

    return instance;
  }

  const provider: Agent37Provider = {
    name,
    keyMode: "best-effort",
    capabilities: new Set<Agent37Capability>([
      "pause",
      "snapshot",
      "snapshot-delete",
      "network-policy",
      "size",
    ]),
    api,

    async create(input) {
      // Names this call's instance in its metadata, so a lost answer is trusted only when it is ours.
      const alloc = randomUUID();
      let request: HttpRequest<Agent37Plane>;

      if (input.from === undefined)
        request = { method: "POST", path: "/instances", body: createBody(input, alloc) };
      else {
        const snapshot = await snapshotOf(input.from);
        request = {
          method: "POST",
          ...instancePath(snapshot.id, "/fork"),
          body: forkBody(input, alloc),
          timeoutMs: runningWaitMs,
        };
      }

      if (input.signal?.aborted) throw fail("creation aborted", "aborted");
      const instance = await make(request, alloc, input.signal);
      const id = instance.id;

      try {
        if (input.signal?.aborted) throw fail("creation aborted", "aborted", { sandboxId: id });

        if (instance.status !== "running") await untilRunning(id, input.signal);
        await shell(id, setupCommand);

        if (input.signal?.aborted) throw fail("creation aborted", "aborted", { sandboxId: id });
      } catch (error) {
        return abandon(id, error);
      }

      return {
        id,
        key: input.key,
        labels: { ...input.labels },
        state: "running",
        createdAt: instance.createdAt || Date.now(),
      };
    },

    async find(key) {
      // A failed instance never runs again: a key that names only those makes a new sandbox.
      const first = (await listInstances({ [keyLabel]: key })).find((i) => i.status !== "failed");

      return first ? toInfo(first) : undefined;
    },

    async connect(id) {
      // A read only: it never wakes a sleeping instance.
      const instance = await readInstance(id);

      if (ending.has(instance.status) || instance.metadata[snapshotLabel]) {
        forget(id);
        throw fail("the sandbox does not exist", "not_found", { sandboxId: id });
      }

      return toInfo(instance);
    },

    async list(labels) {
      return (await listInstances(labels)).map(toInfo);
    },

    destroy: (id) => destroy(id),

    async close(id) {
      forget(id);
    },

    exec,
    files,

    async previewUrl(id, port) {
      if (!options.public) {
        const signed = parseSignedUrl(
          await http.json({
            method: "POST",
            ...instancePath(id, "/signed-url"),
            body: { port, ttl_seconds: previewTtlSeconds },
            readOnly: true,
          }),
        );

        for (const token of tokensIn(signed.url)) tokens.add(token);

        return signed.expiresAt === undefined
          ? { url: signed.url }
          : { url: signed.url, expiresAt: signed.expiresAt };
      }

      const cached = previews.get(`${id}:${port}`);

      if (cached) return { url: cached };
      let url: string;

      try {
        url = parsePublicPort(
          await http.json({ method: "POST", ...instancePath(id, "/public-ports"), body: { port } }),
        ).url;
      } catch (error) {
        // One URL per port: an earlier call made it.
        if (httpStatus(error)?.code !== "public_port_exists") throw error;

        const found = parsePublicPorts(
          await http.json({ method: "GET", ...instancePath(id, "/public-ports") }),
        ).find((entry) => entry.port === port);

        if (!found) throw error;
        url = found.url;
      }

      tokens.add(new URL(url).host);
      previews.set(`${id}:${port}`, url);

      return { url };
    },

    native(id) {
      let value = natives.get(id);

      if (!value) {
        value = createNativeApi<Agent37Plane>({ http, placeholder: "id", sandboxId: id });
        natives.set(id, value);
      }

      return value;
    },

    async pause(id) {
      for (let attempt = 0; ; attempt++)
        try {
          await http.request({ method: "POST", ...instancePath(id, "/sleep"), readOnly: true });

          return;
        } catch (error) {
          const status = httpStatus(error);

          // Another operation is still running on the instance, or it is already going to sleep.
          if (status?.code === "try_again" && attempt < 8) {
            await delay(backoffMs(attempt));
            continue;
          }

          // Any state but running is a 400: already asleep is the outcome asked for.
          if (status?.status === 400 && (await readInstance(id)).status === "sleeping") return;
          throw error;
        }
    },

    async resume(id) {
      for (let attempt = 0; ; attempt++)
        try {
          await http.request({ method: "POST", ...instancePath(id, "/start"), readOnly: true });
          break;
        } catch (error) {
          if (httpStatus(error)?.code === "try_again" && attempt < 8) {
            await delay(backoffMs(attempt));
            continue;
          }

          throw error;
        }

      await untilRunning(id);
      // A command that runs proves the instance awake: the status can trail a wake by a few seconds.
      await shell(id, "true");
    },

    async snapshot(id, snapshotOptions) {
      if (snapshotOptions?.expiresInMs)
        throw fail("snapshots are kept until deleted; omit expiresInMs", "unsupported", {
          sandboxId: id,
        });
      // A snapshot is a fork of the sandbox's disk, stopped so it bills disk alone. Its marker names the
      // source, and the allocation label names this call, so a lost answer can be looked up.
      const alloc = randomUUID();

      const fork = await make(
        {
          method: "POST",
          ...instancePath(id, "/fork"),
          body: {
            name: "sandbox-sdk-snapshot",
            metadata: { [snapshotLabel]: id, [allocLabel]: alloc },
          },
          timeoutMs: runningWaitMs,
        },
        alloc,
      );

      try {
        if (fork.status !== "running") await untilRunning(fork.id);
        await http.request({ method: "POST", ...instancePath(fork.id, "/stop"), readOnly: true });
      } catch (error) {
        return abandon(fork.id, error);
      }

      return { id: fork.id };
    },

    async deleteSnapshot(snapshotId) {
      let instance: Agent37Instance;

      try {
        instance = await readInstance(snapshotId);
      } catch (error) {
        if (isGone(error)) return false;
        throw error;
      }

      if (!instance.metadata[snapshotLabel])
        throw fail(`${snapshotId} is not a snapshot`, "invalid_argument", {
          sandboxId: snapshotId,
        });

      if (ending.has(instance.status)) return false;
      await destroy(snapshotId);

      return true;
    },
  };

  return provider;
}
