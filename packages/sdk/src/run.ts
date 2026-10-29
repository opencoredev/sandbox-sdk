import { posix } from "node:path";
import type { OutputChunk, Provider } from "./provider.js";
import { invalid, Redactor } from "./errors.js";
import type { RunHandle, RunOptions, RunResult } from "./types.js";
export const defaults = { CI: "1", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", DEBIAN_FRONTEND: "noninteractive", TERM: "dumb", NO_COLOR: "1" };
export const pathOf = (path = ".") => posix.resolve("/workspace", path);
export const quote = (value: unknown) => `'${String(value).replaceAll("'", "'\\''")}'`;
export const secretRecoveryCommand = `if [ -f /tmp/.sandbox-sdk/secret-names.json ]; then cat /tmp/.sandbox-sdk/secret-names.json || exit 1; printf '\\000'; env -0; fi`;
// Anonymous-pipe relays keep activity alive until inherited stdout/stderr close.
// Close the routing descriptors in the user shell: only its actual output pipes
// should keep the relays alive. Every child remains in the adapter's process group.
const activityScript = `trap 'rm -rf -- "$2"' EXIT
(umask 077; mkdir -p "$2") || exit 1
{ { "$3" -c "$1" 3>&- 4>&-; printf '%s\\n' "$?" > "$2/status"; } 2>&1 >&3 | cat >&4; } 3>&1 4>&2 | cat
read -r code < "$2/status"
exit "$code"`;
const activityCommand = (command: string, path: string, shell = "sh") => `sh -c ${quote(activityScript)} sh ${quote(command)} ${quote(path)} ${quote(shell)}`;
// Guest markers cover independent SDK clients after launch. This registry also
// covers transport setup/queueing before the guest can publish its marker.
const activeRuns = new Map<string, Map<string, number>>();
export const isRunActive = (provider: string, id: string) => (activeRuns.get(provider)?.get(id) ?? 0) > 0;
function trackRun(provider: string, id: string) {
  let runs = activeRuns.get(provider);
  if (!runs) { runs = new Map(); activeRuns.set(provider, runs); }
  const counts = runs;
  counts.set(id, (counts.get(id) ?? 0) + 1);
  return () => {
    const count = (counts.get(id) ?? 1) - 1;
    if (count) counts.set(id, count); else counts.delete(id);
    if (!counts.size) activeRuns.delete(provider);
  };
}
export class BufferCap {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  total = 0;
  constructor(readonly limit: number) {}
  add(text: string) {
    const data = Buffer.from(text); this.total += data.length;
    const headSize = Math.ceil(this.limit / 2);
    const take = Math.min(data.length, headSize - this.head.length);
    if (take > 0) this.head = Buffer.concat([this.head, data.subarray(0, take)]);
    this.tail = Buffer.concat([this.tail, data.subarray(Math.max(0, take))]);
    if (this.tail.length > this.limit - headSize) this.tail = this.tail.subarray(this.tail.length - (this.limit - headSize));
  }
  get truncated() { return this.total > this.limit; }
  text() {
    if (!this.truncated) return Buffer.concat([this.head, this.tail]).toString();
    // Decode the head in streaming mode to discard an incomplete trailing code point.
    const head = new TextDecoder().decode(this.head, { stream: true });
    let start = 0;
    while (start < this.tail.length && ((this.tail[start] ?? 0) & 0xc0) === 0x80) start++;
    const tail = this.tail.subarray(start).toString();
    return head + `\n[${this.total - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes cut]\n` + tail;
  }
}
/** Bounded independent subscriptions; slow consumers see the most recent 1 MB. */
export class OutputBus {
  private listeners = new Set<(chunk?: OutputChunk) => void>();
  private ended = false;
  private failure: unknown;
  emit(chunk: OutputChunk) { for (const listener of this.listeners) listener(chunk); }
  fail(error: unknown) { this.failure = error; this.end(); }
  end() { this.ended = true; for (const listener of this.listeners) listener(); }
  async *stream(): AsyncGenerator<OutputChunk> {
    const queue: OutputChunk[] = []; let bytes = 0; let wake = () => {};
    const listener = (chunk?: OutputChunk) => {
      if (chunk) { const text = Buffer.byteLength(chunk.text) > 1_048_576 ? Buffer.from(chunk.text).subarray(-1_048_576).toString() : chunk.text; queue.push({ ...chunk, text }); bytes += Buffer.byteLength(text); while (bytes > 1_048_576 && queue.length > 1) bytes -= Buffer.byteLength(queue.shift()?.text ?? ""); }
      wake();
    };
    this.listeners.add(listener);
    try {
      while (!this.ended || queue.length) {
        const next = queue.shift();
        if (next) { bytes -= Buffer.byteLength(next.text); yield next; }
        else await new Promise<void>(resolve => { wake = resolve; });
      }
      if (this.failure) throw this.failure;
    } finally { this.listeners.delete(listener); }
  }
}
/** Hold suffixes so secrets split between transport chunks never escape. */
export function chunkRedactor(redactor: Redactor, emit: (chunk: OutputChunk) => void, interleaved = false) {
  const queue: OutputChunk[] = [];
  function drain(final = false) {
    const secrets = redactor.secrets;
    const leading = new Set(secrets.map(secret => secret[0]));
    while (queue.length) {
      const first = queue[0]; if (!first) break;
      if (!leading.has(first.text[0])) {
        let count = 1;
        while (count < first.text.length && !leading.has(first.text[count])) count++;
        emit({ stream: first.stream, text: first.text.slice(0, count) }); first.text = first.text.slice(count);
        if (!first.text) queue.shift();
        continue;
      }
      const text = queue.filter(chunk => interleaved || chunk.stream === first.stream).map(chunk => chunk.text).join("");
      const secret = secrets.find(secret => text.startsWith(secret));
      if (secret) {
        emit({ stream: first.stream, text: "[REDACTED]" });
        let remaining = secret.length;
        for (const chunk of queue) if ((interleaved || chunk.stream === first.stream) && remaining) { const count = Math.min(remaining, chunk.text.length); chunk.text = chunk.text.slice(count); remaining -= count; }
      } else {
        if (!final && secrets.some(secret => secret.startsWith(text))) {
          if (queue.reduce((size, chunk) => size + Buffer.byteLength(chunk.text), 0) <= 1_048_576) break;
          // A stalled stream must not retain arbitrary output from another stream.
          // Conservatively redact its ambiguous prefix, preserving arrival order.
          emit({ stream: first.stream, text: "[REDACTED]" }); queue.shift(); continue;
        }
        // Emit up to the next potentially secret-leading character.
        let count = 1;
        while (count < first.text.length && !leading.has(first.text[count])) count++;
        emit({ stream: first.stream, text: first.text.slice(0, count) }); first.text = first.text.slice(count);
      }
      for (let index = queue.length - 1; index >= 0; index--) if (!queue[index]?.text) queue.splice(index, 1);
    }
  }
  return { push(chunk: OutputChunk) { if (!redactor.secrets.length) { emit(chunk); return; } queue.push({ ...chunk }); drain(); }, flush() { drain(true); } };
}
/** `guard` runs before each command: it throws when the handle is closed and waits for secret recovery. baseEnv is read per command. */
export function makeRun(provider: Provider, id: string, redactor: Redactor, baseEnv: Record<string, string>, count: (bytes: number) => void, guard: () => void | Promise<void> = () => {}) {
  return (command: string, initial: RunOptions = {}): RunHandle => {
    let options = { ...initial }; let promise: Promise<RunResult> | undefined;
    const bus = new OutputBus();
    const begin = (streaming = false) => promise ??= execute(streaming).catch(error => { const mapped = redactor.error(error, provider.name, id); bus.fail(mapped); throw mapped; });
    async function execute(streaming: boolean): Promise<RunResult> {
      await guard();
      const timeoutMs = options.timeoutMs ?? 120_000; const max = options.maxOutputBytes ?? 1_048_576;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(max) || max < 1) invalid("timeoutMs and maxOutputBytes must be positive");
      const cwd = pathOf(options.cwd); const started = Date.now();
      const stdout = new BufferCap(max), stderr = new BufferCap(max), output = new BufferCap(max * 2);
      const controller = new AbortController(); let timedOut = options.signal?.aborted ?? false;
      const abort = () => { timedOut = true; controller.abort(); };
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      const activePath = `/tmp/.sandbox-sdk/runs/${crypto.randomUUID()}`;
      let completed = false;
      const finish = trackRun(provider.name, id);
      const interleaved = chunkRedactor(redactor, chunk => { output.add(chunk.text); bus.emit(chunk); }, true);
      const filter = chunkRedactor(redactor, chunk => {
        (chunk.stream === "stdout" ? stdout : stderr).add(chunk.text); interleaved.push(chunk);
      });
      try {
        if (timedOut) controller.abort();
        const result = timedOut ? { exitCode: null, timedOut: true } : await provider.exec(id, {
          // Pass the exact command as an argument to a fresh shell. User exit,
          // exec, traps, comments and stdin cannot bypass the parent's cleanup.
          // Drain both pipes before removing activity: background descendants
          // can retain stdout/stderr after the command shell itself has exited.
          command: provider.inlineActivity ? command : activityCommand(command, activePath, provider.commandShell), cwd, env: { ...baseEnv, ...options.env, ...defaults }, stdin: options.stdin,
          timeoutMs, signal: controller.signal, streaming, envMode: options.env === undefined ? "sandbox" : undefined, activityPath: provider.inlineActivity ? activePath : undefined, onChunk: chunk => filter.push(chunk),
        });
        completed = result.exitCode !== null && result.exitCode >= 0 && result.exitCode < 128 && !result.timedOut && !controller.signal.aborted;
        timedOut ||= result.timedOut;
        filter.flush(); interleaved.flush(); count(stdout.total + stderr.total);
        return { ok: !timedOut && result.exitCode === 0, exitCode: timedOut ? null : result.exitCode,
          stdout: stdout.text(), stderr: stderr.text(), output: output.text(), durationMs: Date.now() - started,
          truncated: stdout.truncated || stderr.truncated || output.truncated, timedOut, cwd, command: redactor.text(command) };
      } catch (error) {
        filter.flush(); interleaved.flush();
        const mapped = redactor.error(error, provider.name, id); bus.fail(mapped); throw mapped;
      } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); if (!completed && !provider.inlineActivity) await Promise.resolve().then(() => provider.files.remove(id, activePath, { recursive: true })).catch(() => {}); finish(); bus.end(); }
    }
    const handle: RunHandle = {
      [Symbol.toStringTag]: "RunHandle",
      // oxlint-disable-next-line unicorn/no-thenable -- RunHandle is a lazy Promise in the public API.
      then(onfulfilled, onrejected) { return begin().then(onfulfilled, onrejected); },
      catch(onrejected) { return begin().catch(onrejected); },
      finally(onfinally) { return begin().finally(onfinally); },
      [Symbol.asyncIterator]() {
        const iterator = bus.stream();
        // Subscribe before synchronous provider chunks can arrive.
        const first = iterator.next(); void begin(true).catch(() => {});
        let initial = true;
        return { next: () => { if (initial) { initial = false; return first; } return iterator.next(); }, return: () => iterator.return(undefined) };
      },
      cwd(path) { if (promise) invalid("Run already started"); options.cwd = path; return handle; },
      env(env) { if (promise) invalid("Run already started"); options.env = { ...options.env, ...env }; return handle; },
      timeout(timeoutMs) { if (promise) invalid("Run already started"); options.timeoutMs = timeoutMs; return handle; },
    };
    return handle;
  };
}
