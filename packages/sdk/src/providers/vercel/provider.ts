import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Readable } from "node:stream";
import type { Sandbox } from "@vercel/sandbox";
import type { Provider, CreateInput, SandboxInfo, FileInfo, ExecInput } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { quote } from "../../run.js";
import { unsupported, vercelError } from "./errors.js";
import type { NativeSandbox, VercelClient } from "./transport.js";

export interface VercelOptions { token?: string; teamId?: string; projectId?: string }
export type VercelCapability = "pause" | "snapshot" | "network-policy" | "size";
const keyTag = "sandbox-sdk-key";
const keyName = (key: string) => `sdk-${createHash("sha256").update(key).digest("hex")}`;
// Files survive a session; OS processes do not. Invalidate core-owned live records
// on every restore, including automatic restores initiated by another SDK call.
const invalidate = `for d in /tmp/.sandbox-sdk/procs/*; do [ -f "$d/spec.json" ] && [ ! -f "$d/exit" ] && printf 137 > "$d/exit"; done; rm -rf /tmp/.sandbox-sdk/runs; true`;

/** Internal injection point used by the offline SDK contract tests. */
export function createVercelProvider<N extends NativeSandbox>(load: () => Promise<VercelClient<N>>, options: VercelOptions = {}): Provider<N, VercelCapability> {
  const boxes = new Map<string, N>();
  const safe = async <T>(id: string | undefined, action: () => Promise<T>): Promise<T> => { try { return await action(); } catch (error) { throw vercelError(error, id); } };
  function credentials() {
    const token = options.token ?? process.env.VERCEL_TOKEN;
    const teamId = options.teamId ?? process.env.VERCEL_TEAM_ID;
    const projectId = options.projectId ?? process.env.VERCEL_PROJECT_ID;
    if (token) {
      if (!teamId || !projectId) throw new SandboxError("Vercel credentials are incomplete. Token authentication requires teamId and projectId. Set VERCEL_TEAM_ID and VERCEL_PROJECT_ID.", { code: "auth", provider: "vercel" });
      return { token, teamId, projectId };
    }
    // Let the SDK resolve and refresh the deployment's OIDC context. Supplying
    // partial credentials prevents that SDK path, so omit all three together.
    return {};
  }
  const clean = async (box: NativeSandbox) => { const cmd = await box.runCommand({ cmd: "sh", args: ["-c", invalidate], detached: true }); if ((await cmd.wait()).exitCode !== 0) throw new Error("Could not invalidate restored processes"); };
  const native = (id: string): N => { const box = boxes.get(id); if (!box) throw new SandboxError("Sandbox is not attached. No local native object exists. Connect the sandbox first.", { code: "not_found", provider: "vercel", sandboxId: id }); return box; };
  function info(box: N): SandboxInfo {
    const labels = { ...box.tags }; const key = labels[keyTag]; delete labels[keyTag];
    return { id: box.name, key, labels, createdAt: box.createdAt.getTime(), state: box.status === "running" || box.status === "pending" ? "running" : box.status === "stopped" ? "paused" : "stopped" };
  }
  const attach = async (id: string, resume = false) => {
    const client = await load(); let box = await client.get({ ...credentials(), name: id, resume, onResume: clean });
    const deadline = Date.now() + 60_000;
    while (box.tags?.["sandbox-sdk"] === "pending") {
      if (Date.now() >= deadline) throw new SandboxError("Sandbox initialization is incomplete. The creator has not finished setup. Retry connection later.", { code: "unavailable", provider: "vercel", sandboxId: id, retryable: true });
      await new Promise(resolve => setTimeout(resolve, 25));
      box = await client.get({ ...credentials(), name: id, resume: false, onResume: clean });
    }
    boxes.set(id, box); return box;
  };
  const get = async (id: string) => boxes.get(id) ?? attach(id);
  function resources(size: CreateInput["size"]) {
    if (size === undefined) return undefined;
    if (typeof size === "string") return { vcpus: { small: 1, medium: 2, large: 4 }[size] };
    unsupported("Custom sizes are unavailable; Vercel exposes only vCPUs with 2048 MiB RAM per vCPU and no disk allocation control");
  }
  const fileInfo = async (id: string, path: string): Promise<FileInfo> => {
    const stat = await (await get(id)).fs.lstat(path);
    return { path, type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file", size: stat.size, modifiedAt: stat.mtimeMs };
  };
  async function launch(box: N, input: ExecInput, timeoutMs: number) {
    const path = `/tmp/sandbox-sdk-${crypto.randomUUID()}.pid`;
    // GNU timeout owns this new session's process group. Its remote timer
    // survives client loss and leaves no sleeping watchdog behind on success.
    const wrapper = `echo $$ > ${quote(path)}; exec timeout --signal=KILL ${timeoutMs / 1000}s sh -c ${quote(input.command)}`;
    const command = await box.runCommand({ cmd: "setsid", args: ["--wait", "sh", "-c", wrapper], cwd: input.cwd, env: input.env, stdin: input.stdin === undefined ? false : Readable.from([input.stdin]), detached: true });
    let pid: number | undefined;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { pid = Number((await box.fs.readFile(path)).toString()); if (Number.isInteger(pid) && pid > 0) break; } catch (error) { if (vercelError(error, box.name).code !== "file_not_found") throw error; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (!pid || !Number.isInteger(pid)) { await command.kill("SIGKILL"); throw new SandboxError("Command launch could not be confirmed. Remote process ID was unavailable. Reconnect and inspect the sandbox.", { code: "outcome_unknown", provider: "vercel" }); }
      await box.fs.rm(path, { force: true });
    } catch (error) {
      // A failed PID read/removal must not strand a detached command. Recover
      // the remote PID in a separate control command when the read failed.
      const target = pid && Number.isInteger(pid) && pid > 0 ? String(pid) : `$(cat ${quote(path)})`;
      const control = await box.runCommand({ cmd: "sh", args: ["-c", `pid=${target}; case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -KILL -"$pid" 2>/dev/null || true`], detached: true });
      if ((await control.wait()).exitCode !== 0) throw new SandboxError("Command launch cleanup could not be confirmed. The remote PID is unavailable. Inspect or destroy the sandbox.", { code: "outcome_unknown", provider: "vercel", sandboxId: box.name });
      await command.wait(); throw error;
    }
    const group = pid;
    const kill = async (signal: "KILL" | "TERM") => {
      const control = await box.runCommand({ cmd: "sh", args: ["-c", `kill -${signal} -${group} 2>/dev/null || true`], detached: true }); await control.wait();
    };
    return { command, pid, kill };
  }
  const provider: Provider<N, VercelCapability> = {
    name: "vercel", keyMode: "exact", capabilities: new Set<VercelCapability>(["pause", "snapshot", "network-policy", "size"]), native,
    create: input => safe(undefined, async () => {
      if (input.timeoutMs !== undefined) unsupported("A hard lifetime across persistent sessions is unavailable; Vercel timeout resets on resume");
      if (input.idleTimeoutMs !== undefined) unsupported("idleTimeoutMs is not exposed by the Vercel SDK");
      const tags = { ...input.labels, "sandbox-sdk": "1", ...(input.key === undefined ? {} : { [keyTag]: input.key }) };
      if (Object.keys(tags).length > 5) unsupported("Vercel supports at most five tags, including sandbox-sdk and sandbox-sdk-key");
      if (new Set(input.ports).size > 15) unsupported("Vercel supports at most fifteen declared ports");
      const common = { ...credentials(), name: input.key === undefined ? `sdk-${crypto.randomUUID()}` : keyName(input.key), persistent: true, env: input.env, tags, ports: input.ports, resources: resources(input.size), networkPolicy: input.network === "none" ? "deny-all" : typeof input.network === "object" ? { allow: input.network.allow } : "allow-all", signal: input.signal, onResume: clean } satisfies Parameters<typeof Sandbox.create>[0];
      const pending = { ...common, tags: { ...tags, "sandbox-sdk": "pending" } };
      const box = await (await load()).create(input.from ? { ...pending, source: { type: "snapshot", snapshotId: input.from } } : pending);
      boxes.set(box.name, box);
      try {
        const init = await box.runCommand({ cmd: "sh", args: ["-c", "mkdir -p /workspace && chmod 777 /workspace"], sudo: true, detached: true });
        if ((await init.wait()).exitCode !== 0) throw new Error("Could not initialize /workspace");
        if (input.from) await clean(box);
        await box.update({ tags });
        return info(box);
      } catch (error) { await box.delete(); boxes.delete(box.name); throw error; }
    }),
    find: key => safe(undefined, async () => { try { const box = await attach(keyName(key)); return box.tags?.["sandbox-sdk"] === "1" && box.tags[keyTag] === key ? info(box) : undefined; } catch (error) { if (vercelError(error).code === "not_found") return undefined; throw error; } }),
    connect: id => safe(id, async () => info(await attach(id))),
    list: labels => safe(undefined, async () => { const result: SandboxInfo[] = []; for await (const entry of await (await load()).list({ ...credentials(), tags: { "sandbox-sdk": "1" } })) {
      try {
        const item = info(await attach(entry.name));
        if (item.labels["sandbox-sdk"] === "1" && Object.entries(labels).every(([k, v]) => item.labels[k] === v)) result.push(item);
      } catch (error) { if (vercelError(error, entry.name).code !== "not_found") throw error; }
    } return result; }),
    destroy: id => safe(id, async () => { try { await (await get(id)).delete(); } catch (error) { if (vercelError(error).code !== "not_found") throw error; } boxes.delete(id); }),
    exec: (id, input) => safe(id, async () => {
      if (input.signal?.aborted) return { exitCode: null, timedOut: true };
      const started = Date.now(); const box = await get(id); const task = await launch(box, input, input.timeoutMs);
      let timedOut = false; let stopping: Promise<void> | undefined;
      const abort = () => { timedOut = true; stopping ??= task.kill("KILL"); void stopping.catch(() => {}); };
      input.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, Math.max(0, input.timeoutMs - (Date.now() - started)));
      if (input.signal?.aborted) abort();
      try {
        const logs = (async () => { for await (const chunk of task.command.logs()) input.onChunk({ stream: chunk.stream, text: chunk.data }); })();
        const [exit] = await Promise.all([task.command.wait(), logs]);
        // The remote watchdog also enforces the deadline if this client disconnects.
        if (exit.exitCode === 137 && Date.now() - started >= input.timeoutMs) timedOut = true;
        await stopping;
        return { exitCode: timedOut ? null : exit.exitCode, timedOut };
      } catch (error) { await task.kill("KILL"); await task.command.wait(); throw error; }
      finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
    }),
    files: {
      read: (id, path) => safe(id, async () => new Uint8Array(await (await get(id)).fs.readFile(path))),
      write: (id, path, data) => safe(id, async () => { const box = await get(id); await box.fs.mkdir(posix.dirname(path), { recursive: true }); await box.fs.writeFile(path, data); }),
      stat: (id, path) => safe(id, () => fileInfo(id, path)),
      list: (id, path) => safe(id, async () => Promise.all((await (await get(id)).fs.readdir(path)).map(name => fileInfo(id, posix.join(path, name))))),
      mkdir: (id, path) => safe(id, async () => { await (await get(id)).fs.mkdir(path, { recursive: true }); }),
      remove: (id, path, settings) => safe(id, async () => { await (await get(id)).fs.rm(path, { recursive: settings.recursive }); }),
    },
    previewUrl: (id, port) => safe(id, async () => { const box = await get(id); if (!box.routes.some(route => route.port === port)) throw new SandboxError(`Port ${port} was not declared at creation. Vercel needs ports in CreateInput. Recreate with ports: [${port}].`, { code: "invalid_argument", provider: "vercel", sandboxId: id }); return { url: box.domain(port) }; }),
    close: async id => { boxes.delete(id); },
    pause: id => safe(id, async () => { await (await get(id)).stop(); }),
    resume: id => safe(id, async () => { await attach(id, true); }),
    snapshot: id => safe(id, async () => ({ id: (await (await get(id)).snapshot()).snapshotId })),
  };
  return provider;
}
