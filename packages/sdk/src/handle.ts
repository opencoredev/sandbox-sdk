import type {
  ExtensionMethods,
  Provider,
  SandboxInfo,
  SnapshotOptions,
  Terminal,
  TerminalOptions,
} from "./provider.js";
import type { CreateOptions, SandboxBase } from "./types.js";
import { Redactor, SandboxError, invalid, scrubCredentials, withheldErrors } from "./errors.js";
import { attachHandle, detachHandle, forgetSandbox, withKeyLock } from "./keys.js";
import { makeRun, chunkRedactor, defaults, pathOf, secretRecoveryCommand } from "./run.js";
import { quote } from "./shared/shell.js";
import { isString } from "./shared/narrow.js";
import { makeFiles, removeIfPresent } from "./files.js";
import { guardNativeApi } from "./native.js";
import { makeGit } from "./git.js";
import { registerToolRedactor } from "./tool-security.js";
import {
  defaultWaitTimeoutMs,
  makeProcesses,
  waitDeadlineErrors,
  type ProcessHandle,
} from "./processes.js";
import { setLongTimeout } from "./retry.js";

/** Whether a parsed secret-names record is a list of environment variable names. */
function isNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((name) => isString(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  );
}

/** Every method an extension object offers by name, its own or inherited from its class. Reads each one. */
function methodsOf(methods: ExtensionMethods): [string, ExtensionMethods[string]][] {
  const names = new Set<string>();

  for (
    let level: object | null = methods;
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level)
  )
    for (const name of Object.getOwnPropertyNames(level))
      if (name !== "constructor") names.add(name);

  return [...names].flatMap((name) => {
    const method = methods[name];

    return method ? [[name, method]] : [];
  });
}

export async function makeHandle<N>(
  provider: Provider<N>,
  info: SandboxInfo,
  created: boolean,
  options: CreateOptions,
  redactor: Redactor,
  recoverSecrets = true,
  /** Dispose by close even without a key: the provider could not read whether the sandbox is keyed. */
  closeOnDispose = false,
): Promise<SandboxBase<N>> {
  let closed = false;
  let destroyed = false;
  let closing: Promise<void> | undefined;
  // Whether this handle still counts toward the sandbox's open handles (see attachHandle).
  let holding = false;

  /** Drop this handle's claim once. Returns whether no other open handle remains. */
  const release = () => {
    if (!holding) return false;
    holding = false;

    return detachHandle(provider, info.id);
  };

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

  // Whether the redactor knows every secret recorded at creation, for paths that skip recovery.
  let recovered = recovery !== undefined;

  const ready = () =>
    (recovery ??= recover().catch((error) => {
      recovery = undefined;
      throw error;
    }));

  const makeWithheld = (
    message: string,
    source?: SandboxError,
    hideIdentity = false,
  ): SandboxError => {
    const wrapped = new SandboxError(message, {
      code: source?.code ?? "provider",
      retryable: source?.retryable ?? false,
      retryAfterMs: source?.retryAfterMs,
      provider: hideIdentity ? "unknown" : scrubCredentials(redactor.text(provider.name)),
      sandboxId: hideIdentity || !recovered ? undefined : scrubCredentials(redactor.text(info.id)),
    });

    withheldErrors.add(wrapped);

    return wrapped;
  };

  // The names record and the environment, or undefined when there is no record. Providers
  // that offer the hook answer directly; otherwise one exec prints both.
  async function readSecretEnvironment(): Promise<
    { record: string; environment: ReadonlyMap<string, string> } | undefined
  > {
    if (provider.readSecretEnvironment) {
      let found: { record: string; environment: Record<string, string> } | undefined;

      try {
        found = await provider.readSecretEnvironment(info.id);
      } catch (error) {
        throw makeWithheld(
          "Secret recovery failed. Its error was withheld because the sandbox's secrets could not be read to redact it. Retry, or connect with recoverSecrets: false.",
          error instanceof SandboxError ? error : undefined,
        );
      }

      if (!found) return undefined;

      return { record: found.record, environment: new Map(Object.entries(found.environment)) };
    }

    let wire = "";
    let result: { exitCode: number | null; timedOut: boolean };

    try {
      result = await provider.exec(info.id, {
        command: secretRecoveryCommand,
        cwd: "/",
        env: {},
        timeoutMs: 10_000,
        onChunk(chunk) {
          if (chunk.stream === "stdout") wire += chunk.text;
        },
      });
    } catch (error) {
      throw makeWithheld(
        "Secret recovery failed. Its error was withheld because the sandbox's secrets could not be read to redact it. Retry, or connect with recoverSecrets: false.",
        error instanceof SandboxError ? error : undefined,
      );
    }

    if (result.timedOut || result.exitCode !== 0)
      throw makeWithheld(
        "Secret recovery failed. Could not read the sandbox environment. Connect with recoverSecrets: false to bypass recovery.",
      );

    if (!wire) return undefined;
    const separator = wire.indexOf("\0");

    if (separator < 0) invalid("Invalid secret recovery record");
    const environment = new Map<string, string>();

    for (const entry of wire.slice(separator + 1).split("\0")) {
      const equal = entry.indexOf("=");

      if (equal >= 0) environment.set(entry.slice(0, equal), entry.slice(equal + 1));
    }

    return { record: wire.slice(0, separator), environment };
  }

  async function recover() {
    // Values stay private to this step, and only explicitly recorded names enter the redactor/env.
    const found = await readSecretEnvironment();

    if (!found) {
      recovered = true;

      return;
    }

    let names: unknown;

    try {
      names = JSON.parse(found.record);
    } catch {
      throw new SandboxError(
        "Secret recovery failed. The secret names record is not valid JSON. Repair the record and reconnect.",
        { code: "provider" },
      );
    }

    if (!isNameList(names)) invalid("Invalid secret names record");
    const values: Record<string, string> = {};

    for (const name of names) values[name] = found.environment.get(name) ?? "";
    redactor.add(Object.values(values));
    Object.assign(baseEnv, values, options.env, options.secrets);
    recovered = true;
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

    if ((names.length || options.from !== undefined) && !provider.recordsSecretNames) {
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
      wait: async (options = {}) => {
        const timeoutMs = options.timeoutMs ?? defaultWaitTimeoutMs;

        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
          invalid("wait timeoutMs must be a positive, finite number");

        const signal = options.signal;
        const startedAt = Date.now();

        const makeAborted = () => {
          const message = recovered
            ? `Process wait aborted. ${handle.name} may still be running. Call wait() again with a fresh signal, or stop() it.`
            : "Process wait aborted while recovering sandbox secrets. Stopped waiting; call wait() again with a fresh signal, or stop() the process.";

          return redactor.error(
            new SandboxError(message, { code: "aborted" }),
            recovered ? provider.name : "unknown",
            recovered ? info.id : undefined,
          );
        };

        const makeTimeout = () => {
          const message = recovered
            ? `Process wait timed out. ${handle.name} did not exit within ${timeoutMs} ms and is still running. Call wait() again with a larger timeoutMs, or stop() it.`
            : `Process wait timed out after ${timeoutMs} ms while recovering sandbox secrets. Stopped waiting; call wait() again with a larger timeoutMs, or stop() the process.`;

          return redactor.error(
            new SandboxError(message, { code: "timeout", retryable: true }),
            recovered ? provider.name : "unknown",
            recovered ? info.id : undefined,
          );
        };

        if (signal?.aborted) throw makeAborted();

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let cancelTimer: (() => void) | undefined;

          const finish = (cb: () => void) => {
            if (settled) return;
            settled = true;

            cancelTimer?.();
            signal?.removeEventListener("abort", onAbort);
            cb();
          };

          const onAbort = () => finish(() => reject(makeAborted()));

          signal?.addEventListener("abort", onAbort, { once: true });
          cancelTimer = setLongTimeout(() => finish(() => reject(makeTimeout())), timeoutMs);

          void (async () => {
            try {
              await direct(guard);
              finish(resolve);
            } catch (error) {
              const isClosed =
                (closed || destroyed) &&
                error instanceof SandboxError &&
                error.code === "not_found";

              finish(() =>
                reject(
                  recovered || isClosed
                    ? error
                    : makeWithheld(
                        "Process wait failed while recovering sandbox secrets. Its error was withheld because the sandbox's secrets could not be read to redact it. Retry, or stop() the process.",
                        error instanceof SandboxError ? error : undefined,
                        true,
                      ),
                ),
              );
            }
          })();
        });

        if (signal?.aborted) throw makeAborted();

        const remainingMs = timeoutMs - (Date.now() - startedAt);

        if (remainingMs <= 0) throw makeTimeout();

        try {
          return await handle.wait({ ...options, timeoutMs: remainingMs });
        } catch (error) {
          if (error instanceof SandboxError && waitDeadlineErrors.has(error)) throw makeTimeout();
          throw error;
        }
      },
    };

    gated.set(handle, wrapper);

    return wrapper;
  };

  // Extensions bind on first access, so a handle that never uses one pays nothing. The factory and
  // every method run behind the handle's closed check. A successful call skips secret recovery, like
  // usage(); a failure recovers first so its error is redacted, and is withheld when that is impossible.
  const ext: Record<string, ExtensionMethods> = {};

  const withheld = (name: string, source?: SandboxError) =>
    makeWithheld(
      `Extension ${name} failed. Its error was withheld because the sandbox's secrets could not be read to redact it. Retry, or connect with recoverSecrets: false.`,
      source,
    );

  const factories: Readonly<
    Record<string, ((id: string, box: SandboxBase<N>) => ExtensionMethods) | undefined>
  > = provider.extensions ?? {};

  for (const [name, factory] of Object.entries(factories)) {
    if (!factory) continue;
    let bound: ExtensionMethods | undefined;

    Object.defineProperty(ext, name, {
      enumerable: true,
      get() {
        check();

        if (bound) return bound;
        let methods: ExtensionMethods;
        let found: [string, ExtensionMethods[string]][];

        // Discovery reads every method, so a throwing getter is caught here with the factory.
        try {
          methods = factory(info.id, box);
          found = methodsOf(methods);
        } catch (error) {
          // A getter cannot wait for recovery.
          throw recovered
            ? redactor.error(error, provider.name, info.id)
            : withheld(name, error instanceof SandboxError ? error : undefined);
        }

        // Each method keeps its object as `this`, so methods may call one another.
        bound = Object.fromEntries(
          found.map(([method, call]) => [
            method,
            async (...args: never[]) => {
              check();

              try {
                return await call.call(methods, ...args);
              } catch (error) {
                if (!recovered) await ready().catch(() => {});

                throw recovered
                  ? redactor.error(error, provider.name, info.id)
                  : withheld(name, error instanceof SandboxError ? error : undefined);
              }
            },
          ]),
        );

        return bound;
      },
    });
  }

  async function recoverWithin(signal?: AbortSignal, remainingMs?: number): Promise<void> {
    if (signal?.aborted || (remainingMs !== undefined && remainingMs <= 0)) return;

    const pending = ready().catch(() => {});

    if (!signal && remainingMs === undefined) {
      await pending;

      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;

        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };

      const timer =
        remainingMs !== undefined ? setTimeout(finish, Math.max(0, remainingMs)) : undefined;

      signal?.addEventListener("abort", finish, { once: true });
      void pending.finally(finish);
    });
  }

  async function guardNative<R>(
    call: () => Promise<R>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<R> {
    check();

    const deadlineAt =
      options?.timeoutMs !== undefined ? Date.now() + Math.max(0, options.timeoutMs) : undefined;

    try {
      return await call();
    } catch (error) {
      const timedOutOrAborted =
        options?.signal?.aborted === true ||
        (error instanceof SandboxError && (error.code === "aborted" || error.code === "timeout"));

      if (!recovered && !timedOutOrAborted) {
        const remainingMs = deadlineAt !== undefined ? deadlineAt - Date.now() : undefined;

        await recoverWithin(options?.signal, remainingMs);
      }

      throw recovered
        ? redactor.error(error, provider.name, info.id)
        : withheld("native", error instanceof SandboxError ? error : undefined);
    }
  }

  let cachedNative: { raw: N; wrapped: N } | undefined;

  const box: SandboxBase<N> = {
    id: info.id,
    key: info.key,
    provider: provider.name,
    created,
    labels: info.labels,
    capabilities: new Set(provider.capabilities),
    ext,
    get native() {
      check();

      let raw: N;

      try {
        raw = provider.native(info.id);
      } catch (error) {
        throw recovered
          ? redactor.error(error, provider.name, info.id)
          : withheld("native", error instanceof SandboxError ? error : undefined);
      }

      if (cachedNative?.raw === raw) return cachedNative.wrapped;

      const wrapped = guardNativeApi(raw, guardNative);

      cachedNative = { raw, wrapped };

      return wrapped;
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

      closing ??= (async () => {
        // Adapters key local resources by sandbox ID, so another open handle still needs them.
        const last = release();

        try {
          if (last) await provider.close?.(info.id);
        } catch (error) {
          holding = true;
          attachHandle(provider, info.id);
          throw error;
        }

        files[Symbol.dispose]();
        closed = true;
      })().finally(() => {
        closing = undefined;
      });

      try {
        await closing;
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
        release();
        const key = options.key;
        const locator = options.locator;

        // Under the creation lock, so a replacement created meanwhile keeps its entry.
        if (key && locator?.delete)
          await withKeyLock(provider, key, options, async () => {
            if ((await locator.get(key)) === info.id) await locator.delete?.(key);
          });
      } catch (error) {
        throw redactor.error(error, provider.name, info.id);
      }
    },
    async [Symbol.asyncDispose]() {
      if (options.key || closeOnDispose) await box.close();
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
      terminal: (options: TerminalOptions) =>
        safe(async () => {
          for (const size of [options.cols, options.rows])
            if (!Number.isSafeInteger(size) || size < 1)
              invalid("Terminal cols and rows must be positive integers");

          for (const name of Object.keys(options.env ?? {}))
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
              invalid("Invalid environment variable name");

          const raw = await terminal.call(provider, info.id, {
            cols: options.cols,
            rows: options.rows,
            cwd: pathOf(options.cwd),
            env: { ...baseEnv, ...options.env },
          });

          // close() or destroy() may have landed while the shell started: close it rather than hand it out.
          if (closed || destroyed) {
            await Promise.resolve(raw.close()).catch(() => {});
            check();
          }

          const cleanups = new Set<() => void>();
          // Text a redaction filter holds back as a possible secret prefix. Flushed when the shell exits too.
          const filters = new Set<{ flush(): void }>();

          const flushAll = () => {
            for (const filter of filters) filter.flush();
          };

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
              filters.add(filter);

              const cleanup = () => {
                off();
                filter.flush();
                filters.delete(filter);
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

          const wait = raw.wait;

          if (wait) {
            // The shell's last output reaches subscribers before wait() resolves.
            const exited = wait.call(raw);
            void exited.then(flushAll, flushAll);

            handle.wait = () =>
              direct(async () => {
                const exit = await exited;
                flushAll();

                return exit;
              });
          }

          return handle;
        }),
    });
  registerToolRedactor(box, redactor);
  attachHandle(provider, info.id);
  holding = true;

  return box;
}
