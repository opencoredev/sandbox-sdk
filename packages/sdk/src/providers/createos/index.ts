import {
  CreateosSandboxClient,
  Sandbox as CreateosSandbox,
  CreateosSandboxError,
  CreateosSandboxApiError,
  CreateosSandboxAuthError,
  CreateosSandboxPermissionError,
  CreateosSandboxNotFoundError,
  CreateosSandboxTimeoutError,
  CreateosSandboxRateLimitError,
  CreateosSandboxValidationError,
  CreateosSandboxServerError,
  CreateosSandboxConnectionError,
} from "@nodeops-createos/sandbox";
import { SandboxError } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type { ProcessOutputEvent, SandboxProcess } from "../../core/types";
import {
  commandString,
  portResult,
  toUint8Array,
  unsupportedSnapshots,
} from "../../internal/provider-utils";
import { createosCapabilities } from "../capabilities";

export interface CreateosOptions {
  /** createos-sandbox API key. Falls back to CREATEOS_SANDBOX_API_KEY env var. */
  apiKey?: string;
  /** Control-plane base URL. Falls back to CREATEOS_SANDBOX_BASE_URL env var. */
  baseUrl?: string;
  /** VM sizing preset, e.g. "s-1vcpu-256mb" or "s-4vcpu-4gb". */
  shape?: string;
  /** Rootfs catalog name or template id, e.g. "devbox:1". */
  rootfs?: string;
  /** Enable HTTP ingress at create time. Defaults to true. */
  ingressEnabled?: boolean;
  /** Egress allowlist rules (host:port). Empty or omitted = allow all. */
  egress?: string[];
  /** Env vars injected into every exec inside the VM. */
  envs?: Record<string, string>;
  /** Idle auto-pause timeout in seconds (60–86400). Omit to disable. */
  autoPauseAfterSeconds?: number;
  /** Timeout in ms for sandbox creation. */
  timeout?: number;
}

export { createosCapabilities } from "../capabilities";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function mapError(operation: string, error: unknown): SandboxError {
  if (error instanceof SandboxError) return error;
  if (!(error instanceof CreateosSandboxError)) {
    return new SandboxError({
      code: "internal",
      provider: "createos",
      operation,
      message: error instanceof Error ? error.message : "Unknown error",
      cause: error,
    });
  }

  const message = error.message;
  const base = { provider: "createos" as const, operation, message, cause: error };

  if (error instanceof CreateosSandboxAuthError)
    return new SandboxError({ ...base, code: "authentication" });
  if (error instanceof CreateosSandboxPermissionError)
    return new SandboxError({ ...base, code: "permission" });
  if (error instanceof CreateosSandboxNotFoundError)
    return new SandboxError({ ...base, code: "not_found" });
  if (error instanceof CreateosSandboxTimeoutError)
    return new SandboxError({ ...base, code: "timeout", retryable: true });
  if (error instanceof CreateosSandboxRateLimitError)
    return new SandboxError({ ...base, code: "rate_limited", retryable: true });
  if (error instanceof CreateosSandboxValidationError)
    return new SandboxError({ ...base, code: "invalid_input" });
  if (error instanceof CreateosSandboxServerError)
    return new SandboxError({ ...base, code: "unavailable", retryable: true });
  if (error instanceof CreateosSandboxConnectionError)
    return new SandboxError({ ...base, code: "unavailable", retryable: true });
  if (error instanceof CreateosSandboxApiError)
    return new SandboxError({ ...base, code: "internal" });

  return new SandboxError({ ...base, code: "internal" });
}

export function createos(options: CreateosOptions = {}): SandboxProvider<CreateosSandbox> {
  return {
    id: "createos",
    capabilities: createosCapabilities,
    async create(createOptions) {
      const client = new CreateosSandboxClient({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
      });

      let raw: CreateosSandbox;
      try {
        raw = await client.createSandbox(
          {
            shape: options.shape ?? "s-1vcpu-256mb",
            rootfs: options.rootfs,
            ingress_enabled: options.ingressEnabled ?? true,
            egress: options.egress,
            envs: { ...createOptions.env, ...options.envs },
            auto_pause_after_seconds: options.autoPauseAfterSeconds,
          },
          {
            timeoutMs: options.timeout ?? createOptions.timeout,
            signal: createOptions.signal,
          },
        );
      } catch (error) {
        throw mapError("create", error);
      }

      try {
        await raw.runCommand("mkdir", ["-p", createOptions.cwd]);
      } catch (error) {
        await raw.destroy().catch(() => undefined);
        throw mapError("create", error);
      }

      return {
        id: raw.id,
        raw,
        capabilities: createosCapabilities,
        files: {
          async write(path, value) {
            try {
              const bytes = await toUint8Array(value);
              await raw.files.upload(path, new Blob([new Uint8Array(bytes) as unknown as ArrayBuffer]));
            } catch (error) {
              throw mapError("files.write", error);
            }
          },
          async read(path) {
            try {
              return new Uint8Array(await raw.files.download(path));
            } catch (error) {
              throw mapError("files.read", error);
            }
          },
          async list(path) {
            try {
              const result = await raw.runCommand("find", [
                path, "-maxdepth", "1", "-mindepth", "1", "-printf", "%y\\t%f\\0",
              ]);
              if (result.result.exit_code !== 0) {
                throw new CreateosSandboxError(
                  `find failed: ${result.result.stderr || result.result.error}`,
                );
              }
              if (!result.result.stdout) return [];
              const normalizedPath = path.endsWith("/") ? path : `${path}/`;
              return result.result.stdout
                .split("\0")
                .filter(Boolean)
                .map((entry) => {
                  const sep = entry.indexOf("\t");
                  const typeChar = entry.slice(0, sep);
                  const name = entry.slice(sep + 1);
                  const type = typeChar === "d"
                    ? ("directory" as const)
                    : typeChar === "l"
                      ? ("symlink" as const)
                      : ("file" as const);
                  return { name, path: `${normalizedPath}${name}`, type };
                });
            } catch (error) {
              throw mapError("files.list", error);
            }
          },
          async mkdir(path) {
            try {
              const result = await raw.runCommand("mkdir", ["-p", path]);
              if (result.result.exit_code !== 0) {
                throw new CreateosSandboxError(
                  `mkdir failed: ${result.result.stderr || result.result.error}`,
                );
              }
            } catch (error) {
              throw mapError("files.mkdir", error);
            }
          },
          async remove(path) {
            try {
              const result = await raw.runCommand("rm", ["-rf", path]);
              if (result.result.exit_code !== 0) {
                throw new CreateosSandboxError(
                  `rm failed: ${result.result.stderr || result.result.error}`,
                );
              }
            } catch (error) {
              throw mapError("files.remove", error);
            }
          },
          async exists(path) {
            try {
              const result = await raw.runCommand("test", ["-e", path]);
              return result.result.exit_code === 0;
            } catch (error) {
              throw mapError("files.exists", error);
            }
          },
        },
        async run(command, runOptions) {
          try {
            const cmd = commandString(command);
            const envPrefix = runOptions.env
              ? "env " + Object.entries(runOptions.env)
                  .map(([k, v]) => `${shellQuote(k + "=" + v)}`)
                  .join(" ") + " "
              : "";
            const cdPrefix = runOptions.cwd
              ? `cd ${shellQuote(runOptions.cwd)} && `
              : "";
            const fullArgs = runOptions.cwd || runOptions.env
              ? ["-c", `${cdPrefix}${envPrefix}${cmd}`]
              : ["-c", cmd];

            const started = performance.now();
            const response = await raw.runCommand("bash", fullArgs, {
              timeoutMs: runOptions.timeout,
              signal: runOptions.signal,
            });
            return {
              stdout: response.result.stdout,
              stderr: response.result.stderr,
              exitCode: response.result.exit_code,
              success: response.result.exit_code === 0,
              durationMs: Math.round(performance.now() - started),
            };
          } catch (error) {
            throw mapError("process.run", error);
          }
        },
        async start(command, runOptions) {
          const events: ProcessOutputEvent[] = [];
          const waiters = new Set<() => void>();
          let running = true;
          let exitCode = -1;

          const cmd = commandString(command);
          const envPrefix = runOptions.env
            ? "env " + Object.entries(runOptions.env)
                .map(([k, v]) => `${shellQuote(k + "=" + v)}`)
                .join(" ") + " "
            : "";
          const cdPrefix = runOptions.cwd
            ? `cd ${shellQuote(runOptions.cwd)} && `
            : "";
          const fullCmd = `${cdPrefix}${envPrefix}${cmd}`;

          const push = (stream: "stdout" | "stderr", data: string) => {
            events.push({ stream, data, timestamp: new Date() });
            for (const wake of waiters) wake();
            waiters.clear();
          };

          const killController = new AbortController();
          const combinedSignal = runOptions.signal
            ? AbortSignal.any([runOptions.signal, killController.signal])
            : killController.signal;

          const streamIter = raw.streamCommand("bash", ["-c", fullCmd], {
            timeoutMs: runOptions.timeout,
            signal: combinedSignal,
          });

          const completed = (async () => {
            try {
              for await (const event of streamIter) {
                switch (event.type) {
                  case "stdout":
                    push("stdout", event.data);
                    break;
                  case "stderr":
                    push("stderr", event.data);
                    break;
                  case "exit":
                    exitCode = event.exitCode;
                    break;
                  case "error":
                    push("stderr", event.message);
                    break;
                }
              }
            } catch (error) {
              if (combinedSignal.aborted) {
                exitCode = exitCode === -1 ? 137 : exitCode;
              } else {
                throw error;
              }
            } finally {
              running = false;
              for (const wake of waiters) wake();
              waiters.clear();
            }
            return { exitCode };
          })();

          const process: SandboxProcess = {
            id: `createos-stream-${Date.now()}`,
            async status() {
              return running ? "running" : "exited";
            },
            async *output() {
              let index = 0;
              while (running || index < events.length) {
                while (index < events.length) yield events[index++]!;
                if (!running) break;
                await new Promise<void>((resolve) => waiters.add(resolve));
              }
            },
            async write() {
              throw new SandboxError({
                code: "unsupported",
                provider: "createos",
                operation: "process.stdin",
                message: "createos does not support stdin on exec",
              });
            },
            wait: () => completed,
            async kill() {
              killController.abort();
              await completed.catch(() => {});
            },
          };
          return process;
        },
        async expose(port) {
          try {
            if (!raw.data.ingress_enabled) {
              await raw.setIngress(true);
            }
            return portResult(port, raw.previewUrl(port), false, true);
          } catch (error) {
            throw mapError("ports.expose", error);
          }
        },
        snapshots: unsupportedSnapshots("createos"),
        async stop() {
          try {
            await raw.destroy();
          } catch (error) {
            throw mapError("stop", error);
          }
        },
      };
    },
  };
}

export type { CreateosSandbox };
