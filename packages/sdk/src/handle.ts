import type { Provider, SandboxInfo, SnapshotOptions, Terminal } from "./provider.js";
import type { CreateOptions, SandboxBase } from "./types.js";
import { Redactor, SandboxError, invalid } from "./errors.js";
import { forgetSandbox } from "./keys.js";
import { makeRun, chunkRedactor, defaults, secretRecoveryCommand } from "./run.js";
import { quote } from "./shared/shell.js";
import { isString } from "./shared/narrow.js";
import { makeFiles, removeIfPresent } from "./files.js";
import { makeGit } from "./git.js";
import { registerToolRedactor } from "./tool-security.js";
import { makeProcesses, type ProcessHandle } from "./processes.js";

/** Whether a parsed secret-names record is a list of environment variable names. */
function isNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((name) => isString(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  );
}

export async function makeHandle<N>(
  provider: Provider<N>,
  info: SandboxInfo,
  created: boolean,
  options: CreateOptions,
  redactor: Redactor,
  recoverSecrets = true,
): Promise<SandboxBase<N>> {
  let closed = false;
  let destroyed = false;
  let commands = 0;
  let bytesOut = 0;

  const check = () => {
    if (closed || destroyed)
      throw new SandboxError(
        "Sandbox handle is closed. Local resources were detached. Connect a new handle.",
        { code: "not_found", provider: provider.name, sandboxId: info.id },
      );
  };

  // Recovery reads the record and environment in one exec. It is lazy, so a handle that only
  // destroys, closes, pauses or reads usage never runs a command, even on a stopped sandbox.
  // baseEnv is shared with run and processes, which read it per command; recovery fills it in place.
  const baseEnv = { ...options.env, ...options.secrets };

  let recovery: Promise<void> | undefined =
    created || !recoverSecrets ? Promise.resolve() : undefined;

  const ready = () =>
    (recovery ??= recover().catch((error) => {
      recovery = undefined;
      throw error;
    }));

  async function recover() {
    // Values stay private to this step, and only explicitly recorded names enter the redactor/env.
    let wire = "";

    const result = await provider.exec(info.id, {
      command: secretRecoveryCommand,
      cwd: "/",
      env: {},
      timeoutMs: 10_000,
      onChunk(chunk) {
        if (chunk.stream === "stdout") wire += chunk.text;
      },
    });

    if (result.timedOut || result.exitCode !== 0)
      throw new SandboxError(
        "Secret recovery failed. Could not read the sandbox environment. Retry, or connect with recoverSecrets: false.",
        { code: "provider", provider: provider.name, sandboxId: info.id },
      );

    if (!wire) return;
    const separator = wire.indexOf("\0");

    if (separator < 0) invalid("Invalid secret recovery record");
    let names: unknown;

    try {
      names = JSON.parse(wire.slice(0, separator));
    } catch {
      throw new SandboxError(
        "Secret recovery failed. The secret names record is not valid JSON. Repair the record and reconnect.",
        { code: "provider" },
      );
    }

    if (!isNameList(names)) invalid("Invalid secret names record");
    const environment = new Map<string, string>();

    for (const entry of wire.slice(separator + 1).split("\0")) {
      const equal = entry.indexOf("=");

      if (equal >= 0) environment.set(entry.slice(0, equal), entry.slice(equal + 1));
    }

    const recovered: Record<string, string> = {};

    for (const name of names) recovered[name] = environment.get(name) ?? "";
    redactor.add(Object.values(recovered));
    Object.assign(baseEnv, recovered, options.env, options.secrets);
  }

  // Recovery can be slow, and close or destroy can land while it runs, so check again once it settles, even if it failed.
  const guard = async () => {
    check();
    await ready().finally(check);
  };

  const files = makeFiles(provider, info.id, redactor, check, ready);

  const namesPath = "/tmp/.sandbox-sdk/secret-names.json";

  if (created) {
    if (options.trackChanges) await files.mark("start");
    // A restored snapshot may carry the source's records. Overwrite or drop them.
    // A snapshot without a start mark is the usual case; any other failure would leave a stale one.
    else if (options.from !== undefined)
      await removeIfPresent(files, "/tmp/.sandbox-sdk/marks/start.json");
    const names = Object.keys(options.secrets ?? {});

    if (names.length || options.from !== undefined) {
      const record = JSON.stringify(names);

      if (provider.files.writeCreatesParents) await files.write(namesPath, record);
      else {
        // Names are validated identifiers, so mkdir and write fit in one quoted exec.
        const result = await provider.exec(info.id, {
          command: `mkdir -p /tmp/.sandbox-sdk && printf '%s' ${quote(record)} > ${quote(namesPath)}`,
          cwd: "/",
          env: defaults,
          timeoutMs: 10_000,
          onChunk() {},
        });

        if (result.exitCode !== 0)
          throw new SandboxError(
            "Secret setup failed. Could not record secret names in /tmp/.sandbox-sdk. Ensure /tmp is writable.",
            { code: "provider", provider: provider.name, sandboxId: info.id },
          );
      }
    }
  }

  const run = makeRun(
    provider,
    info.id,
    redactor,
    baseEnv,
    (bytes) => {
      commands++;
      bytesOut += bytes;
    },
    guard,
  );

  const processes = makeProcesses(
    provider,
    info.id,
    makeFiles(provider, info.id, redactor),
    redactor,
    baseEnv,
  );

  // direct skips recovery: lifecycle calls must work on a sandbox that cannot run commands.
  const direct = async <T>(action: () => Promise<T>) => {
    check();

    try {
      return await action();
    } catch (error) {
      throw redactor.error(error, provider.name, info.id);
    }
  };

  const safe = <T>(action: () => Promise<T>) =>
    direct(async () => {
      await guard();

      return action();
    });

  // Process handles read logs and env, so each call waits for recovery. One wrapper per handle keeps identity stable.
  const gated = new WeakMap<ProcessHandle, ProcessHandle>();

  const gate = (handle: ProcessHandle): ProcessHandle => {
    const known = gated.get(handle);

    if (known) return known;

    const wrapper: ProcessHandle = {
      get name() {
        return handle.name;
      },
      get url() {
        return handle.url;
      },
      get ready() {
        return handle.ready;
      },
      get status() {
        return handle.status;
      },
      logs: async (options) => {
        await direct(guard);

        return handle.logs(options);
      },
      async *lines(options) {
        await direct(guard);
        yield* handle.lines(options);
      },
      stop: async (options) => {
        await direct(guard);

        return handle.stop(options);
      },
      restart: async () => {
        await direct(guard);

        return handle.restart();
      },
      wait: async () => {
        await direct(guard);

        return handle.wait();
      },
    };

    gated.set(handle, wrapper);

    return wrapper;
  };

  const box: SandboxBase<N> = {
    id: info.id,
    key: info.key,
    provider: provider.name,
    created,
    labels: info.labels,
    capabilities: new Set(provider.capabilities),
    get native() {
      check();

      try {
        return provider.native(info.id);
      } catch (error) {
        throw redactor.error(error, provider.name, info.id);
      }
    },
    run(command, options) {
      check();

      return run(command, options);
    },
    $(strings, ...values) {
      check();

      return run(
        strings.reduce(
          (command, part, index) =>
            command + part + (index < values.length ? quote(String(values[index])) : ""),
          "",
        ),
      );
    },
    files,
    git: makeGit(
      (command, options) => {
        check();

        return run(command, options);
      },
      files,
      redactor,
    ),
    start: (command, options) => safe(async () => gate(await processes.start(command, options))),
    process(name) {
      check();

      return gate(processes.process(name));
    },
    processes: () => safe(() => processes.processes()),
    preview: (port, options) => safe(() => processes.preview(port, options)),
    usage: () =>
      direct(async () => ({
        ...(await provider.usage?.(info.id)),
        createdAt: info.createdAt,
        runningMs: Date.now() - info.createdAt,
        commands,
        bytesOut,
      })),
    async close() {
      if (closed || destroyed) return;

      try {
        await provider.close?.(info.id);
        files[Symbol.dispose]();
        closed = true;
      } catch (error) {
        throw redactor.error(error, provider.name, info.id);
      }
    },
    async destroy() {
      if (destroyed) return;

      try {
        forgetSandbox(provider, info.id);
        await provider.destroy(info.id);
        files[Symbol.dispose]();
        destroyed = true;

        if (options.key) await options.locator?.delete?.(options.key);
      } catch (error) {
        throw redactor.error(error, provider.name, info.id);
      }
    },
    async [Symbol.asyncDispose]() {
      if (options.key) await box.close();
      else await box.destroy();
    },
  };

  const { pause, resume, snapshot, terminal } = provider;

  if (provider.capabilities.has("pause") && pause && resume)
    Object.assign(box, {
      pause: () => direct(() => pause.call(provider, info.id)),
      resume: () => direct(() => resume.call(provider, info.id)),
    });

  if (provider.capabilities.has("snapshot") && snapshot)
    Object.assign(box, {
      snapshot: (options?: SnapshotOptions) =>
        direct(async () => {
          const expiresInMs = options?.expiresInMs;

          if (expiresInMs !== undefined && (!Number.isSafeInteger(expiresInMs) || expiresInMs < 0))
            invalid("expiresInMs must be a non-negative integer of milliseconds");

          return snapshot.call(provider, info.id, options);
        }),
    });

  if (provider.capabilities.has("terminal") && terminal)
    Object.assign(box, {
      terminal: (options: { cols: number; rows: number }) =>
        safe(async () => {
          const raw = await terminal.call(provider, info.id, options);
          const cleanups = new Set<() => void>();

          const handle: Terminal = {
            write: (data) =>
              safe(async () => {
                await raw.write(data);
              }),
            resize: (cols, rows) =>
              safe(async () => {
                await raw.resize(cols, rows);
              }),
            onData(callback) {
              check();
              const filter = chunkRedactor(redactor, (chunk) => callback(chunk.text));
              const off = raw.onData((data) => filter.push({ stream: "stdout", text: data }));

              const cleanup = () => {
                off();
                filter.flush();
                cleanups.delete(cleanup);
              };

              cleanups.add(cleanup);

              return cleanup;
            },
            close: () =>
              safe(async () => {
                for (const cleanup of cleanups) cleanup();
                await raw.close();
              }),
          };

          return handle;
        }),
    });
  registerToolRedactor(box, redactor);

  return box;
}
