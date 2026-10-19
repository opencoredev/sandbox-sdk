import type { Provider, Capability, Labels, SandboxInfo } from "./provider.js";
import type { CreateOptions, Sandbox, SandboxBase } from "./types.js";
import { SandboxError, Redactor, invalid } from "./errors.js";
export { SandboxError } from "./errors.js";
export type { ErrorCode } from "./errors.js";
export type { Sandbox, SandboxBase, CreateOptions, Locator, RunOptions, RunHandle, RunResult, OutputChunk, Capability, SandboxInfo } from "./types.js";
export type { Files, FileDiff, FileEvent } from "./files.js";
export type { ProcessHandle, ProcessInfo, StartOptions, Readiness } from "./processes.js";
export type { Git } from "./git.js";
const sdkLabel = { "sandbox-sdk": "1" };
// Serializes same-key callers in this JS realm, including locator read/create/write.
// Cross-host exactness requires the provider's unique native key (see provider keyMode).
const queues = new WeakMap<Provider, Map<string, Promise<unknown>>>();
function validate(provider: Provider, options: CreateOptions) {
  for (const name of Object.keys({ ...options.env, ...options.secrets })) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) invalid("Invalid environment variable name");
  for (const cap of provider.capabilities) {
    if ((cap === "pause" && (!provider.pause || !provider.resume)) || (cap === "snapshot" && !provider.snapshot) || (cap === "terminal" && !provider.terminal)) throw new SandboxError("Invalid adapter capabilities. A declared method is missing. Fix the adapter contract.", { code: "provider" });
  }
  if (options.size !== undefined && !provider.capabilities.has("size")) throw new SandboxError("Creation refused. Provider cannot enforce size. Choose a provider with size support.", { code: "unsupported" });
  if (options.network !== undefined && options.network !== "all" && !provider.capabilities.has("network-policy")) throw new SandboxError("Creation refused. Provider cannot enforce network policy. Choose a provider with network-policy support.", { code: "unsupported" });
  if (options.from !== undefined && !provider.capabilities.has("snapshot")) throw new SandboxError("Creation refused. Provider cannot restore snapshots. Choose a provider with snapshot support.", { code: "unsupported" });
  if (options.keyMode === "exact" && provider.keyMode !== "exact" && !options.locator?.withLock) throw new SandboxError("Exact key mode unavailable. Two-function locator storage cannot enforce distributed uniqueness. Supply locator.withLock or use an exact provider.", { code: "unsupported" });
  for (const port of options.ports ?? []) if (!Number.isInteger(port) || port < 1 || port > 65535) invalid("Invalid port");
  for (const value of [options.timeoutMs, options.idleTimeoutMs]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) invalid("Timeouts must be positive milliseconds");
}
export function createSandbox<N, C extends Capability>(provider: Provider<N, C>, options?: CreateOptions): Promise<Sandbox<N, C>>;
export async function createSandbox(provider: Provider, options: CreateOptions = {}): Promise<SandboxBase<unknown>> {
  const redactor = new Redactor(); redactor.add(Object.values(options.secrets ?? {}));
  async function acquire() {
    let owned: SandboxInfo | undefined;
    try {
      validate(provider, options);
      if (options.signal?.aborted) throw new SandboxError("Creation aborted. Signal was already aborted. Retry with a fresh signal.", { code: "aborted" });
      let info: SandboxInfo | undefined;
      if (options.key) {
        const stored = await options.locator?.get(options.key);
        if (stored) { try { info = await provider.connect(stored); } catch (error) { if (!(error instanceof SandboxError) || error.code !== "not_found") throw error; } }
        info ??= await provider.find(options.key);
      }
      let created = !info;
      if (!info) {
        const { secrets, locator: _locator, keyMode: _keyMode, ...input } = options;
        const pending = provider.create({ ...input, env: { ...options.env, ...secrets }, labels: { ...options.labels, ...sdkLabel } }).catch(async error => {
          // A native unique-name conflict can race the initial lookup on another client.
          if (options.key && provider.keyMode === "exact" && !options.signal?.aborted) { const existing = await provider.find(options.key); if (existing) { created = false; return existing; } }
          throw error;
        });
        if (options.signal) {
          const signal = options.signal;
          let abort = () => {};
          const cancellation = new Promise<never>((_, reject) => {
            abort = () => reject(new SandboxError("Creation aborted. The signal was cancelled. Any late sandbox will be destroyed.", { code: "aborted" }));
            signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
          });
          const arrival = pending.then(async value => { if (signal.aborted) { if (created) await provider.destroy(value.id); throw new SandboxError("Creation aborted. Late sandbox destroyed. Retry with a fresh signal.", { code: "aborted" }); } return value; });
          try { info = await Promise.race([arrival, cancellation]); } finally { signal.removeEventListener("abort", abort); }
        } else info = await pending;
        if (created) owned = info;
      }
      if (options.signal?.aborted) { if (owned) await provider.destroy(owned.id); owned = undefined; throw new SandboxError("Creation aborted. Sandbox arrived after cancellation and was destroyed. Retry with a fresh signal.", { code: "aborted" }); }
      if (options.key) await options.locator?.set(options.key, info.id);
      const { makeHandle } = await import("./handle.js");
      return await makeHandle(provider, info, created, options, redactor);
    } catch (error) {
      if (owned) await provider.destroy(owned.id).catch(() => {});
      throw redactor.error(error, provider.name);
    }
  }
  if (!options.key) return acquire();
  let queue = queues.get(provider); if (!queue) { queue = new Map(); queues.set(provider, queue); }
  const previous = queue.get(options.key) ?? Promise.resolve();
  const key = options.key; const locator = options.locator;
  const task = previous.catch(() => {}).then(() => options.keyMode === "exact" && provider.keyMode === "best-effort" && locator?.withLock ? locator.withLock(key, acquire) : acquire()); queue.set(options.key, task);
  try { return await task; } finally { if (queue.get(options.key) === task) queue.delete(options.key); }
}
export function connectSandbox<N, C extends Capability>(provider: Provider<N, C>, id: string, options?: Pick<CreateOptions, "secrets">): Promise<Sandbox<N, C>>;
export async function connectSandbox(provider: Provider, id: string, options: Pick<CreateOptions, "secrets"> = {}): Promise<SandboxBase<unknown>> {
  const redactor = new Redactor(); redactor.add(Object.values(options.secrets ?? {}));
  try { validate(provider, options); const info = await provider.connect(id); const { makeHandle } = await import("./handle.js"); return await makeHandle(provider, info, false, { ...options, key: info.key }, redactor); }
  catch (error) { throw redactor.error(error, provider.name, id); }
}
export async function listSandboxes(provider: Provider, options: { labels?: Labels } = {}): Promise<SandboxInfo[]> {
  try { return (await provider.list({ ...options.labels, ...sdkLabel })).filter(info => info.labels["sandbox-sdk"] === "1"); }
  catch (error) { throw new Redactor().error(error, provider.name); }
}
export async function reapSandboxes(provider: Provider, options: { olderThanMs?: number; labels?: Labels; idleOnly?: boolean } = {}): Promise<number> {
  if (options.olderThanMs !== undefined && (!Number.isFinite(options.olderThanMs) || options.olderThanMs < 0)) invalid("olderThanMs must be non-negative");
  const isActive = options.idleOnly ? (await import("./run.js")).isRunActive : () => false;
  let count = 0;
  try { for (const info of await listSandboxes(provider, options)) if (Date.now() - info.createdAt >= (options.olderThanMs ?? 0)) { if (options.idleOnly) {
      if (isActive(provider.name, info.id)) continue;
      let box;
      try { box = await connectSandbox(provider, info.id); } catch (error) { if (error instanceof SandboxError && error.code === "not_found") { count++; continue; } throw error; }
      try { if ((await box.processes()).some(process => process.status === "running" || process.status === "starting") || (await box.files.exists("/tmp/.sandbox-sdk/runs") && (await box.files.list("/tmp/.sandbox-sdk/runs")).length > 0)) continue; }
      finally { await box.close(); }
    }
    if (isActive(provider.name, info.id)) continue;
    await provider.destroy(info.id); count++; } return count; }
  catch (error) { throw new Redactor().error(error, provider.name); }
}
