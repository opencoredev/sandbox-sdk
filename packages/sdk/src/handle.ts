import type { Provider, SandboxInfo, Terminal } from "./provider.js";
import type { CreateOptions, SandboxBase } from "./types.js";
import { Redactor, SandboxError, invalid } from "./errors.js";
import { forgetSandbox } from "./keys.js";
import { makeRun, quote, chunkRedactor, defaults } from "./run.js";
import { makeFiles } from "./files.js";
import { makeGit } from "./git.js";
import { registerToolRedactor } from "./tool-security.js";
import { makeProcesses } from "./processes.js";
export async function makeHandle<N>(provider: Provider<N>, info: SandboxInfo, created: boolean, options: CreateOptions, redactor: Redactor): Promise<SandboxBase<N>> {
  let closed = false; let destroyed = false; let commands = 0; let bytesOut = 0;
  const check = () => { if (closed || destroyed) throw new SandboxError("Sandbox handle is closed. Local resources were detached. Connect a new handle.", { code: "not_found", provider: provider.name, sandboxId: info.id }); };
  const files = makeFiles(provider, info.id, redactor, check);
  const recovered: Record<string, string> = {};
  const namesPath = "/tmp/.sandbox-sdk/secret-names.json";
  if (created) {
    if (options.trackChanges) await files.mark("start");
    // A restored snapshot may carry the source's records. Overwrite or drop them.
    else if (options.from !== undefined) await files.remove("/tmp/.sandbox-sdk/marks/start.json").catch(() => {});
    const names = Object.keys(options.secrets ?? {});
    if (names.length || options.from !== undefined) {
      const record = JSON.stringify(names);
      if (provider.files.writeCreatesParents || provider.name === "memory") await files.write(namesPath, record);
      else {
        // Names are validated identifiers, so mkdir and write fit in one quoted exec.
        const result = await provider.exec(info.id, { command: `mkdir -p /tmp/.sandbox-sdk && printf '%s' ${quote(record)} > ${quote(namesPath)}`, cwd: "/workspace", env: defaults, timeoutMs: 10_000, onChunk() {} });
        if (result.exitCode !== 0) throw new SandboxError("Secret setup failed. Could not record secret names in /tmp/.sandbox-sdk. Ensure /tmp is writable.", { code: "provider", provider: provider.name, sandboxId: info.id });
      }
    }
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
  const run = makeRun(provider, info.id, redactor, baseEnv, bytes => { commands++; bytesOut += bytes; }, check);
  const processes = makeProcesses(provider, info.id, makeFiles(provider, info.id, redactor), redactor, baseEnv);
  const safe = async <T>(action: () => Promise<T>) => { check(); try { return await action(); } catch (error) { throw redactor.error(error, provider.name, info.id); } };
  const box: SandboxBase<N> = {
    id: info.id, key: info.key, provider: provider.name, created, labels: info.labels, capabilities: new Set(provider.capabilities),
    get native() { check(); try { return provider.native(info.id); } catch (error) { throw redactor.error(error, provider.name, info.id); } },
    run(command, options) { check(); return run(command, options); },
    $(strings, ...values) { check(); return run(strings.reduce((command, part, index) => command + part + (index < values.length ? quote(values[index]) : ""), "")); },
    files, git: makeGit((command, options) => { check(); return run(command, options); }, files, redactor),
    start: (command, options) => safe(() => processes.start(command, options)),
    process(name) { check(); return processes.process(name); },
    processes: () => safe(() => processes.processes()),
    preview: (port, options) => safe(() => processes.preview(port, options)),
    usage: () => safe(async () => ({ ...await provider.usage?.(info.id), createdAt: info.createdAt, runningMs: Date.now() - info.createdAt, commands, bytesOut })),
    async close() { if (closed || destroyed) return; try { await provider.close?.(info.id); files[Symbol.dispose](); closed = true; } catch (error) { throw redactor.error(error, provider.name, info.id); } },
    async destroy() { if (destroyed) return; try { forgetSandbox(provider, info.id); await provider.destroy(info.id); files[Symbol.dispose](); destroyed = true; if (options.key) await options.locator?.delete?.(options.key); } catch (error) { throw redactor.error(error, provider.name, info.id); } },
    async [Symbol.asyncDispose]() { if (options.key) await box.close(); else await box.destroy(); },
  };
  const { pause, resume, snapshot, terminal } = provider;
  if (provider.capabilities.has("pause") && pause && resume) Object.assign(box, { pause: () => safe(() => pause.call(provider, info.id)), resume: () => safe(() => resume.call(provider, info.id)) });
  if (provider.capabilities.has("snapshot") && snapshot) Object.assign(box, { snapshot: () => safe(() => snapshot.call(provider, info.id)) });
  if (provider.capabilities.has("terminal") && terminal) Object.assign(box, { terminal: (options: { cols: number; rows: number }) => safe(async () => {
    const raw = await terminal.call(provider, info.id, options); const cleanups = new Set<() => void>();
    const handle: Terminal = {
      write: data => safe(async () => { await raw.write(data); }),
      resize: (cols, rows) => safe(async () => { await raw.resize(cols, rows); }),
      onData(callback) {
        check(); const filter = chunkRedactor(redactor, chunk => callback(chunk.text));
        const off = raw.onData(data => filter.push({ stream: "stdout", text: data }));
        const cleanup = () => { off(); filter.flush(); cleanups.delete(cleanup); }; cleanups.add(cleanup); return cleanup;
      },
      close: () => safe(async () => { for (const cleanup of cleanups) cleanup(); await raw.close(); }),
    };
    return handle;
  }) });
  registerToolRedactor(box, redactor);
  return box;
}
