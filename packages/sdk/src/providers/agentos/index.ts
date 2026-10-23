/** agentOS Core 0.4.1, verified against its published .d.ts (not the hosted API).
 * https://rivet.dev/agentos/docs/embedded
 * https://rivet.dev/agentos/docs/processes
 * https://rivet.dev/agentos/docs/filesystem
 * https://rivet.dev/agentos/docs/networking
 * https://rivet.dev/agentos/docs/software
 * https://github.com/rivet-dev/agentos
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { AgentOs, AgentOsOptions, VirtualStat } from "@rivet-dev/agentos-core";
import type { Provider, SandboxInfo, FileInfo } from "../../provider.js";
import { agentosError, failure } from "./errors.js";

export interface AgentosOptions {
  /** Trusted local .aospkg file; otherwise install Rivet's pinned Git release. */
  gitPackagePath?: string;
}
type AgentosCapability = "network-policy";
type Entry = { vm: AgentOs; info: SandboxInfo };
// Embedded identity is scoped to this module in this JS process, across factories.
const entries = new Map<string, Entry>();
const keys = new Map<string, Promise<SandboxInfo>>();
const destroying = new Map<string, Promise<void>>();
const gitDigest = "sha256:35ae142556050de3604342574494373c318adff3ac3b50ea6b7420c0a033d2d8";
const gitUrl = `https://releases.rivet.dev/agent-os/0.4.1/software/packages/git/${gitDigest.slice(7)}.aospkg`;
function entry(id: string): Entry {
  const value = entries.get(id);
  if (!value) throw failure("Sandbox does not exist in this application process", "not_found", id);
  return value;
}
function info(value: SandboxInfo): SandboxInfo { return { ...value, labels: { ...value.labels } }; }
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
function stat(path: string, value: VirtualStat): FileInfo {
  return { path, type: value.isSymbolicLink ? "symlink" : value.isDirectory ? "directory" : "file", size: value.size, modifiedAt: value.mtimeMs };
}

// filesystem.stat follows links in 0.4.1. Use directory entry flags first,
// then Node lstat only for links so dangling links never follow their targets.
async function fileStat(vm: AgentOs, path: string, symbolic?: boolean): Promise<FileInfo> {
  const isLink = symbolic ?? (path !== "/" && (await vm.filesystem.readdirEntries(posix.dirname(path))).find(item => item.name === posix.basename(path))?.isSymbolicLink);
  if (!isLink) return stat(path, await vm.filesystem.stat(path));
  const result = await vm.javascript.evaluate(`(() => { const s = require("node:fs").lstatSync(${JSON.stringify(path)}); return { size: s.size, modifiedAt: s.mtimeMs }; })()`);
  if (result.outcome !== "succeeded" || !result.value || typeof result.value !== "object" || Array.isArray(result.value) || typeof result.value.size !== "number" || typeof result.value.modifiedAt !== "number") throw failure("agentOS could not read symbolic link metadata", "provider");
  return { path, type: "symlink", size: result.value.size, modifiedAt: result.value.modifiedAt };
}

export type AgentosProvider = Provider<AgentOs, AgentosCapability>;
/** Embedded, Docker-free V8/WebAssembly runtime. Docker remains local()'s default. */
export function agentos(options: AgentosOptions = {}): AgentosProvider {
  let module: Promise<typeof import("@rivet-dev/agentos-core")> | undefined;
  const sdk = () => module ??= import("@rivet-dev/agentos-core").catch(() => { throw failure("Install @rivet-dev/agentos-core@0.4.1 and its platform sidecar package", "unavailable"); });
  async function safe<T>(id: string, action: (vm: AgentOs) => Promise<T>, file = false): Promise<T> {
    try { return await action(entry(id).vm); } catch (error) { throw agentosError(error, id, file); }
  }
  const provider: AgentosProvider = {
    name: "agentos", inlineActivity: true, keyMode: "exact", processMode: "unsupported", capabilities: new Set<AgentosCapability>(["network-policy"]),
    async create(input) {
      if (input.size !== undefined || input.from !== undefined) throw failure("agentOS cannot enforce machine sizes or restore SDK snapshots", "unsupported");
      if (input.idleTimeoutMs !== undefined || input.timeoutMs !== undefined) throw failure("agentOS adapter does not enforce sandbox lifetime or idle deadlines", "unsupported");
      if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
      const network = input.network ?? "all";
      let permissions: AgentOsOptions["permissions"] = { network: network === "none" ? "deny" : "allow" };
      if (typeof network === "object") {
        // Reject permission-pattern metacharacters rather than broaden an allow-list.
        for (const host of network.allow) if (!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) throw failure("Network allow-list entries must be literal hostnames", "unsupported");
        permissions = { network: { default: "deny", rules: network.allow.map(host => ({ mode: "allow", operations: ["*"], patterns: [`dns://${host}`, `tcp://${host}:*`] })) } };
      }
      async function create(): Promise<SandboxInfo> {
        let vm: AgentOs | undefined;
        try {
          const { AgentOs } = await sdk();
          vm = await AgentOs.create({ permissions, ...(Object.keys(input.env ?? {}).length ? { environment: { PATH: "/opt/agentos/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/home/agentos", ...input.env } } : {}) });
          await vm.software.install(options.gitPackagePath ? { type: "path", path: options.gitPackagePath } : { type: "url", url: gitUrl, expectedDigest: gitDigest });
          await vm.filesystem.mkdir("/workspace", { recursive: true });
          if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
          const created: SandboxInfo = { id: `agentos-${randomUUID()}`, key: input.key, labels: { ...input.labels, "sandbox-sdk": "1" }, state: "running", createdAt: Date.now() };
          entries.set(created.id, { vm, info: created });
          return info(created);
        } catch (error) { if (vm) await vm.dispose().catch(() => {}); throw agentosError(error); }
      }
      if (!input.key) return create();
      const current = await provider.find(input.key); if (current) throw failure("Key already exists in this application process", "invalid_argument");
      const pending = keys.get(input.key); if (pending) { await pending; throw failure("Key was created concurrently in this application process", "invalid_argument"); }
      const task = create(); keys.set(input.key, task);
      try { return await task; } finally { keys.delete(input.key); }
    },
    async find(key) { for (const value of entries.values()) if (value.info.key === key) return info(value.info); return undefined; },
    async connect(id) { return info(entry(id).info); },
    async list(labels) { return [...entries.values()].filter(value => Object.entries(labels).every(([key, label]) => value.info.labels[key] === label)).map(value => info(value.info)); },
    async destroy(id) {
      const value = entries.get(id); if (!value) return;
      const pending = destroying.get(id); if (pending) return pending;
      const task = safe(id, vm => vm.dispose()).then(() => { entries.delete(id); });
      destroying.set(id, task);
      try { await task; } finally { destroying.delete(id); }
    },
    async exec(id, input) {
      if (input.signal?.aborted) return { exitCode: null, timedOut: true };
      return safe(id, async vm => {
        const stdout = new TextDecoder(), stderr = new TextDecoder();
        // 0.4.1 shell exec does not close supplied stdin. A virtual file gives
        // every command finite input without exposing a host file or pipe.
        const inputPath = `/tmp/.sandbox-sdk/stdin-${randomUUID()}`;
        if (input.stdin !== undefined) {
          await vm.filesystem.mkdir("/tmp/.sandbox-sdk", { recursive: true });
          await vm.filesystem.writeFile(inputPath, input.stdin);
        }
        try {
          if (input.signal?.aborted) return { exitCode: null, timedOut: true };
          // Every adapter instance shares this process's VM registry, so core's
          // active-run registry also covers reconnects and output drainage.
          const result = await vm.process.exec(`exec < ${input.stdin === undefined ? "/dev/null" : quote(inputPath)}\n${input.command}`, {
            cwd: input.cwd, env: input.env, timeoutMs: input.timeoutMs, signal: input.signal,
            output: { capture: "none" },
            onStdout(data) { const text = stdout.decode(data, { stream: true }); if (text) input.onChunk({ stream: "stdout", text }); },
            onStderr(data) { const text = stderr.decode(data, { stream: true }); if (text) input.onChunk({ stream: "stderr", text }); },
          });
          for (const [stream, text] of [["stdout", stdout.decode()], ["stderr", stderr.decode()]] as const) if (text) input.onChunk({ stream, text });
          const timedOut = result.outcome === "timed_out" || result.outcome === "cancelled";
          if (!timedOut && result.exitCode === undefined) throw failure("agentOS did not report a command exit", "outcome_unknown", id);
          return { exitCode: timedOut ? null : result.exitCode ?? null, timedOut };
        } finally { if (input.stdin !== undefined) await vm.filesystem.remove(inputPath).catch(() => {}); }
      });
    },
    files: {
      writeCreatesParents: true,
      transfer: "files",
      read: (id, path) => safe(id, async vm => new Uint8Array(await vm.filesystem.readFile(path)), true),
      write: (id, path, data) => safe(id, async vm => { await vm.filesystem.mkdir(posix.dirname(path), { recursive: true }); await vm.filesystem.writeFile(path, data); }, true),
      stat: (id, path) => safe(id, async vm => fileStat(vm, path), true),
      list: (id, path) => safe(id, async vm => Promise.all((await vm.filesystem.readdirEntries(path)).map(item => fileStat(vm, posix.join(path, item.name), item.isSymbolicLink))), true),
      mkdir: (id, path) => safe(id, vm => vm.filesystem.mkdir(path, { recursive: true }), true),
      remove: (id, path, options) => safe(id, vm => vm.filesystem.remove(path, options), true),
    },
    async previewUrl(id) { entry(id); throw failure("Embedded agentOS has no preview URLs; forward HTTP with native.network.httpRequest", "unsupported", id); },
    native(id) { return entry(id).vm; },
  };
  return provider;
}
