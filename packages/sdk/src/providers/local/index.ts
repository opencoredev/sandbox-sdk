import { createHash, randomUUID } from "node:crypto";
import type { Provider, SandboxInfo, FileInfo, CreateInput } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { Docker, object, string, number, array, encode, failure, parse } from "./docker.js";

export interface LocalOptions { image?: string; dockerHost?: string }
export interface LocalNative { readonly id: string; readonly client: Docker }
type LocalCapability = "pause" | "snapshot" | "size" | "network-policy";
const keyLabel = "sandbox-sdk.local.key";
const name = (key: string) => `sandbox-sdk-${createHash("sha256").update(key).digest("hex")}`;
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const presets = { small: { cpu: 1, memoryMb: 1024 }, medium: { cpu: 2, memoryMb: 4096 }, large: { cpu: 4, memoryMb: 8192 } };
function limits(size: CreateInput["size"]) {
  if (!size) return {};
  if (typeof size !== "string") throw failure("Custom sizes include diskGb, which Docker cannot enforce portably; use small, medium, or large", "unsupported");
  const value = presets[size];
  if (!value) throw failure("Unknown size preset", "unsupported");
  return { NanoCpus: value.cpu * 1e9, Memory: value.memoryMb * 1024 * 1024, MemorySwap: value.memoryMb * 1024 * 1024 };
}
function info(value: unknown): SandboxInfo {
  const raw = object(value); const config = object(raw.Config); const state = object(raw.State);
  const labels = Object.fromEntries(Object.entries(object(config.Labels ?? {})).map(([k, v]) => [k, string(v)]));
  if (labels["sandbox-sdk"] !== "1") throw failure("Container was not created by Sandbox SDK", "not_found");
  return { id: string(raw.Id), key: labels[keyLabel] || undefined, labels, state: state.Paused ? "paused" : state.Running ? "running" : "stopped", createdAt: Date.parse(string(raw.Created)) };
}
/** Local Docker Engine transport. No Docker CLI or daemon inside the container. */
export function local(options: LocalOptions = {}): Provider<LocalNative, LocalCapability> {
  const client = new Docker(options.dockerHost); const image = options.image ?? "node:22-bookworm";
  const destroying = new Map<string, Promise<void>>();
  const inspect = (id: string) => client.call("GET", `/containers/${encode(id)}/json`);
  async function raw(id: string, command: string[], stdin?: string) {
    let stdout = ""; let stderr = "";
    const code = await client.exec(id, command, { stdin, onChunk(chunk) { if (chunk.stream === "stdout") stdout += chunk.text; else stderr += chunk.text; } });
    if (code !== 0) throw failure(`Container operation exited ${code}: ${stderr}`, stderr.includes("ENOENT") || stderr.includes("No such file") ? "file_not_found" : "provider");
    return stdout;
  }
  const node = (id: string, script: string, args: string[] = [], stdin?: string) => raw(id, ["node", "-e", script, ...args], stdin);
  const statScript = `const fs=require('fs'); const p=require('path'); const stat=x=>{const s=fs.lstatSync(x);return {path:x,type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':'file',size:s.size,modifiedAt:s.mtimeMs}};`;
  function fileInfo(value: unknown): FileInfo {
    const item = object(value); const type = item.type;
    if (type !== "file" && type !== "directory" && type !== "symlink") throw failure("Invalid file type");
    return { path: string(item.path), type, size: number(item.size), modifiedAt: number(item.modifiedAt) };
  }
  const provider: Provider<LocalNative, LocalCapability> = {
    name: "local", keyMode: "exact", capabilities: new Set<LocalCapability>(["pause", "snapshot", "size", "network-policy"]),
    async create(input) {
      if (typeof input.network === "object") throw failure("Network allow-lists cannot be enforced by this Docker adapter", "unsupported");
      if (input.idleTimeoutMs !== undefined || input.timeoutMs !== undefined) throw failure("Docker has no durable idle or lifetime timer; omit idleTimeoutMs and timeoutMs", "unsupported");
      const resources = limits(input.size);
      if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
      const source = input.from ?? image;
      try { await client.call("GET", `/images/${encode(source)}/json`); }
      catch (error) { if (!(error instanceof SandboxError) || error.code !== "not_found") throw error; if (input.from) throw failure("Snapshot image not found", "not_found"); await client.call("POST", `/images/create?fromImage=${encode(source)}`); }
      if (input.signal?.aborted) throw failure("Creation aborted after image pull", "aborted");
      const ports = [...new Set(input.ports ?? [3000])];
      const bindings = Object.fromEntries(ports.map(port => [`${port}/tcp`, [{ HostIp: "127.0.0.1", HostPort: "" }]]));
      const created = object(await client.call("POST", `/containers/create?name=${encode(input.key ? name(input.key) : `sandbox-sdk-${randomUUID()}`)}`, {
        Image: source, WorkingDir: "/workspace", Cmd: ["sh", "-c", "mkdir -p /workspace; exec sleep infinity"],
        Env: Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`), Labels: { ...input.labels, "sandbox-sdk": "1", [keyLabel]: input.key ?? "" },
        ExposedPorts: Object.fromEntries(ports.map(port => [`${port}/tcp`, {}])),
        HostConfig: { ...resources, NetworkMode: input.network === "none" ? "none" : "bridge", PortBindings: input.network === "none" ? {} : bindings, Init: true },
      }));
      const id = string(created.Id);
      try {
        await client.call("POST", `/containers/${encode(id)}/start`);
        await raw(id, ["sh", "-c", "mkdir -p /workspace; command -v node git tar setsid nohup mkfifo sed >/dev/null"]);
        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        return await provider.connect(id);
      } catch (error) { await provider.destroy(id); throw error; }
    },
    async find(key) { try { const found = await provider.connect(name(key)); return found.key === key ? found : undefined; } catch (error) { if (error instanceof SandboxError && error.code === "not_found") return undefined; throw error; } },
    async connect(id) { return info(await inspect(id)); },
    async list(labels) {
      const filters = encode(JSON.stringify({ label: Object.entries({ ...labels, "sandbox-sdk": "1" }).map(([k, v]) => `${k}=${v}`) }));
      const containers = array(await client.call("GET", `/containers/json?all=1&filters=${filters}`));
      const result: SandboxInfo[] = [];
      for (const item of containers) { try { result.push(await provider.connect(string(object(item).Id))); } catch (error) { if (!(error instanceof SandboxError) || error.code !== "not_found") throw error; } }
      return result;
    },
    async destroy(id) {
      const pending = destroying.get(id); if (pending) return pending;
      const task = (async () => {
        try {
          const current = await provider.connect(id);
          if (current.state === "paused") await client.call("POST", `/containers/${encode(id)}/unpause`);
          if (current.state !== "stopped") await client.call("POST", `/containers/${encode(id)}/stop?t=1`);
          await client.call("DELETE", `/containers/${encode(id)}?force=1&v=1`);
        } catch (error) { if (!(error instanceof SandboxError) || error.code !== "not_found") throw error; }
      })();
      destroying.set(id, task);
      try { await task; } finally { destroying.delete(id); }
    },
    async exec(id, input) {
      if (input.signal?.aborted) return { exitCode: null, timedOut: true };
      const pidfile = `/tmp/.sandbox-sdk-exec-${randomUUID()}`;
      let cancelled = false;
      const cancel = () => { cancelled = true; };
      input.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, input.timeoutMs);
      // The wrapper writes its session leader PID before running any user code.
      const command = ["setsid", "--wait", "sh", "-c", `echo $$ > ${quote(pidfile)}; exec sh -c ${quote(input.command)}`];
      let settled = false;
      const execution = client.exec(id, command, { cwd: input.cwd, env: input.env, stdin: input.stdin, onChunk: input.onChunk }).finally(() => { settled = true; });
      void execution.catch(() => {});
      try {
        while (!settled && !cancelled) await new Promise(resolve => setTimeout(resolve, 5));
        if (cancelled) {
          // Wait for the PID publication if cancellation raced exec startup. No
          // success is reported until the negative-PID kill has been delivered.
          await raw(id, ["sh", "-c", `i=0; while [ ! -s ${quote(pidfile)} ]; do i=$((i+1)); [ "$i" -lt 3000 ] || exit 1; sleep .01; done; p=$(cat ${quote(pidfile)}); node -e 'try {process.kill(-Number(process.argv[1]), "SIGKILL")} catch(e) {if(e.code!=="ESRCH") throw e}' "$p"`]);
        }
        const exitCode = await execution;
        return { exitCode: cancelled ? null : exitCode, timedOut: cancelled };
      } finally {
        clearTimeout(timer); input.signal?.removeEventListener("abort", cancel);
        await raw(id, ["rm", "-f", pidfile]).catch(() => {});
      }
    },
    files: {
      async read(id, path) { return new Uint8Array(Buffer.from(await node(id, "process.stdout.write(require('fs').readFileSync(process.argv[1]).toString('base64'))", [path]), "base64")); },
      async write(id, path, data) { await node(id, "const f=require('fs');f.mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});f.writeFileSync(process.argv[1],Buffer.from(f.readFileSync(0,'utf8'),'base64'))", [path], Buffer.from(data).toString("base64")); },
      async stat(id, path) { return fileInfo(parse(await node(id, statScript + "process.stdout.write(JSON.stringify(stat(process.argv[1])))", [path]))); },
      async list(id, path) { return array(parse(await node(id, statScript + "process.stdout.write(JSON.stringify(fs.readdirSync(process.argv[1]).map(x=>stat(p.join(process.argv[1],x)))))", [path]))).map(fileInfo); },
      async mkdir(id, path) { await node(id, "require('fs').mkdirSync(process.argv[1],{recursive:true})", [path]); },
      async remove(id, path, options) { await node(id, "require('fs').rmSync(process.argv[1],{recursive:process.argv[2]==='true'})", [path, String(options.recursive)]); },
    },
    async previewUrl(id, port) {
      const data = object(await inspect(id)); const settings = object(data.NetworkSettings); const ports = object(settings.Ports ?? {}); const binding = array(ports[`${port}/tcp`] ?? [])[0];
      if (!binding) throw failure(`Port ${port} has no localhost mapping; declare it in ports when creating the sandbox`, "unsupported");
      const entry = object(binding);
      if (entry.HostIp !== "127.0.0.1") throw failure("Preview binding is not loopback", "unsupported");
      return { url: `http://127.0.0.1:${string(entry.HostPort)}/` };
    },
    native(id) { return { id, client }; },
    async usage(id) { const value = object(await inspect(id)); const state = object(value.State); return { runningMs: state.Running && !state.Paused ? Math.max(0, Date.now() - Date.parse(string(state.StartedAt))) : 0 }; },
    async pause(id) { await provider.connect(id); await client.call("POST", `/containers/${encode(id)}/pause`); },
    async resume(id) { await provider.connect(id); await client.call("POST", `/containers/${encode(id)}/unpause`); },
    async snapshot(id) { await provider.connect(id); const value = object(await client.call("POST", `/commit?container=${encode(id)}&pause=true`, { Labels: { "sandbox-sdk": "1", "sandbox-sdk.local.snapshot": "1" } })); return { id: string(value.Id) }; },
  };
  return provider;
}
