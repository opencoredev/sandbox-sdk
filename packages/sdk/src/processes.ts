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
function linePosition(after?: string) {
  const empty = { stdout: "", stderr: "" };
  if (after === undefined || /^\d+$/.test(after)) return { offset: after, pending: empty };
  if (Buffer.byteLength(after) > 1_048_576) invalid("Invalid line cursor");
  let raw: unknown;
  try { raw = JSON.parse(after); } catch { invalid("Invalid line cursor"); }
  if (!raw || typeof raw !== "object" || !("v" in raw) || raw.v !== 1 || !("offset" in raw) || typeof raw.offset !== "string" || !/^\d+$/.test(raw.offset) || !Number.isSafeInteger(Number(raw.offset)) || !("stdout" in raw) || typeof raw.stdout !== "string" || !("stderr" in raw) || typeof raw.stderr !== "string" || Buffer.byteLength(raw.stdout) > 65_536 || Buffer.byteLength(raw.stderr) > 65_536) invalid("Invalid line cursor");
  return { offset: raw.offset, pending: { stdout: raw.stdout, stderr: raw.stderr } };
}
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function makeProcesses(provider: Provider, id: string, files: Files, redactor: Redactor, env: Record<string, string>) {
  const root = provider.processRecordRoot ?? "/tmp/.sandbox-sdk/procs";
  const native = new Map<string, NativeProcess>();
  const handles = new Map<string, ProcessHandle>();
  const safe = async <T>(action: () => Promise<T>): Promise<T> => { try { return await action(); } catch (error) { throw redactor.error(error, provider.name, id); } };
  const nameOf = (name: string) => { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) invalid("Process name must contain 1–128 letters, numbers, hyphens or underscores"); return `${root}/${name}`; };
  const exec = (command: string, processEnv: Record<string, string> = {}, stdin?: string) => provider.exec(id, { command, stdin, cwd: "/workspace", env: { ...env, ...processEnv, ...defaults }, timeoutMs: 10_000, onChunk() {} });
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
      const position = linePosition(options.after).offset;
      const requested = position === undefined ? undefined : Number(position), max = options.maxBytes ?? 16384;
      if ((requested !== undefined && (!Number.isSafeInteger(requested) || requested < 0)) || !Number.isSafeInteger(max) || max < 1 || max > 1_048_576) invalid("Invalid log cursor or maxBytes");
      // A page includes a record-sized lookbehind/lookahead, never the full log.
      const budget = Math.min(max, 65_536), lookaround = 32_770;
      let base: number, start: number, size: number, bytes: Uint8Array;
      if (provider.name === "memory" && provider.files.readRange) {
        base = Number(await files.read(`${dir}/base`)); size = (await files.stat(`${dir}/out.log`)).size;
        start = Math.max(0, (requested ?? base) - base - lookaround);
        bytes = await provider.files.readRange(id, `${dir}/out.log`, { offset: start, length: budget + lookaround * 2 });
      } else {
        // Share the writer's lock so rotation cannot pair a new base with an old file.
        let wire = "";
        const result = await provider.exec(id, { command: `while ! mkdir ${quote(`${dir}/lock`)} 2>/dev/null; do sleep .01; done; trap 'rmdir ${quote(`${dir}/lock`)}' EXIT; b=$(cat ${quote(`${dir}/base`)}); n=$(wc -c < ${quote(`${dir}/out.log`)}); a=${requested ?? '"$b"'}; s=$((a-b-${lookaround})); [ "$s" -ge 0 ] || s=0; printf '%s %s %s\\n' "$b" "$s" "$n"; dd if=${quote(`${dir}/out.log`)} bs=1 skip="$s" count=${budget + lookaround * 2} 2>/dev/null | base64`, cwd: "/workspace", env: { ...env, ...defaults }, timeoutMs: 10_000, onChunk(chunk) { if (chunk.stream === "stdout") { wire += chunk.text; if (Buffer.byteLength(wire) > 262_144) invalid("Oversized log page"); } } });
        if (result.timedOut || result.exitCode !== 0) throw new SandboxError("Log range read failed. Retry the log request.", { code: "provider" });
        const newline = wire.indexOf("\n"); const header = wire.slice(0, newline).split(" ").map(Number);
        base = header[0] ?? NaN; start = header[1] ?? NaN; size = header[2] ?? NaN;
        if (newline < 0 || ![base, start, size].every(value => Number.isSafeInteger(value) && value >= 0)) invalid("Invalid remote log page");
        bytes = Buffer.from(wire.slice(newline + 1), "base64");
      }
      const after = Math.max(base, requested ?? base);
      const decoded = decodePage(bytes, Math.max(0, after - base - start), budget, base + start);
      const offset = base + start + decoded.offset;
      return { events: decoded.events.map(event => ({ ...event, text: redactor.text(event.text) })), nextCursor: String(offset), truncated: (requested ?? base) < base || offset < base + size };
    }
    const handle: ProcessHandle = {
      name, get status() { return status; }, get url() { return url; }, get ready() { return ready; },
      logs: (options = {}) => safe(async () => {
        const page = await readEvents(options);
        return { text: redactor.text(page.events.map(event => event.text).join("")), nextCursor: page.nextCursor, truncated: page.truncated };
      }),
      async *lines(options = {}) {
        const position = linePosition(options.after); let cursor = position.offset; const pending = position.pending;
        const checkpoint = (offset: string) => JSON.stringify({ v: 1, offset, ...pending });
        do {
          const page = await safe(() => readEvents({ after: cursor, maxBytes: 1_048_576 })); cursor = page.nextCursor;
          for (const event of page.events) {
            pending[event.stream] += event.text;
            if (Buffer.byteLength(pending[event.stream]) > 65_536) {
              const tail = Buffer.from(pending[event.stream]).subarray(-65_510); let start = 0;
              while (((tail[start] ?? 0) & 0xc0) === 0x80) start++;
              pending[event.stream] = "[line truncated]" + tail.subarray(start).toString();
            }
            if (pending[event.stream].endsWith("\n")) { const text = pending[event.stream].slice(0, -1); pending[event.stream] = ""; yield { text, stream: event.stream, cursor: checkpoint(event.cursor) }; }
          }
          if (!page.truncated && status !== "running" && status !== "starting") {
            for (const stream of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) if (pending[stream]) { const text = pending[stream]; pending[stream] = ""; yield { text, stream, cursor: checkpoint(cursor) }; }
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
        else { await exec(`kill -TERM -${current.pid} 2>/dev/null || true`); await delay(options.graceMs ?? 1000); await exec(`kill -KILL -${current.pid} 2>/dev/null || true`); }
        if (!(await files.exists(`${dir}/exit`))) await files.write(`${dir}/exit`, "143");
        status = "exited";
      }),
      restart: () => safe(async () => { await handle.stop(); if (!launch) {
        const current = await info(name); const raw: unknown = JSON.parse(await files.read(`${dir}/restart.json`));
        if (!raw || typeof raw !== "object") invalid("Invalid process restart record");
        const options: StartOptions = { name };
        if ("cwd" in raw && typeof raw.cwd === "string") options.cwd = raw.cwd;
        if ("env" in raw && raw.env && typeof raw.env === "object") {
          options.env = {};
          for (const [key, value] of Object.entries(raw.env)) if (typeof value === "string") options.env[key] = value;
        }
        if ("readyTimeoutMs" in raw && typeof raw.readyTimeoutMs === "number") options.readyTimeoutMs = raw.readyTimeoutMs;
        if ("readiness" in raw && raw.readiness && typeof raw.readiness === "object") {
          const ready = raw.readiness;
          if ("log" in ready && typeof ready.log === "string") options.ready = { log: new RegExp(ready.log, "flags" in ready && typeof ready.flags === "string" ? ready.flags : "") };
          else if ("port" in ready && typeof ready.port === "number") options.ready = { port: ready.port };
          else if ("http" in ready && ready.http && typeof ready.http === "object" && "port" in ready.http && typeof ready.http.port === "number") options.ready = { http: { port: ready.http.port, path: "path" in ready.http && typeof ready.http.path === "string" ? ready.http.path : undefined } };
        }
        await start("command" in raw && typeof raw.command === "string" ? raw.command : current.command, options);
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
      if (provider.processMode === "unsupported") throw new SandboxError("Background processes are unsupported. This runtime cannot run the SDK process-record shim. Use its native process API or another provider.", { code: "unsupported" });
      const dir = nameOf(options.name);
      if (await files.exists(`${dir}/spec.json`) && !(await files.exists(`${dir}/exit`))) invalid(`Process ${options.name} is already running`);
      const handle = process(options.name); const controller = controllers.get(options.name);
      const port = options.ready && "port" in options.ready ? options.ready.port : options.ready && "http" in options.ready ? options.ready.http.port : undefined;
      const launch = async () => {
        controller?.state("starting"); controller?.ready(false);
        await files.write(`${dir}/spec.json`, JSON.stringify({ command: redactor.text(command), cwd: pathOf(options.cwd), env: Object.fromEntries(Object.entries(options.env ?? {}).map(([key, value]) => [key, redactor.text(value)])), startedAt: Date.now(), port, readiness: options.ready && ("log" in options.ready ? { log: options.ready.log.source, flags: options.ready.log.flags } : options.ready), readyTimeoutMs: options.readyTimeoutMs }));
        const restart = JSON.stringify({ command, cwd: pathOf(options.cwd), env: options.env, readiness: options.ready && ("log" in options.ready ? { log: options.ready.log.source, flags: options.ready.log.flags } : options.ready), readyTimeoutMs: options.readyTimeoutMs });
        if (provider.name === "memory") await files.write(`${dir}/restart.json`, restart);
        else await exec(`umask 077; cat > ${quote(`${dir}/restart.json`)}`, {}, restart);
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
          await files.write(sedPath, patterns.flatMap(secret => {
            const escape = (text: string) => text.replace(/[\\[\].*^$|]/g, "\\$&");
            return [`s|${escape(secret)}|[REDACTED]|g`, ...Array.from({ length: secret.length - 1 }, (_, index) => [`s|${escape(secret.slice(0, secret.length - 1 - index))}$|[REDACTED]|`, `s|^${escape(secret.slice(index + 1))}|[REDACTED]|`]).flat()];
          }).join("\n") + "\n");
          await exec(`chmod 600 ${quote(sedPath)}`);
          const append = `append() { while ! mkdir ${quote(`${dir}/lock`)} 2>/dev/null; do sleep 0.01; done; printf '%s%s\\n' "$1" "$2" >> ${quote(`${dir}/out.log`)}; n=$(wc -c < ${quote(`${dir}/out.log`)}); if [ "$n" -gt 10485760 ]; then tail -c 5242880 ${quote(`${dir}/out.log`)} | tail -n +2 > ${quote(`${dir}/rotate`)}; kept=$(wc -c < ${quote(`${dir}/rotate`)}); b=$(cat ${quote(`${dir}/base`)}); echo $((b+n-kept)) > ${quote(`${dir}/base`)}; mv ${quote(`${dir}/rotate`)} ${quote(`${dir}/out.log`)}; fi; rmdir ${quote(`${dir}/lock`)}; };`;
          const reader = (stream: string, fifo: string) => `(nl=$(printf '\\nX'); nl=\${nl%X}; while :; do chunk=$(dd bs=4096 count=1 2>/dev/null; printf .); chunk=\${chunk%.}; [ -n "$chunk" ] || break; need=0; for byte in $(printf '%s' "$chunk" | tail -c 4 | od -An -tu1); do if [ "$byte" -ge 240 ]; then need=3; elif [ "$byte" -ge 224 ]; then need=2; elif [ "$byte" -ge 192 ]; then need=1; elif [ "$byte" -ge 128 ]; then [ "$need" -le 0 ] || need=$((need-1)); else need=0; fi; done; if [ "$need" -gt 0 ]; then rest=$(dd bs=1 count="$need" 2>/dev/null; printf .); rest=\${rest%.}; chunk="$chunk$rest"; fi; chunk=$(printf '%s\\n' "$chunk" | sed -u -f ${quote(sedPath)}; printf .); chunk=\${chunk%.}; chunk=\${chunk%"$nl"}; while [ -n "$chunk" ]; do case "$chunk" in *"$nl"*) line=\${chunk%%"$nl"*}; append ${stream} "$line"; chunk=\${chunk#*"$nl"};; *) append ${stream.toLowerCase()} "$chunk"; chunk=;; esac; done; done < ${quote(fifo)}) &`;
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
        let readyCursor: string | undefined; let readyTail = ""; let exited = false;
        const lastLines = () => readyTail.replace(/\n$/, "").split("\n").slice(-50).join("\n");
        do {
          const page = await handle.logs({ after: readyCursor, maxBytes: 1_048_576 }); readyCursor = page.nextCursor;
          readyTail = Buffer.from(readyTail + page.text).subarray(-262_144).toString();
          exited = await files.exists(`${dir}/exit`);
          if (exited && page.truncated) continue;
          if (exited) throw new SandboxError(`Process exited before readiness. Exit ${(await info(options.name)).exitCode}. Check the last logs: ${lastLines()}`, { code: "process_exited" });
          if ("log" in options.ready) { options.ready.log.lastIndex = 0; if (options.ready.log.test(readyTail)) { controller?.ready(true); return; } }
          else if (port) {
            try {
              // memory previews are intentionally offline; the native hook's fake URL denotes readiness.
              const access = await preview(port, provider.name === "memory" ? {} : { path: "http" in options.ready ? options.ready.http.path : undefined, waitMs: Math.max(1, Math.min(1000, end - Date.now())) });
              controller?.access(access.url); controller?.ready(true); return;
            } catch (error) { if (!(error instanceof SandboxError) || error.code !== "port_not_ready") throw error; }
          }
          if (Date.now() >= end) break; await delay(25);
        } while (exited || Date.now() <= end);
        throw new SandboxError(`Process is still running but readiness timed out. No readiness signal arrived. Inspect logs: ${lastLines()}`, { code: "timeout" });
      };
      controller?.launch(launch); await launch(); return handle;
    });
  }
  return { start, process, preview: (port: number, options?: { path?: string; waitMs?: number }) => safe(() => preview(port, options)), processes: () => safe(async () => {
    if (!(await files.exists(root))) return [];
    const result: ProcessInfo[] = []; for (const dir of await files.list(root)) if (dir.type === "directory") result.push(await info(dir.path.split("/").pop() ?? "")); return result;
  }) };
}
