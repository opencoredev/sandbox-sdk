import { posix } from "node:path";
import type { Provider, Preview, NativeProcess } from "./provider.js";
import type { Files } from "./files.js";
import { encodeChunk, decodePage } from "./logs.js";
import { SandboxError, invalid, isNotFound, type Redactor } from "./errors.js";
import { defaults, pathOf, chunkRedactor } from "./run.js";
import {
  detachedLaunchScript,
  logPageScript,
  recordExit,
  recordSetupScript,
  redactionSedScript,
  supervisorScript,
} from "./shell/process-records.js";

/** A stable process name for a command: its program name plus a short FNV-1a hash of the full command. */
export function defaultProcessName(command: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < command.length; index++)
    hash = Math.imul(hash ^ command.charCodeAt(index), 0x01000193) >>> 0;

  const program =
    (command.trim().split(/\s+/)[0] ?? "")
      .split("/")
      .pop()
      ?.replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 48) || "process";

  return `${program}-${hash.toString(16).padStart(8, "0")}`;
}

export type Readiness =
  | { port: number }
  | { http: { port: number; path?: string } }
  | { log: RegExp };

/** `name` defaults to a stable name derived from the command, so the same command always maps to the same process. */
export interface StartOptions {
  name?: string;
  cwd?: string;
  env?: Record<string, string>;
  ready?: Readiness;
  readyTimeoutMs?: number;
}

export interface ProcessInfo {
  name: string;
  command: string;
  status: "starting" | "running" | "exited" | "failed";
  pid: number;
  ports: number[];
  startedAt: number;
  exitCode: number | null;
}

export interface ProcessHandle {
  readonly name: string;
  readonly url?: string;
  readonly ready: boolean;
  readonly status: ProcessInfo["status"];
  logs(options?: {
    after?: string;
    maxBytes?: number;
  }): Promise<{ text: string; nextCursor: string; truncated: boolean }>;
  lines(options?: {
    after?: string;
  }): AsyncIterable<{ text: string; stream: "stdout" | "stderr"; cursor: string }>;
  stop(options?: { graceMs?: number }): Promise<void>;
  restart(): Promise<void>;
  wait(): Promise<{ exitCode: number | null; signal: string | null }>;
}

function linePosition(after?: string) {
  const empty = { stdout: "", stderr: "" };

  if (after === undefined || /^\d+$/.test(after)) return { offset: after, pending: empty };

  if (Buffer.byteLength(after) > 1_048_576) invalid("Invalid line cursor");
  let raw: unknown;

  try {
    raw = JSON.parse(after);
  } catch {
    invalid("Invalid line cursor");
  }

  if (
    !raw ||
    typeof raw !== "object" ||
    !("v" in raw) ||
    raw.v !== 1 ||
    !("offset" in raw) ||
    typeof raw.offset !== "string" ||
    !/^\d+$/.test(raw.offset) ||
    !Number.isSafeInteger(Number(raw.offset)) ||
    !("stdout" in raw) ||
    typeof raw.stdout !== "string" ||
    !("stderr" in raw) ||
    typeof raw.stderr !== "string" ||
    Buffer.byteLength(raw.stdout) > 65_536 ||
    Buffer.byteLength(raw.stderr) > 65_536
  )
    invalid("Invalid line cursor");

  return { offset: raw.offset, pending: { stdout: raw.stdout, stderr: raw.stderr } };
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function makeProcesses(
  provider: Provider,
  id: string,
  files: Files,
  redactor: Redactor,
  env: Record<string, string>,
) {
  const root = provider.processRecordRoot ?? "/tmp/.sandbox-sdk/procs";
  const native = new Map<string, NativeProcess>();
  const handles = new Map<string, ProcessHandle>();
  // Stream providers run commands without a guest shell, so the core keeps their records with file calls.
  const streams = provider.processMode === "stream";

  const safe = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      throw redactor.error(error, provider.name, id);
    }
  };

  const nameOf = (name: string) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name))
      invalid("Process name must contain 1–128 letters, numbers, hyphens or underscores");

    return `${root}/${name}`;
  };

  const exec = (
    command: string,
    processEnv: Record<string, string> = {},
    stdin?: string,
    onStdout: (text: string) => void = () => {},
  ) =>
    provider.exec(id, {
      command,
      stdin,
      cwd: "/workspace",
      env: { ...env, ...processEnv, ...defaults },
      timeoutMs: 10_000,
      onChunk(chunk) {
        if (chunk.stream === "stdout") onStdout(chunk.text);
      },
    });

  // Without a native range read, read the whole log and keep the requested window.
  async function readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (provider.files.readRange) return provider.files.readRange(id, path, { offset, length });
    const bytes = await provider.files.read(id, path);

    return bytes.subarray(offset, offset + length);
  }

  // Some adapters report a missing path as a generic provider error; a stat confirms it.
  async function isAbsent(error: SandboxError, path: string): Promise<boolean> {
    if (isNotFound(error)) return true;

    return error.code === "provider" && !(await files.exists(path));
  }

  async function exitCode(dir: string): Promise<number | null> {
    try {
      return Number(await files.read(`${dir}/exit`));
    } catch (error) {
      if (error instanceof SandboxError && (await isAbsent(error, `${dir}/exit`))) return null;
      throw error;
    }
  }

  async function info(name: string): Promise<ProcessInfo> {
    const dir = nameOf(name);

    const [record, exit, pid] = await Promise.all([
      files.read(`${dir}/spec.json`),
      exitCode(dir),
      files.read(`${dir}/pid`),
    ]);

    const raw: unknown = JSON.parse(record);

    if (
      !raw ||
      typeof raw !== "object" ||
      !("command" in raw) ||
      typeof raw.command !== "string" ||
      !("startedAt" in raw) ||
      typeof raw.startedAt !== "number"
    )
      invalid("Invalid process record");

    return {
      name,
      command: redactor.text(raw.command),
      status: exit === null ? "running" : exit === 0 ? "exited" : "failed",
      pid: Number(pid),
      ports: "port" in raw && typeof raw.port === "number" ? [raw.port] : [],
      startedAt: raw.startedAt,
      exitCode: exit,
    };
  }

  async function preview(
    port: number,
    options: { path?: string; waitMs?: number } = {},
  ): Promise<Preview> {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      invalid("Port must be between 1 and 65535");
    const access = await provider.previewUrl(id, port);

    if (options.path) access.url = new URL(options.path, access.url).toString();

    if (options.waitMs !== undefined) {
      const end = Date.now() + options.waitMs;

      do {
        try {
          let url = access.url;
          const origin = new URL(url).origin;
          const headers = new Headers(access.headers);
          const cookies = new Map<string, string>();

          const remember = (pair: string) => {
            const value = pair.split(";")[0]?.trim() ?? "";
            const split = value.indexOf("=");

            if (split > 0) cookies.set(value.slice(0, split), value);
          };

          for (const pair of (headers.get("cookie") ?? "").split(";")) remember(pair);

          for (let redirect = 0; redirect < 5; redirect++) {
            const response = await fetch(url, {
              headers,
              redirect: "manual",
              signal: AbortSignal.timeout(Math.max(1, Math.min(1000, end - Date.now()))),
            });

            await response.body?.cancel();

            if (response.ok) return access;
            const location = response.headers.get("location");

            if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
            const next = new URL(location, url);

            // Provider credentials and auth cookies never follow another origin.
            if (next.origin !== origin) break;

            for (const cookie of response.headers.getSetCookie()) remember(cookie);

            if (cookies.size) headers.set("cookie", [...cookies.values()].join("; "));
            url = next.toString();

            if (Date.now() >= end) break;
          }
        } catch {
          // A refused or timed-out request means the port is not answering yet; poll again.
        }

        if (Date.now() >= end) break;
        await delay(Math.min(50, Math.max(1, end - Date.now())));
      } while (Date.now() <= end);

      throw new SandboxError(
        `Preview failed. Port ${port} did not answer. Check the process and its logs.`,
        { code: "port_not_ready" },
      );
    }

    return access;
  }

  function process(name: string): ProcessHandle {
    const dir = nameOf(name);
    const existing = handles.get(name);

    if (existing) return existing;
    let status: ProcessInfo["status"] = "starting";
    let url: string | undefined;
    let ready = false;
    let launch: (() => Promise<void>) | undefined;

    async function readEvents(options: { after?: string; maxBytes?: number } = {}) {
      const position = linePosition(options.after).offset;

      const requested = position === undefined ? undefined : Number(position),
        max = options.maxBytes ?? 16384;

      if (
        (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 0)) ||
        !Number.isSafeInteger(max) ||
        max < 1 ||
        max > 1_048_576
      )
        invalid("Invalid log cursor or maxBytes");

      // A page includes a record-sized lookbehind/lookahead, never the full log.
      const budget = Math.min(max, 65_536),
        lookaround = 32_770;

      let base: number, start: number, size: number, bytes: Uint8Array;

      if (streams) {
        status = (await info(name)).status;
        base = Number(await files.read(`${dir}/base`));
        size = (await files.stat(`${dir}/out.log`)).size;
        start = Math.max(0, (requested ?? base) - base - lookaround);
        bytes = await readRange(`${dir}/out.log`, start, budget + lookaround * 2);
      } else {
        let wire = "";

        const result = await provider.exec(id, {
          command: logPageScript({
            dir,
            after: requested,
            lookbehind: lookaround,
            length: budget + lookaround * 2,
          }),
          cwd: "/workspace",
          env: { ...env, ...defaults },
          timeoutMs: 10_000,
          onChunk(chunk) {
            if (chunk.stream === "stdout") {
              wire += chunk.text;
              const separator = wire.indexOf("\0");

              if (separator >= 0 && Buffer.byteLength(wire.slice(separator + 1)) > 262_144)
                invalid("Oversized log page");
            }
          },
        });

        if (result.exitCode === recordExit.missing)
          throw new SandboxError(
            "Process record not found. This process has not been started. Check the process name.",
            { code: "file_not_found" },
          );

        if (result.timedOut || result.exitCode !== 0)
          throw new SandboxError("Log range read failed. Retry the log request.", {
            code: "provider",
          });
        const separator = wire.indexOf("\0");

        if (separator < 0) invalid("Invalid process record");
        const record: unknown = JSON.parse(wire.slice(0, separator));

        if (
          !record ||
          typeof record !== "object" ||
          !("command" in record) ||
          typeof record.command !== "string" ||
          !("startedAt" in record) ||
          typeof record.startedAt !== "number"
        )
          invalid("Invalid process record");
        const newline = wire.indexOf("\n", separator + 1);
        const header = wire.slice(separator + 1, newline).split(" ");
        base = Number(header[0]);
        start = Number(header[1]);
        size = Number(header[2]);
        const code = header[3];

        if (code !== "running" && (code === undefined || !Number.isInteger(Number(code))))
          invalid("Invalid remote process status");
        status = code === "running" ? "running" : Number(code) === 0 ? "exited" : "failed";

        if (
          newline < 0 ||
          ![base, start, size].every((value) => Number.isSafeInteger(value) && value >= 0)
        )
          invalid("Invalid remote log page");
        bytes = Buffer.from(wire.slice(newline + 1), "base64");
      }

      const after = Math.max(base, requested ?? base);
      const decoded = decodePage(bytes, Math.max(0, after - base - start), budget, base + start);
      const offset = base + start + decoded.offset;

      return {
        events: decoded.events.map((event) => ({ ...event, text: redactor.text(event.text) })),
        nextCursor: String(offset),
        truncated: (requested ?? base) < base || offset < base + size,
      };
    }

    const handle: ProcessHandle = {
      name,
      get status() {
        return status;
      },
      get url() {
        return url;
      },
      get ready() {
        return ready;
      },
      logs: (options = {}) =>
        safe(async () => {
          const page = await readEvents(options);

          return {
            text: redactor.text(page.events.map((event) => event.text).join("")),
            nextCursor: page.nextCursor,
            truncated: page.truncated,
          };
        }),
      async *lines(options = {}) {
        const position = linePosition(options.after);
        let cursor = position.offset;
        const pending = position.pending;
        const checkpoint = (offset: string) => JSON.stringify({ v: 1, offset, ...pending });

        do {
          const page = await safe(() => readEvents({ after: cursor, maxBytes: 1_048_576 }));
          cursor = page.nextCursor;

          for (const event of page.events) {
            pending[event.stream] += event.text;

            if (Buffer.byteLength(pending[event.stream]) > 65_536) {
              const tail = Buffer.from(pending[event.stream]).subarray(-65_510);
              let start = 0;

              while (((tail[start] ?? 0) & 0xc0) === 0x80) start++;
              pending[event.stream] = "[line truncated]" + tail.subarray(start).toString();
            }

            if (pending[event.stream].endsWith("\n")) {
              const text = pending[event.stream].slice(0, -1);
              pending[event.stream] = "";
              yield { text, stream: event.stream, cursor: checkpoint(event.cursor) };
            }
          }

          if (!page.truncated && status !== "running" && status !== "starting") {
            for (const stream of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[])
              if (pending[stream]) {
                const text = pending[stream];
                pending[stream] = "";
                yield { text, stream, cursor: checkpoint(cursor) };
              }

            break;
          }

          if (!page.truncated) await delay(25);
        } while (true);
      },
      stop: (options = {}) =>
        safe(async () => {
          const current = await info(name);
          status = current.status;

          if (current.exitCode !== null) return;
          const hook = native.get(name);

          if (hook) await hook.stop({ graceMs: options.graceMs ?? 1000 });
          else {
            await exec(`kill -TERM -${current.pid} 2>/dev/null || true`);
            await delay(options.graceMs ?? 1000);
            await exec(`kill -KILL -${current.pid} 2>/dev/null || true`);
          }

          if (!(await files.exists(`${dir}/exit`))) await files.write(`${dir}/exit`, "143");
          status = "exited";
        }),
      restart: () =>
        safe(async () => {
          await handle.stop();

          if (!launch) {
            const current = await info(name);
            const raw: unknown = JSON.parse(await files.read(`${dir}/restart.json`));

            if (!raw || typeof raw !== "object") invalid("Invalid process restart record");
            const options: StartOptions = { name };

            if ("cwd" in raw && typeof raw.cwd === "string") options.cwd = raw.cwd;

            if ("env" in raw && raw.env && typeof raw.env === "object") {
              options.env = {};

              for (const [key, value] of Object.entries(raw.env))
                if (typeof value === "string") options.env[key] = value;
            }

            if ("readyTimeoutMs" in raw && typeof raw.readyTimeoutMs === "number")
              options.readyTimeoutMs = raw.readyTimeoutMs;

            if ("readiness" in raw && raw.readiness && typeof raw.readiness === "object") {
              const ready = raw.readiness;

              if ("log" in ready && typeof ready.log === "string")
                options.ready = {
                  log: new RegExp(
                    ready.log,
                    "flags" in ready && typeof ready.flags === "string" ? ready.flags : "",
                  ),
                };
              else if ("port" in ready && typeof ready.port === "number")
                options.ready = { port: ready.port };
              else if (
                "http" in ready &&
                ready.http &&
                typeof ready.http === "object" &&
                "port" in ready.http &&
                typeof ready.http.port === "number"
              )
                options.ready = {
                  http: {
                    port: ready.http.port,
                    path:
                      "path" in ready.http && typeof ready.http.path === "string"
                        ? ready.http.path
                        : undefined,
                  },
                };
            }

            await start(
              "command" in raw && typeof raw.command === "string" ? raw.command : current.command,
              options,
            );
          } else await launch();
        }),
      wait: () =>
        safe(async () => {
          while (!(await files.exists(`${dir}/exit`))) await delay(25);
          const current = await info(name);
          status = current.status;

          return {
            exitCode: current.exitCode,
            signal:
              current.exitCode === 143 ? "SIGTERM" : current.exitCode === 137 ? "SIGKILL" : null,
          };
        }),
    };

    handles.set(name, handle);
    // Private launch state stays outside the serializable record.
    controllers.set(name, {
      state(value) {
        status = value;
      },
      access(value) {
        url = value;
      },
      ready(value) {
        ready = value;
      },
      launch(value) {
        launch = value;
      },
    });

    return handle;
  }

  const controllers = new Map<
    string,
    {
      state(status: ProcessInfo["status"]): void;
      access(url: string): void;
      ready(value: boolean): void;
      launch(fn: () => Promise<void>): void;
    }
  >();

  async function start(command: string, input: StartOptions = {}): Promise<ProcessHandle> {
    return safe(async () => {
      const options = { ...input, name: input.name ?? defaultProcessName(command) };

      if (provider.processMode === "unsupported")
        throw new SandboxError(
          "Background processes are unsupported. This runtime cannot run the SDK process-record shim. Use its native process API or another provider.",
          { code: "unsupported" },
        );
      const dir = nameOf(options.name);

      if (
        streams &&
        provider.startProcess &&
        (await files.exists(`${dir}/spec.json`)) &&
        !(await files.exists(`${dir}/exit`))
      )
        invalid(`Process ${options.name} is already running`);
      const handle = process(options.name);
      const controller = controllers.get(options.name);

      const port =
        options.ready && "port" in options.ready
          ? options.ready.port
          : options.ready && "http" in options.ready
            ? options.ready.http.port
            : undefined;

      const launch = async () => {
        const spec = JSON.stringify({
          command: redactor.text(command),
          cwd: pathOf(options.cwd),
          env: Object.fromEntries(
            Object.entries(options.env ?? {}).map(([key, value]) => [key, redactor.text(value)]),
          ),
          startedAt: Date.now(),
          port,
          readiness:
            options.ready &&
            ("log" in options.ready
              ? { log: options.ready.log.source, flags: options.ready.log.flags }
              : options.ready),
          readyTimeoutMs: options.readyTimeoutMs,
        });

        const restart = JSON.stringify({
          command,
          cwd: pathOf(options.cwd),
          env: options.env,
          readiness:
            options.ready &&
            ("log" in options.ready
              ? { log: options.ready.log.source, flags: options.ready.log.flags }
              : options.ready),
          readyTimeoutMs: options.readyTimeoutMs,
        });

        const sedPath = `${dir}/redact.sed`;
        // false when setup found no working directory and recorded the failure itself.
        let launched = true;
        // An exit seen while launching, so start() does not report a finished command as running.
        let early: number | undefined;
        // A native hook reports its exit from its own stream, so waiting on it costs no provider call.
        let hookExit: Promise<unknown> | undefined;

        if (streams && provider.startProcess) {
          controller?.state("starting");
          controller?.ready(false);
          await files.write(`${dir}/spec.json`, spec);
          await files.write(`${dir}/restart.json`, restart);

          const priorBase = (await files.exists(`${dir}/base`))
            ? Number(await files.read(`${dir}/base`)) + (await files.stat(`${dir}/out.log`)).size
            : 0;

          await files.write(`${dir}/out.log`, "");
          await files.write(`${dir}/base`, String(priorBase));

          if (await files.exists(`${dir}/exit`)) await files.remove(`${dir}/exit`);
        } else {
          const result = await exec(
            recordSetupScript({ dir, cwd: pathOf(options.cwd) }),
            {},
            Buffer.from(spec).toString("base64") +
              "\n" +
              Buffer.from(restart).toString("base64") +
              "\n",
          );

          if (result.exitCode === recordExit.running)
            invalid(`Process ${options.name} is already running`);

          // The working directory is missing. Its cd error is already the process log.
          if (result.exitCode === recordExit.badCwd) {
            launched = false;
            controller?.state("failed");
            controller?.ready(false);
          } else if (result.timedOut || result.exitCode !== 0)
            throw new SandboxError(
              "Process setup failed. Could not prepare durable records. Check that /tmp is writable and retry.",
              { code: "provider" },
            );
          else {
            const sed = redactionSedScript(redactor.secrets);
            await provider.files.write(id, sedPath, new TextEncoder().encode(sed));
            controller?.state("starting");
            controller?.ready(false);
          }
        }

        controller?.launch(launch);

        if (launched && streams && provider.startProcess) {
          let writing: Promise<void> | undefined;
          let queued: string[] = [];
          let queuedBytes = 0;
          let discarded = 0;

          const drain = () =>
            (writing ??= (async () => {
              while (queued.length || discarded) {
                const records = queued;
                queued = [];
                queuedBytes = 0;
                const lost = discarded;
                discarded = 0;
                let before = await files.read(`${dir}/out.log`, { as: "bytes" });
                let base = Number(await files.read(`${dir}/base`));

                if (lost) {
                  base += before.length + lost;
                  before = new Uint8Array();
                }

                let combined = Buffer.concat([before, Buffer.from(records.join(""))]);

                if (combined.length > 10_485_760) {
                  const cut = combined.indexOf(10, combined.length - 5_242_880) + 1;
                  base += cut;
                  combined = combined.subarray(cut);
                }

                await files.write(`${dir}/base`, String(base));
                await files.write(`${dir}/out.log`, combined);
              }
            })().finally(() => {
              writing = undefined;
            }));

          const filter = chunkRedactor(redactor, (chunk) => {
            for (const record of encodeChunk(chunk)) {
              queued.push(record);
              queuedBytes += Buffer.byteLength(record);

              while (queuedBytes > 1_048_576 && queued.length > 1) {
                const removed = queued.shift() ?? "";
                queuedBytes -= Buffer.byteLength(removed);
                discarded += Buffer.byteLength(removed);
              }
            }

            // A log write failure has no caller to reach; the process reports it as failed.
            void drain().catch(() => controller?.state("failed"));
          });

          const hook = await provider.startProcess(id, {
            command,
            cwd: pathOf(options.cwd),
            env: { ...env, ...options.env, ...defaults },
            onChunk: (chunk) => filter.push(chunk),
          });

          native.set(options.name, hook);
          await files.write(`${dir}/pid`, String(hook.pid));
          const exited = hook.wait();
          // Only a race signal for start(); the chain below records a failed wait.
          hookExit = exited.then(
            (result) => {
              early = result.exitCode ?? 137;
            },
            () => {},
          );
          void exited
            .then(async (result) => {
              early = result.exitCode ?? 137;
              filter.flush();
              await drain();
              await files.write(`${dir}/exit`, String(result.exitCode ?? 137));
              controller?.state(result.exitCode === 0 ? "exited" : "failed");
            })
            .catch(async () => {
              // Nothing awaits this chain. Record exit 1 if the sandbox still takes writes.
              await files.write(`${dir}/exit`, "1").catch(() => {});
              controller?.state("failed");
            });
        } else if (launched) {
          // No resident daemon: a detached process group writes durable records itself.
          const wrapper = supervisorScript({
            dir,
            cwd: pathOf(options.cwd),
            command,
            sedPath,
          });

          if (provider.startProcess) {
            const hook = await provider.startProcess(id, {
              command: wrapper,
              cwd: "/workspace",
              env: { ...env, ...options.env, ...defaults },
              onChunk() {},
            });

            native.set(options.name, hook);
            await files.write(`${dir}/pid`, String(hook.pid));

            const exited = hook.wait().then((result) => {
              early = result.exitCode ?? 137;

              return result;
            });

            // Only a race signal for start(); the chain below records a failed wait.
            hookExit = exited.catch(() => {});
            void exited
              .then(async (result) => {
                if (!(await files.exists(`${dir}/exit`)))
                  await files.write(`${dir}/exit`, String(result.exitCode ?? 137));
              })
              .catch(async () => {
                // Nothing awaits this chain. Record exit 1 if the sandbox still takes writes.
                await files.write(`${dir}/exit`, "1").catch(() => {});
              });
          } else {
            // Without readiness, wait up to ~100 ms in the guest for a command that exits at once.
            let wire = "";

            await exec(
              detachedLaunchScript({ dir, supervisor: wrapper, waitForExit: !options.ready }),
              options.env,
              undefined,
              (text) => {
                wire += text;
              },
            );

            if (/^\d+$/.test(wire.trim())) early = Number(wire.trim());
          }
        }

        if (!options.ready) {
          // Native hooks get the same ~100 ms window the shell launcher checks in the guest.
          if (early === undefined && hookExit) await Promise.race([hookExit, delay(100)]);
          const code = launched ? early : 1;
          controller?.state(code === undefined ? "running" : code === 0 ? "exited" : "failed");
          controller?.ready(code === undefined || code === 0);

          return;
        }

        if (launched) controller?.state("running");
        const end = Date.now() + (options.readyTimeoutMs ?? 60_000);
        let readyCursor: string | undefined;
        let readyTail = "";
        let exited = false;
        const lastLines = () => readyTail.replace(/\n$/, "").split("\n").slice(-50).join("\n");

        do {
          const page = await handle.logs({ after: readyCursor, maxBytes: 1_048_576 });
          readyCursor = page.nextCursor;
          readyTail = Buffer.from(readyTail + page.text)
            .subarray(-262_144)
            .toString();
          exited = await files.exists(`${dir}/exit`);

          if (exited && page.truncated) continue;

          if (exited)
            throw new SandboxError(
              `Process exited before readiness. Exit ${(await info(options.name)).exitCode}. Check the last logs: ${lastLines()}`,
              { code: "process_exited" },
            );

          if ("log" in options.ready) {
            options.ready.log.lastIndex = 0;

            if (options.ready.log.test(readyTail)) {
              controller?.ready(true);

              return;
            }
          } else if (port) {
            try {
              // Placeholder previews are never served, so issuing the URL is the readiness signal.
              const access = await preview(
                port,
                provider.previewMode === "placeholder"
                  ? {}
                  : {
                      path: "http" in options.ready ? options.ready.http.path : undefined,
                      waitMs: Math.max(1, Math.min(5000, end - Date.now())),
                    },
              );

              controller?.access(access.url);
              controller?.ready(true);

              return;
            } catch (error) {
              if (!(error instanceof SandboxError) || error.code !== "port_not_ready") throw error;
            }
          }

          if (Date.now() >= end) break;
          await delay(25);
        } while (exited || Date.now() <= end);

        throw new SandboxError(
          `Process is still running but readiness timed out. No readiness signal arrived. Inspect logs: ${lastLines()}`,
          { code: "timeout" },
        );
      };

      await launch();

      return handle;
    });
  }

  return {
    start,
    process,
    preview: (port: number, options?: { path?: string; waitMs?: number }) =>
      safe(() => preview(port, options)),
    processes: () =>
      safe(async () => {
        let entries;

        try {
          entries = await files.list(root);
        } catch (error) {
          if (error instanceof SandboxError && (await isAbsent(error, root))) return [];
          throw error;
        }

        const result: ProcessInfo[] = [];
        const directories = entries.filter((entry) => entry.type === "directory");

        // Four records at a time keeps provider calls bounded on sandboxes with many processes.
        for (let offset = 0; offset < directories.length; offset += 4) {
          const batch = directories.slice(offset, offset + 4);
          const names = batch.map((entry) => posix.basename(entry.path));
          result.push(...(await Promise.all(names.map((name) => info(name)))));
        }

        return result;
      }),
  };
}
