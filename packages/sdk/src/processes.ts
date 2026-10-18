import type { Provider, Preview, NativeProcess } from "./provider.js";
import type { Files } from "./files.js";
import { encodeChunk, decodePage } from "./logs.js";
import { SandboxError, invalid, type Redactor } from "./errors.js";
import { defaults, pathOf, quote, chunkRedactor } from "./run.js";
export type Readiness = { port: number } | { http: { port: number; path?: string } } | { log: RegExp };
export interface StartOptions { name: string; cwd?: string; env?: Record<string, string>; ready?: Readiness; readyTimeoutMs?: number }
export interface ProcessInfo { name: string; command: string; status: "starting" | "running" | "exited" | "failed"; pid: number; ports: number[]; startedAt: number; exitCode: number | null }
export interface ProcessHandle {
  readonly name: string; readonly url?: string; readonly ready: boolean; readonly status: ProcessInfo["status"];
  logs(options?: { after?: string; maxBytes?: number }): Promise<{ text: string; nextCursor: string; truncated: boolean }>;
  lines(options?: { after?: string }): AsyncIterable<{ text: string; stream: "stdout" | "stderr"; cursor: string }>;
  stop(options?: { graceMs?: number }): Promise<void>;
  restart(): Promise<void>;
  wait(): Promise<{ exitCode: number | null; signal: string | null }>;
}
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function makeProcesses(provider: Provider, id: string, files: Files, redactor: Redactor, env: Record<string, string>) {
  const root = "/tmp/.sandbox-sdk/procs";
  const native = new Map<string, NativeProcess>();
  const handles = new Map<string, ProcessHandle>();
  const safe = async <T>(action: () => Promise<T>): Promise<T> => { try { return await action(); } catch (error) { throw redactor.error(error, provider.name, id); } };
  const nameOf = (name: string) => { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) invalid("Process name must contain 1–128 letters, numbers, hyphens or underscores"); return `${root}/${name}`; };
  const exec = (command: string, processEnv: Record<string, string> = {}) => provider.exec(id, { command, cwd: "/workspace", env: { ...env, ...processEnv, ...defaults }, timeoutMs: 10_000, onChunk() {} });
  async function info(name: string): Promise<ProcessInfo> {
    const dir = nameOf(name); const raw: unknown = JSON.parse(await files.read(`${dir}/spec.json`));
    if (!raw || typeof raw !== "object" || !("command" in raw) || typeof raw.command !== "string" || !("startedAt" in raw) || typeof raw.startedAt !== "number") invalid("Invalid process record");
    const exit = await files.exists(`${dir}/exit`) ? Number(await files.read(`${dir}/exit`)) : null;
    const pid = Number(await files.read(`${dir}/pid`));
    return { name, command: redactor.text(raw.command), status: exit === null ? "running" : exit === 0 ? "exited" : "failed", pid, ports: "port" in raw && typeof raw.port === "number" ? [raw.port] : [], startedAt: raw.startedAt, exitCode: exit };
  }
  async function preview(port: number, options: { path?: string; waitMs?: number } = {}): Promise<Preview> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) invalid("Port must be between 1 and 65535");
    const access = await provider.previewUrl(id, port);
    if (options.path) access.url = new URL(options.path, access.url).toString();
    if (options.waitMs !== undefined) {
      const end = Date.now() + options.waitMs;
      do {
        try { const response = await fetch(access.url, { headers: access.headers, signal: AbortSignal.timeout(Math.max(1, Math.min(1000, end - Date.now()))) }); await response.body?.cancel(); if (response.ok) return access; } catch {}
        if (Date.now() >= end) break; await delay(Math.min(50, Math.max(1, end - Date.now())));
      } while (Date.now() <= end);
      throw new SandboxError(`Preview failed. Port ${port} did not answer. Check the process and its logs.`, { code: "port_not_ready" });
    }
    return access;
  }
  function process(name: string): ProcessHandle {
    const dir = nameOf(name); const existing = handles.get(name); if (existing) return existing;
    let status: ProcessInfo["status"] = "starting"; let url: string | undefined; let ready = false;
    let launch: (() => Promise<void>) | undefined;
    async function readEvents(options: { after?: string; maxBytes?: number } = {}) {
      status = (await info(name)).status;
      const bytes = await files.read(`${dir}/out.log`, { as: "bytes" });
      const base = await files.exists(`${dir}/base`) ? Number(await files.read(`${dir}/base`)) : 0;
      const after = options.after === undefined ? base : Number(options.after), max = options.maxBytes ?? 16384;
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(max) || max < 1 || max > 1_048_576) invalid("Invalid log cursor or maxBytes");
      const decoded = decodePage(bytes, Math.max(0, after - base), max, base);
      return { events: decoded.events.map(event => ({ ...event, text: redactor.text(event.text) })), nextCursor: String(base + decoded.offset), truncated: after < base || decoded.offset < bytes.length };
    }
    const handle: ProcessHandle = {
      name, get status() { return status; }, get url() { return url; }, get ready() { return ready; },
      logs: (options = {}) => safe(async () => {
        const page = await readEvents(options);
        return { text: redactor.text(page.events.map(event => event.text).join("")), nextCursor: page.nextCursor, truncated: page.truncated };
      }),
      async *lines(options = {}) {
        let cursor = options.after; const pending = { stdout: "", stderr: "" };
        do {
          const page = await safe(() => readEvents({ after: cursor })); cursor = page.nextCursor;
          for (const event of page.events) {
            pending[event.stream] += event.text;
            if (pending[event.stream].endsWith("\n")) { yield { text: pending[event.stream].slice(0, -1), stream: event.stream, cursor: event.cursor }; pending[event.stream] = ""; }
          }
          if (!page.truncated && status !== "running" && status !== "starting") {
            for (const stream of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) if (pending[stream]) yield { text: pending[stream], stream, cursor };
            break;
          }
          if (!page.truncated) await delay(25);
        } while (true);
      },
      stop: (options = {}) => safe(async () => {
        const current = await info(name); status = current.status;
        if (current.exitCode !== null) return;
        const hook = native.get(name);
        if (hook) await hook.stop({ graceMs: options.graceMs ?? 1000 });
        else { await exec(`kill -TERM -- -${current.pid} 2>/dev/null || true`); await delay(options.graceMs ?? 1000); await exec(`kill -KILL -- -${current.pid} 2>/dev/null || true`); }
        if (!(await files.exists(`${dir}/exit`))) await files.write(`${dir}/exit`, "143");
        status = "exited";
      }),
      restart: () => safe(async () => { await handle.stop(); if (!launch) {
        const current = await info(name); const raw: unknown = JSON.parse(await files.read(`${dir}/spec.json`));
        if (!raw || typeof raw !== "object") invalid("Invalid process restart record");
        const options: StartOptions = { name };
        if ("cwd" in raw && typeof raw.cwd === "string") options.cwd = raw.cwd;
        if ("env" in raw && raw.env && typeof raw.env === "object") {
          options.env = {};
          for (const [key, value] of Object.entries(raw.env)) if (typeof value === "string") options.env[key] = value === "[REDACTED]" ? env[key] ?? "" : value;
        }
        if ("readyTimeoutMs" in raw && typeof raw.readyTimeoutMs === "number") options.readyTimeoutMs = raw.readyTimeoutMs;
        if ("readiness" in raw && raw.readiness && typeof raw.readiness === "object") {
          const ready = raw.readiness;
          if ("log" in ready && typeof ready.log === "string") options.ready = { log: new RegExp(ready.log, "flags" in ready && typeof ready.flags === "string" ? ready.flags : "") };
          else if ("port" in ready && typeof ready.port === "number") options.ready = { port: ready.port };
          else if ("http" in ready && ready.http && typeof ready.http === "object" && "port" in ready.http && typeof ready.http.port === "number") options.ready = { http: { port: ready.http.port, path: "path" in ready.http && typeof ready.http.path === "string" ? ready.http.path : undefined } };
        }
        await start(current.command, options);
      } else await launch(); }),
      wait: () => safe(async () => { while (!(await files.exists(`${dir}/exit`))) await delay(25); const current = await info(name); status = current.status; return { exitCode: current.exitCode, signal: current.exitCode === 143 ? "SIGTERM" : current.exitCode === 137 ? "SIGKILL" : null }; }),
    };
    handles.set(name, handle);
    // Private launch state stays outside the serializable record.
    controllers.set(name, { state(value) { status = value; }, access(value) { url = value; }, ready(value) { ready = value; }, launch(value) { launch = value; } });
    return handle;
  }
  const controllers = new Map<string, { state(status: ProcessInfo["status"]): void; access(url: string): void; ready(value: boolean): void; launch(fn: () => Promise<void>): void }>();
  async function start(command: string, options: StartOptions): Promise<ProcessHandle> {
    return safe(async () => {
      const dir = nameOf(options.name);
      if (await files.exists(`${dir}/spec.json`) && !(await files.exists(`${dir}/exit`))) invalid(`Process ${options.name} is already running`);
      const handle = process(options.name); const controller = controllers.get(options.name);
      const port = options.ready && "port" in options.ready ? options.ready.port : options.ready && "http" in options.ready ? options.ready.http.port : undefined;
      const launch = async () => {
        controller?.state("starting"); controller?.ready(false);
        await files.write(`${dir}/spec.json`, JSON.stringify({ command: redactor.text(command), cwd: pathOf(options.cwd), env: Object.fromEntries(Object.entries(options.env ?? {}).map(([key, value]) => [key, redactor.text(value)])), startedAt: Date.now(), port, readiness: options.ready && ("log" in options.ready ? { log: options.ready.log.source, flags: options.ready.log.flags } : options.ready), readyTimeoutMs: options.readyTimeoutMs }));
        const priorBase = await files.exists(`${dir}/base`) ? Number(await files.read(`${dir}/base`)) + (await files.stat(`${dir}/out.log`)).size : 0;
        await files.write(`${dir}/out.log`, ""); await files.write(`${dir}/base`, String(priorBase));
        if (await files.exists(`${dir}/exit`)) await files.remove(`${dir}/exit`);
        if (provider.startProcess && provider.name === "memory") {
          let writing: Promise<void> | undefined; let queued: string[] = []; let queuedBytes = 0; let discarded = 0;
          const drain = () => writing ??= (async () => {
            while (queued.length || discarded) {
              const records = queued; queued = []; queuedBytes = 0;
              const lost = discarded; discarded = 0;
              let before = await files.read(`${dir}/out.log`, { as: "bytes" });
              let base = Number(await files.read(`${dir}/base`));
              if (lost) { base += before.length + lost; before = new Uint8Array(); }
              let combined = Buffer.concat([before, Buffer.from(records.join(""))]);
              if (combined.length > 10_485_760) { const cut = combined.indexOf(10, combined.length - 5_242_880) + 1; base += cut; combined = combined.subarray(cut); }
              await files.write(`${dir}/base`, String(base)); await files.write(`${dir}/out.log`, combined);
            }
          })().finally(() => { writing = undefined; });
          const filter = chunkRedactor(redactor, chunk => {
            for (const record of encodeChunk(chunk)) {
              queued.push(record); queuedBytes += Buffer.byteLength(record);
              while (queuedBytes > 1_048_576 && queued.length > 1) { const removed = queued.shift() ?? ""; queuedBytes -= Buffer.byteLength(removed); discarded += Buffer.byteLength(removed); }
            }
            void drain().catch(() => controller?.state("failed"));
          });
          const hook = await provider.startProcess(id, { command, cwd: pathOf(options.cwd), env: { ...env, ...options.env, ...defaults }, onChunk: chunk => filter.push(chunk) });
          native.set(options.name, hook); await files.write(`${dir}/pid`, String(hook.pid));
          void hook.wait().then(async result => { filter.flush(); await drain(); await files.write(`${dir}/exit`, String(result.exitCode ?? 137)); controller?.state(result.exitCode === 0 ? "exited" : "failed"); }).catch(async error => { await files.write(`${dir}/exit`, "1").catch(() => {}); controller?.state("failed"); void error; });
        } else {
          // No resident daemon: a detached process group writes durable records itself.
          const sedPath = `${dir}/redact.sed`;
          const patterns = redactor.secrets.flatMap(secret => secret.split("\n")).filter(Boolean);
          await files.write(sedPath, patterns.map(secret => `s|${secret.replace(/[\\[\].*^$|]/g, "\\$&")}|[REDACTED]|g`).join("\n") + "\n");
          await exec(`chmod 600 ${quote(sedPath)}`);
          const append = `append() { while ! mkdir ${quote(`${dir}/lock`)} 2>/dev/null; do sleep 0.01; done; printf '%s%s\\n' "$1" "$2" >> ${quote(`${dir}/out.log`)}; n=$(wc -c < ${quote(`${dir}/out.log`)}); if [ "$n" -gt 10485760 ]; then tail -c 5242880 ${quote(`${dir}/out.log`)} | tail -n +2 > ${quote(`${dir}/rotate`)}; kept=$(wc -c < ${quote(`${dir}/rotate`)}); b=$(cat ${quote(`${dir}/base`)}); echo $((b+n-kept)) > ${quote(`${dir}/base`)}; mv ${quote(`${dir}/rotate`)} ${quote(`${dir}/out.log`)}; fi; rmdir ${quote(`${dir}/lock`)}; };`;
          const reader = (stream: string, fifo: string) => `(sed -u -f ${quote(sedPath)} < ${quote(fifo)} | while IFS= read -r line || [ -n "$line" ]; do append ${stream} "$line"; done) &`;
          const wrapper = `trap 'code=$?; printf "%s" "$code" > ${quote(`${dir}/exit`)}' EXIT; trap 'exit 143' TERM; cd ${quote(pathOf(options.cwd))} || exit 1; ${append} rm -f ${quote(`${dir}/stdout`)} ${quote(`${dir}/stderr`)}; mkfifo ${quote(`${dir}/stdout`)} ${quote(`${dir}/stderr`)}; ${reader("O", `${dir}/stdout`)} out=$!; ${reader("E", `${dir}/stderr`)} err=$!; sh -c ${quote(command)} > ${quote(`${dir}/stdout`)} 2> ${quote(`${dir}/stderr`)}; code=$?; wait "$out" "$err"; exit "$code"`;
          if (provider.startProcess) {
            const hook = await provider.startProcess(id, { command: wrapper, cwd: "/workspace", env: { ...env, ...options.env, ...defaults }, onChunk() {} });
            native.set(options.name, hook); await files.write(`${dir}/pid`, String(hook.pid));
            void hook.wait().then(async result => { if (!(await files.exists(`${dir}/exit`))) await files.write(`${dir}/exit`, String(result.exitCode ?? 137)); }).catch(async () => { await files.write(`${dir}/exit`, "1").catch(() => {}); });
          } else await exec(`nohup setsid sh -c ${quote(wrapper)} > /dev/null 2>&1 < /dev/null & echo $! > ${quote(`${dir}/pid`)}`, options.env);
        }
        controller?.state("running");
        if (!options.ready) { controller?.ready(true); return; }
        const end = Date.now() + (options.readyTimeoutMs ?? 60_000);
        let readyCursor: string | undefined; let readyTail = "";
        do {
          const page = await handle.logs({ after: readyCursor, maxBytes: 1_048_576 }); readyCursor = page.nextCursor;
          readyTail = (readyTail + page.text).slice(-1_048_576);
          if (await files.exists(`${dir}/exit`)) throw new SandboxError(`Process exited before readiness. Exit ${(await info(options.name)).exitCode}. Check the last logs: ${page.text.split("\n").slice(-50).join("\n")}`, { code: "process_exited" });
          if ("log" in options.ready) { options.ready.log.lastIndex = 0; if (options.ready.log.test(readyTail)) { controller?.ready(true); return; } }
          else if (port) {
            try {
              // memory previews are intentionally offline; the native hook's fake URL denotes readiness.
              const access = await preview(port, provider.name === "memory" ? {} : { path: "http" in options.ready ? options.ready.http.path : undefined, waitMs: Math.max(1, Math.min(100, end - Date.now())) });
              controller?.access(access.url); controller?.ready(true); return;
            } catch (error) { if (!(error instanceof SandboxError) || error.code !== "port_not_ready") throw error; }
          }
          if (Date.now() >= end) break; await delay(25);
        } while (Date.now() <= end);
        throw new SandboxError(`Process is still running but readiness timed out. No readiness signal arrived. Inspect logs: ${(await handle.logs()).text.split("\n").slice(-50).join("\n")}`, { code: "timeout" });
      };
      controller?.launch(launch); await launch(); return handle;
    });
  }
  return { start, process, preview: (port: number, options?: { path?: string; waitMs?: number }) => safe(() => preview(port, options)), processes: () => safe(async () => {
    if (!(await files.exists(root))) return [];
    const result: ProcessInfo[] = []; for (const dir of await files.list(root)) if (dir.type === "directory") result.push(await info(dir.path.split("/").pop() ?? "")); return result;
  }) };
}
