/** Official API references (railway 3.16.0):
 * https://docs.railway.com/sandboxes
 * https://docs.railway.com/sandboxes/quickstart
 * https://docs.railway.com/integrations/api
 * https://github.com/railwayapp/railway-ts-sdk
 * Calls and pagination fields also checked against railway/dist/index.d.ts and
 * its generated RailwaySandboxes query. No control-plane labels API exists;
 * discovery reads a versioned marker file from each running VM instead.
 */
import { posix } from "node:path";
import type { Sandbox, SandboxTemplate, CreateOptions } from "railway";
import type { Provider, SandboxInfo, Labels, FileInfo, ExecInput } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { railwayError, unsupported } from "./errors.js";

export type RailwayOptions = Pick<CreateOptions, "token" | "environmentId" | "region" | "networkIsolation" | "authType"> &
  ({ template?: SandboxTemplate; checkpoint?: never } | { template?: never; checkpoint?: string });
const marker = "/tmp/.sandbox-sdk/railway.json";
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
type Metadata = { version: 1; key?: string; labels: Labels };
function metadata(text: string): Metadata {
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new SandboxError("Invalid Railway SDK metadata", { code: "not_found", provider: "railway" }); }
  if (typeof data !== "object" || data === null || !("version" in data) || data.version !== 1 || !("labels" in data) || typeof data.labels !== "object" || data.labels === null || Array.isArray(data.labels) || ("key" in data && data.key !== undefined && typeof data.key !== "string")) throw new SandboxError("Invalid Railway SDK metadata", { code: "not_found", provider: "railway" });
  const labels: Labels = {};
  for (const [key, value] of Object.entries(data.labels)) { if (typeof value !== "string") throw new SandboxError("Invalid Railway SDK label", { code: "not_found", provider: "railway" }); Object.defineProperty(labels, key, { value, enumerable: true }); }
  return { version: 1, key: "key" in data && typeof data.key === "string" ? data.key : undefined, labels };
}
function info(box: Sandbox, data: Metadata): SandboxInfo {
  const createdAt = Date.parse(box.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error("Invalid Railway creation time");
  return { id: box.id, key: data.key, labels: data.labels, state: box.status === "RUNNING" ? "running" : "stopped", createdAt };
}

export function railway(options: RailwayOptions = {}): Provider<Sandbox, "snapshot"> {
  let module: Promise<typeof import("railway")> | undefined;
  const sdk = () => module ??= import("railway");
  const api = () => ({ token: options.token ?? process.env.RAILWAY_API_TOKEN, environmentId: options.environmentId ?? process.env.RAILWAY_ENVIRONMENT_ID, authType: options.authType });
  const clients = new Map<string, Sandbox>();
  async function call<T>(id: string | undefined, action: () => Promise<T>): Promise<T> { try { return await action(); } catch (cause) { throw railwayError(cause, id); } }
  async function client(id: string) {
    const cached = clients.get(id); if (cached) return cached;
    const { Sandbox } = await sdk(); const box = await Sandbox.connect(id, api()); clients.set(id, box); return box;
  }
  // The SDK list() drops pageInfo. Read IDs through the same documented public
  // GraphQL connection, then use SDK clients for all sandbox operations.
  async function ids(): Promise<string[]> {
    const config = api();
    if (!config.token || !config.environmentId) throw new SandboxError("Railway credentials are missing. Both token and environment ID are required. Set RAILWAY_API_TOKEN and RAILWAY_ENVIRONMENT_ID.", { code: "auth", provider: "railway" });
    const result: string[] = []; let after: string | null = null;
    do {
      const response = await fetch((await sdk()).DEFAULT_RAILWAY_GRAPHQL_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", ...(config.authType === "project-token" ? { "Project-Access-Token": config.token } : { Authorization: `Bearer ${config.token}` }) }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ query: "query SandboxSdkRailwayList($environmentId: String!, $after: String) { sandboxes(environmentId: $environmentId, first: 100, after: $after) { edges { node { id } } pageInfo { hasNextPage endCursor } } }", variables: { environmentId: config.environmentId, after } }),
      });
      if (!response.ok) throw Object.assign(new Error("Railway list failed"), { status: response.status });
      const data: unknown = await response.json();
      if (typeof data !== "object" || data === null || ("errors" in data && data.errors) || !("data" in data) || typeof data.data !== "object" || data.data === null || !("sandboxes" in data.data)) throw new Error("Invalid Railway list response");
      const connection = data.data.sandboxes;
      if (typeof connection !== "object" || connection === null || !("edges" in connection) || !Array.isArray(connection.edges) || !("pageInfo" in connection)) throw new Error("Invalid Railway connection");
      for (const edge of connection.edges) {
        if (typeof edge !== "object" || edge === null || !("node" in edge) || typeof edge.node !== "object" || edge.node === null || !("id" in edge.node) || typeof edge.node.id !== "string") throw new Error("Invalid Railway sandbox ID");
        result.push(edge.node.id);
      }
      const page = connection.pageInfo;
      if (typeof page !== "object" || page === null || !("hasNextPage" in page) || typeof page.hasNextPage !== "boolean") throw new Error("Invalid Railway pagination");
      if (!page.hasNextPage) break;
      if (!("endCursor" in page) || typeof page.endCursor !== "string" || !page.endCursor || page.endCursor === after) throw new Error("Missing Railway cursor");
      after = page.endCursor;
    } while (after !== null);
    return result;
  }
  async function execute(id: string, input: ExecInput) {
    if (input.signal?.aborted) return { exitCode: null, timedOut: true };
    const box = await client(id);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, input.timeoutMs);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    try {
      const handle = box.exec(input.command, { cwd: input.cwd, env: input.env, stdin: input.stdin !== undefined, ephemeral: true, captureOutput: false, signal: controller.signal, onStdout: text => input.onChunk({ stream: "stdout", text }), onStderr: text => input.onChunk({ stream: "stderr", text }) });
      const completion = Promise.resolve(handle); void completion.catch(() => {});
      try {
        if (input.stdin !== undefined) {
          try { await handle.stdin.write(input.stdin); await handle.stdin.end(); }
          catch {
            // Railway rejects pending writes when a command exits before reading
            // all input. A confirmed exit is authoritative, even after EPIPE.
            // If it is still running, the deadline/abort signal bounds this wait.
            await completion;
          }
        }
        const result = await completion;
        if (result.timedOut && result.exitCode === null) { await provider.destroy(id); }
        return { exitCode: result.timedOut ? null : result.exitCode, timedOut: result.timedOut };
      } catch (cause) {
        // The SDK rejects abort only after confirmed group termination. Any
        // transport failure leaves outcome unknown: destroy the VM before return.
        if (controller.signal.aborted) {
          if (cause !== controller.signal.reason) await provider.destroy(id);
          await completion.catch(() => {});
          return { exitCode: null, timedOut: true };
        }
        if (railwayError(cause, id).code === "outcome_unknown") await provider.destroy(id);
        throw cause;
      }
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
  }
  async function stat(id: string, path: string): Promise<FileInfo> {
    let output = "";
    const result = await execute(id, { command: `stat -c '%f %s %Y' -- ${quote(path)}`, cwd: "/", env: {}, timeoutMs: 30_000, onChunk: chunk => { if (chunk.stream === "stdout") output += chunk.text; } });
    if (result.exitCode !== 0) {
      // Native stat distinguishes missing files from transport/permission errors.
      await (await client(id)).files.stat(path);
      throw new Error("Railway stat command failed");
    }
    const [modeText, sizeText, timeText] = output.trim().split(/\s+/);
    const mode = Number.parseInt(modeText ?? "", 16); const size = Number(sizeText); const modifiedAt = Number(timeText) * 1000;
    if (![mode, size, modifiedAt].every(Number.isFinite)) throw new Error("Invalid Railway stat output");
    return { path, type: (mode & 0xf000) === 0xa000 ? "symlink" : (mode & 0xf000) === 0x4000 ? "directory" : "file", size, modifiedAt };
  }
  const provider: Provider<Sandbox, "snapshot"> = {
    name: "railway", commandShell: "bash", keyMode: "best-effort", capabilities: new Set(["snapshot"]),
    create: input => call(undefined, async () => {
      if (input.size !== undefined) unsupported("Railway resources set CPU and memory but cannot set diskGb; size presets and exact sizes are unavailable");
      if (input.network !== undefined && input.network !== "all") unsupported("Railway isolation modes retain outbound internet access");
      if (input.timeoutMs !== undefined) unsupported("Railway has no hard sandbox lifetime; idle destruction is not a lifetime limit");
      if (input.signal?.aborted) throw new SandboxError("Creation aborted. The signal was cancelled. Retry with a fresh signal.", { code: "aborted", provider: "railway" });
      if (input.ports && (input.ports.length > 10 || new Set(input.ports).size !== input.ports.length)) unsupported("Railway accepts at most 10 unique preview ports");
      if (input.ports?.length && options.networkIsolation === "ISOLATED") unsupported("Public domains require PRIVATE networking");
      if (input.idleTimeoutMs !== undefined && (!Number.isFinite(input.idleTimeoutMs) || input.idleTimeoutMs <= 0)) throw new SandboxError("Invalid idle timeout. A positive duration is required. Set idleTimeoutMs above zero.", { code: "invalid_argument", provider: "railway" });
      const { Sandbox } = await sdk();
      const config: CreateOptions = { ...api(), region: options.region, env: input.env, idleTimeoutMinutes: input.idleTimeoutMs === undefined ? undefined : Math.ceil(input.idleTimeoutMs / 60_000), networkIsolation: input.ports?.length ? "PRIVATE" : options.networkIsolation, domains: input.ports?.map(port => ({ port })) };
      const source = input.from ?? options.checkpoint ?? options.template;
      const box = source === undefined ? await Sandbox.create(config) : typeof source === "string" ? await Sandbox.create(source, config) : await Sandbox.create(source, config);
      clients.set(box.id, box);
      try {
        if (input.signal?.aborted) throw new SandboxError("Creation aborted. Cancellation arrived while provisioning. Retry with a fresh signal.", { code: "aborted", provider: "railway" });
        const data: Metadata = { version: 1, key: input.key, labels: { ...input.labels, "sandbox-sdk": "1" } };
        await box.files.mkdir("/workspace");
        if (source !== undefined) {
          // Checkpoints preserve files, not processes. Invalidate inherited PIDs
          // before a restored record can signal an unrelated process in this VM.
          const result = await execute(box.id, { command: `for d in /tmp/.sandbox-sdk/procs/*; do [ -f "$d/spec.json" ] && [ ! -f "$d/exit" ] && printf 137 > "$d/exit"; done; rm -rf /tmp/.sandbox-sdk/runs; true`, cwd: "/", env: {}, timeoutMs: 30_000, onChunk() {} });
          if (result.timedOut || result.exitCode !== 0) throw new Error("Railway checkpoint process cleanup failed");
        }
        await box.files.write(marker, JSON.stringify(data));
        return info(box, data);
      } catch (cause) { await provider.destroy(box.id); throw cause; }
    }),
    connect: id => call(id, async () => { const { Sandbox } = await sdk(); const box = await Sandbox.connect(id, api()); clients.set(id, box); return info(box, metadata(await box.files.read(marker))); }),
    find: key => call(undefined, async () => (await provider.list({})).find(box => box.key === key)),
    list: labels => call(undefined, async () => {
      const result: SandboxInfo[] = [];
      for (const id of await ids()) {
        try {
          const { Sandbox } = await sdk(); const box = await Sandbox.connect(id, api());
          if (box.status !== "RUNNING") continue;
          const data = metadata(await box.files.read(marker));
          if (data.labels["sandbox-sdk"] === "1" && Object.entries(labels).every(([key, value]) => data.labels[key] === value)) result.push(info(box, data));
        } catch (cause) { if (!["not_found", "file_not_found"].includes(railwayError(cause, id).code)) throw cause; }
      }
      return result;
    }),
    destroy: id => call(id, async () => { try { await (await client(id)).destroy(); } catch (cause) { if (railwayError(cause, id).code !== "not_found") throw cause; } clients.delete(id); }),
    close: async id => { clients.delete(id); },
    native(id) { const box = clients.get(id); if (!box) throw new SandboxError("Sandbox client is detached. No cached Railway object exists. Connect first.", { code: "not_found", provider: "railway", sandboxId: id }); return box; },
    exec: (id, input) => call(id, () => execute(id, input)),
    files: {
      writeCreatesParents: true,
      read: (id, path) => call(id, async () => (await client(id)).files.read(path, { format: "bytes" })),
      readRange: (id, path, range) => call(id, async () => range.length === 0 ? new Uint8Array() : (await client(id)).files.read(path, { format: "bytes", ...range })),
      write: (id, path, data) => call(id, async () => { await (await client(id)).files.write(path, data); }),
      mkdir: (id, path) => call(id, async () => { await (await client(id)).files.mkdir(path); }),
      stat: (id, path) => call(id, () => stat(id, path)),
      list: (id, path) => call(id, async () => { const entries = await (await client(id)).files.list(path); const result: FileInfo[] = []; for (const entry of entries) result.push(await stat(id, posix.join(path, entry.name))); return result; }),
      remove: (id, path, opts) => call(id, async () => {
        const box = await client(id);
        if (!opts.recursive) { await box.files.remove(path); return; }
        const result = await execute(id, { command: `rm -rf -- ${quote(path)}`, cwd: "/", env: {}, timeoutMs: 30_000, onChunk() {} });
        if (result.exitCode !== 0) throw new Error("Railway recursive removal failed");
      }),
    },
    previewUrl: (id, port) => call(id, async () => {
      const box = await client(id); const domain = box.domains.find(domain => domain.port === port);
      if (!domain) unsupported("The preview port was not declared at creation; pass ports to createSandbox");
      return { url: `https://${domain.domain}` };
    }),
    snapshot: id => call(id, async () => ({ id: (await (await client(id)).checkpoint(`sandbox-sdk-${crypto.randomUUID()}`)).key })),
  };
  return provider;
}
