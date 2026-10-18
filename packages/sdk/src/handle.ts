import type { Provider, SandboxInfo } from "./provider.js";
import type { CreateOptions, SandboxBase } from "./types.js";
import { Redactor, SandboxError, invalid } from "./errors.js";
import { makeRun, quote } from "./run.js";
import { makeFiles } from "./files.js";
import { makeGit } from "./git.js";
import { makeProcesses } from "./processes.js";
export async function makeHandle<N>(provider: Provider<N>, info: SandboxInfo, created: boolean, options: CreateOptions, redactor: Redactor): Promise<SandboxBase<N>> {
  let closed = false; let destroyed = false; let commands = 0; let bytesOut = 0;
  const check = () => { if (closed || destroyed) throw new SandboxError("Sandbox handle is closed. Local resources were detached. Connect a new handle.", { code: "not_found", provider: provider.name, sandboxId: info.id }); };
  const files = makeFiles(provider, info.id, redactor);
  const recovered: Record<string, string> = {};
  const namesPath = "/tmp/.sandbox-sdk/secret-names.json";
  if (created) {
    await files.mark("start");
    await files.write(namesPath, JSON.stringify(Object.keys(options.secrets ?? {})));
  } else if (await files.exists(namesPath)) {
    const names: unknown = JSON.parse(await files.read(namesPath));
    if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) invalid("Invalid secret names record");
    for (const name of names) {
      if (typeof name !== "string") continue;
      let secret = "";
      await provider.exec(info.id, { command: `printenv ${quote(name)}`, cwd: "/workspace", env: {}, timeoutMs: 10_000, onChunk(chunk) { if (chunk.stream === "stdout") secret += chunk.text; } });
      recovered[name] = secret.replace(/\n$/, ""); redactor.add([recovered[name]]);
    }
  }
  const baseEnv = { ...recovered, ...options.env, ...options.secrets };
  const run = makeRun(provider, info.id, redactor, baseEnv, bytes => { commands++; bytesOut += bytes; });
  const processes = makeProcesses(provider, info.id, files, redactor, baseEnv);
  const safe = async <T>(action: () => Promise<T>) => { check(); try { return await action(); } catch (error) { throw redactor.error(error, provider.name, info.id); } };
  const box: SandboxBase<N> = {
    id: info.id, key: info.key, provider: provider.name, created, labels: info.labels, capabilities: new Set(provider.capabilities),
    get native() { check(); return provider.native(info.id); },
    run(command, options) { check(); return run(command, options); },
    $(strings, ...values) { check(); return run(strings.reduce((command, part, index) => command + part + (index < values.length ? quote(values[index]) : ""), "")); },
    files, git: makeGit(run, files, redactor),
    start: (command, options) => safe(() => processes.start(command, options)),
    process(name) { check(); return processes.process(name); },
    processes: () => safe(() => processes.processes()),
    preview: (port, options) => safe(() => processes.preview(port, options)),
    usage: () => safe(async () => ({ ...await provider.usage?.(info.id), createdAt: info.createdAt, runningMs: Date.now() - info.createdAt, commands, bytesOut })),
    async close() { if (closed || destroyed) return; try { await provider.close?.(info.id); closed = true; } catch (error) { throw redactor.error(error, provider.name, info.id); } },
    async destroy() { if (destroyed) return; try { await provider.destroy(info.id); destroyed = true; if (options.key) await options.locator?.delete?.(options.key); } catch (error) { throw redactor.error(error, provider.name, info.id); } },
    async [Symbol.asyncDispose]() { if (options.key) await box.close(); else await box.destroy(); },
  };
  const { pause, resume, snapshot, terminal } = provider;
  if (provider.capabilities.has("pause") && pause && resume) Object.assign(box, { pause: () => safe(() => pause.call(provider, info.id)), resume: () => safe(() => resume.call(provider, info.id)) });
  if (provider.capabilities.has("snapshot") && snapshot) Object.assign(box, { snapshot: () => safe(() => snapshot.call(provider, info.id)) });
  if (provider.capabilities.has("terminal") && terminal) Object.assign(box, { terminal: (options: { cols: number; rows: number }) => safe(() => terminal.call(provider, info.id, options)) });
  return box;
}
