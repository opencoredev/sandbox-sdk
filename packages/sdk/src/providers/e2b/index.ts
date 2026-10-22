import type { Sandbox as E2BSandbox, SandboxInfo as E2BInfo, EntryInfo, CommandHandle } from "e2b";
import type { Provider, SandboxInfo, ExecInput, FileInfo, NativeProcess, CreateInput } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { e2bError } from "./errors.js";

export interface E2BOptions {
  /** Defaults to E2B_API_KEY. */
  apiKey?: string;
  /** Template name or ID, including custom hardware templates. Defaults to base. */
  template?: string;
  domain?: string;
}
const keyTag = "sandbox-sdk-key";
const deadlineTag = "sandbox-sdk-deadline";
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const unsupported = (message: string) => new SandboxError(`${message}. E2B cannot enforce this option. Choose a compatible template or omit the option.`, { code: "unsupported", provider: "e2b" });
const infoOf = (info: E2BInfo): SandboxInfo => ({ id: info.sandboxId, key: info.metadata[keyTag], labels: Object.fromEntries(Object.entries(info.metadata).filter(([key]) => ![keyTag, deadlineTag].includes(key))), state: info.state, createdAt: info.startedAt.getTime() });
const fileOf = (entry: EntryInfo): FileInfo => ({ path: entry.path, type: entry.type === "dir" ? "directory" : entry.type === "symlink" ? "symlink" : "file", size: entry.size, modifiedAt: entry.modifiedTime?.getTime() ?? 0 });

/** E2B's template fixes CPU, RAM and disk; explicit size requests fail closed.
 * Cloud modules are loaded only on first provider I/O, never by importing core.
 */
export function e2b(options: E2BOptions = {}): Provider<E2BSandbox, "pause" | "snapshot" | "network-policy"> {
  let module: Promise<typeof import("e2b")> | undefined;
  const sdk = () => module ??= import("e2b");
  const api = () => ({ apiKey: options.apiKey ?? process.env.E2B_API_KEY, domain: options.domain });
  const clients = new Map<string, E2BSandbox>();
  const deadlines = new Map<string, number>();
  const detached = new Map<string, { wait: Promise<void>; release(): void }>();
  function detach(id: string) {
    if (detached.has(id)) return;
    let release = () => {};
    const wait = new Promise<void>(resolve => { release = resolve; });
    detached.set(id, { wait, release });
  }
  function attached(id: string) { detached.get(id)?.release(); detached.delete(id); }
  const handles = new Map<string, Set<CommandHandle>>();
  async function call<T>(id: string | undefined, action: () => Promise<T>, file = false): Promise<T> {
    try { return await action(); } catch (cause) { throw e2bError(cause, id, file); }
  }
  async function attach(id: string): Promise<E2BInfo> {
    const { Sandbox } = await sdk();
    const info = await Sandbox.getInfo(id, api());
    const deadline = Number(info.metadata[deadlineTag]);
    if (Number.isFinite(deadline) && deadline > 0) {
      deadlines.set(id, deadline);
      if (deadline <= Date.now()) { await Sandbox.kill(id, api()); throw new SandboxError("Sandbox lifetime expired. Its hard deadline passed. Create another sandbox.", { code: "not_found", provider: "e2b", sandboxId: id }); }
    }
    const box = await Sandbox.connect(id, { ...api(), timeoutMs: deadlines.has(id) ? Math.max(1, (deadlines.get(id) ?? 0) - Date.now()) : undefined });
    clients.set(id, box);
    // connect may lengthen the native timeout; clamp it back to the hard deadline.
    if (deadlines.has(id)) await box.setTimeout(Math.max(1, (deadlines.get(id) ?? 0) - Date.now()));
    attached(id);
    return { ...info, state: "running" };
  }
  async function client(id: string) { if (!clients.has(id)) await attach(id); const box = clients.get(id); if (!box) throw new SandboxError("Sandbox is detached. No local client exists. Connect first.", { code: "not_found", provider: "e2b", sandboxId: id }); return box; }
  async function list(metadata: Record<string, string>) {
    const { Sandbox } = await sdk();
    const pages = Sandbox.list({ ...api(), query: { metadata: { ...metadata, "sandbox-sdk": "1" }, state: ["running", "paused"] } });
    const result: SandboxInfo[] = [];
    while (pages.hasNext) result.push(...(await pages.nextItems()).map(infoOf));
    return result;
  }
  async function groupSignal(box: E2BSandbox, pid: number, signal: "TERM" | "KILL") {
    await box.commands.run(`kill -${signal} -- -${pid} 2>/dev/null || true`, { user: "root", timeoutMs: 10_000, stdin: false });
  }
  async function launch(id: string, input: Omit<ExecInput, "timeoutMs">) {
    const box = await client(id);
    // setsid may fork: publish the session leader from inside the session,
    // before user stdout. The launch stream carries this private first line.
    const prefix = `sandbox-sdk-pgid-${crypto.randomUUID()}:`;
    let pending = "";
    let pid: number | undefined;
    let confirm = (_pid: number) => {};
    const confirmed = new Promise<number>(resolve => { confirm = resolve; });
    const script = `printf '%s%s\\n' ${quote(prefix)} "$$"; exec sh -c ${quote(input.command)}`;
    const handle = await box.commands.run(`exec setsid -w sh -c ${quote(script)}`, {
      background: true, cwd: input.cwd, envs: input.env, user: "root", stdin: input.stdin !== undefined,
      timeoutMs: 0,
      onStdout: text => {
        if (pid !== undefined) { input.onChunk({ stream: "stdout", text }); return; }
        pending += text;
        const start = pending.indexOf(prefix);
        if (start === -1) {
          // Login/BASH_ENV hooks can print before the frame. Retain only a
          // possible split prefix and stream the preceding output unchanged.
          const length = Math.max(0, pending.length - prefix.length + 1);
          if (length) input.onChunk({ stream: "stdout", text: pending.slice(0, length) });
          pending = pending.slice(length);
          return;
        }
        if (start) input.onChunk({ stream: "stdout", text: pending.slice(0, start) });
        pending = pending.slice(start);
        const newline = pending.indexOf("\n", prefix.length);
        if (newline === -1) return;
        const value = Number(pending.slice(prefix.length, newline));
        if (!Number.isSafeInteger(value) || value <= 1) return;
        pid = value;
        confirm(value);
        const rest = pending.slice(newline + 1);
        pending = "";
        if (rest) input.onChunk({ stream: "stdout", text: rest });
      },
      onStderr: text => input.onChunk({ stream: "stderr", text }),
    });
    const active = handles.get(id) ?? new Set<CommandHandle>(); handles.set(id, active); active.add(handle);
    // Attach rejection handling immediately (a short command may already exit).
    const result = handle.wait().then(value => ({ exitCode: value.exitCode, signal: null }), async cause => {
      const { CommandExitError } = await sdk();
      if (cause instanceof CommandExitError) return { exitCode: cause.exitCode, signal: null };
      throw cause;
    });
    void result.catch(() => {});
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unconfirmed = () => new SandboxError("Process start could not be confirmed. No process-group ID arrived. Retry the command.", { code: "outcome_unknown", provider: "e2b", sandboxId: id });
      let groupPid: number;
      try {
        groupPid = await Promise.race([
          confirmed,
          result.then(() => { if (pid !== undefined) return pid; throw unconfirmed(); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unconfirmed()), 10_000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (input.stdin !== undefined) {
        try { await handle.sendStdin(input.stdin); await handle.closeStdin(); }
        catch (cause) {
          // A command that ignores stdin can exit before delivery. Preserve its
          // exit result; only a still-running command makes delivery failure fatal.
          if (handle.exitCode === undefined) throw cause;
        }
      }
      const settled = result.finally(() => active.delete(handle));
      void settled.catch(() => {});
      return { box, handle, pid: groupPid, result: settled };
    } catch (cause) {
      // Without a group ID, killing the sandbox is the only safe cleanup.
      await provider.destroy(id);
      throw cause;
    }
  }
  const provider: Provider<E2BSandbox, "pause" | "snapshot" | "network-policy"> = {
    name: "e2b", keyMode: "best-effort", capabilities: new Set(["pause", "snapshot", "network-policy"]),
    create: input => call(undefined, async () => {
      validate(input);
      const { Sandbox } = await sdk();
      const deadline = input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs;
      const box = await Sandbox.create(input.from ?? options.template ?? "base", {
        ...api(), envs: input.env, metadata: { ...input.labels, "sandbox-sdk": "1", ...(input.key === undefined ? {} : { [keyTag]: input.key }), ...(deadline === undefined ? {} : { [deadlineTag]: String(deadline) }) },
        timeoutMs: input.timeoutMs, lifecycle: { onTimeout: "kill", autoResume: false },
        ...(input.network === "none" ? { allowInternetAccess: false } : typeof input.network === "object" ? { network: { denyOut: ["0.0.0.0/0"], allowOut: input.network.allow } } : { allowInternetAccess: true }),
      });
      clients.set(box.sandboxId, box); if (deadline !== undefined) deadlines.set(box.sandboxId, deadline);
      try {
        if (input.signal?.aborted) throw new SandboxError("Creation aborted. Cancellation arrived during E2B creation. Retry with a fresh signal.", { code: "aborted", provider: "e2b" });
        if (deadline !== undefined) await box.setTimeout(Math.max(1, deadline - Date.now()));
        const info = await box.getInfo();
        if (input.network === "none" && info.allowInternetAccess !== false && !(info.network?.denyOut?.includes("0.0.0.0/0") && !info.network.allowOut?.length)) throw unsupported("E2B did not confirm that internet access is disabled");
        if (typeof input.network === "object") {
          const requested = input.network.allow;
          const allowed = info.network?.allowOut ?? [];
          if (!info.network?.denyOut?.includes("0.0.0.0/0") || requested.some(host => !allowed.includes(host)) || allowed.some(host => !requested.includes(host))) throw unsupported("E2B did not confirm the requested outbound allow list");
        }
        await box.files.makeDir("/workspace", { user: "root" });
        return infoOf(info);
      } catch (cause) { await provider.destroy(box.sandboxId); throw cause; }
    }),
    find: key => call(undefined, async () => { const info = (await list({ [keyTag]: key }))[0]; return info ? provider.connect(info.id) : undefined; }),
    connect: id => call(id, async () => infoOf(await attach(id))),
    list: labels => call(undefined, () => list(labels)),
    destroy: id => call(id, async () => { const { Sandbox } = await sdk(); await Sandbox.kill(id, api()); clients.delete(id); deadlines.delete(id); attached(id); for (const handle of handles.get(id) ?? []) await handle.disconnect(); handles.delete(id); }),
    close: id => call(id, async () => { detach(id); for (const handle of handles.get(id) ?? []) await handle.disconnect(); handles.delete(id); clients.delete(id); }),
    native(id) { const box = clients.get(id); if (!box) throw new SandboxError("Sandbox client is detached. There is no cached native object. Connect the sandbox first.", { code: "not_found", provider: "e2b", sandboxId: id }); return box; },
    exec: (id, input) => call(id, async () => {
      if (input.signal?.aborted) return { exitCode: null, timedOut: true };
      const started = Date.now();
      let cancelled = false;
      let cancel = () => {};
      const cancellation = new Promise<"cancelled">(resolve => { cancel = () => { cancelled = true; resolve("cancelled"); }; });
      input.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, input.timeoutMs);
      try {
        const running = await launch(id, input);
        if (input.signal?.aborted || Date.now() - started >= input.timeoutMs) cancel();
        const outcome = cancelled ? "cancelled" : await Promise.race([running.result, cancellation]);
        if (outcome !== "cancelled") return { exitCode: outcome.exitCode, timedOut: false };
        try { await groupSignal(running.box, running.pid, "KILL"); await running.handle.kill(); }
        catch (cause) { await provider.destroy(id); throw cause; }
        await running.handle.disconnect();
        return { exitCode: null, timedOut: true };
      } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); }
    }),
    files: {
      writeCreatesParents: true,
      read: (id, path) => call(id, async () => new Uint8Array(await (await client(id)).files.read(path, { format: "bytes", user: "root" })), true),
      write: (id, path, data) => call(id, async () => { const box = await client(id); await box.files.write(path, new Uint8Array(data).buffer, { user: "root" }); }, true),
      list: (id, path) => call(id, async () => (await (await client(id)).files.list(path, { user: "root", depth: 1 })).map(fileOf), true),
      stat: (id, path) => call(id, async () => fileOf(await (await client(id)).files.getInfo(path, { user: "root" })), true),
      mkdir: (id, path) => call(id, async () => { await (await client(id)).files.makeDir(path, { user: "root" }); }, true),
      remove: (id, path, options) => call(id, async () => { const box = await client(id); if (!options.recursive && (await box.files.getInfo(path, { user: "root" })).type === "dir" && (await box.files.list(path, { user: "root", depth: 1 })).length) throw new SandboxError("Directory is not empty. Recursive removal was not requested. Pass recursive: true.", { code: "invalid_argument", provider: "e2b", sandboxId: id }); await box.files.remove(path, { user: "root" }); }, true),
    },
    previewUrl: (id, port) => call(id, async () => ({ url: `https://${(await client(id)).getHost(port)}` })),
    pause: id => call(id, async () => { detach(id); try { const { Sandbox } = await sdk(); await Sandbox.pause(id, api()); clients.delete(id); for (const handle of handles.get(id) ?? []) await handle.disconnect(); } catch (cause) { attached(id); throw cause; } }),
    resume: id => call(id, async () => { await attach(id); }),
    snapshot: id => call(id, async () => ({ id: (await (await client(id)).createSnapshot()).snapshotId })),
    startProcess: (id, input) => call(id, async (): Promise<NativeProcess> => {
      const running = await launch(id, input);
      return { pid: running.pid, wait: () => call(id, async () => { try { return await running.result; } catch {} await detached.get(id)?.wait; const handle = await (await client(id)).commands.connect(running.handle.pid, { timeoutMs: 0 }); try { const value = await handle.wait(); return { exitCode: value.exitCode, signal: null }; } catch (cause) { const { CommandExitError } = await sdk(); if (cause instanceof CommandExitError) return { exitCode: cause.exitCode, signal: null }; throw cause; } }), stop: options => call(id, async () => { await groupSignal(running.box, running.pid, "TERM"); await sleep(options.graceMs); await groupSignal(running.box, running.pid, "KILL"); await running.handle.kill(); }) };
    }),
  };
  return provider;
}
function validate(input: CreateInput) {
  if (input.size !== undefined) throw unsupported("Machine size is fixed by the E2B template; small, medium, large and custom sizes are unavailable at creation");
  if (input.idleTimeoutMs !== undefined) throw unsupported("E2B timeouts measure elapsed time, not idle time; idleTimeoutMs is unavailable");
  if (input.labels[keyTag] !== undefined || input.labels[deadlineTag] !== undefined) throw new SandboxError("Reserved E2B metadata key. SDK lifecycle metadata must not be overwritten. Rename the label.", { code: "invalid_argument", provider: "e2b" });
}
