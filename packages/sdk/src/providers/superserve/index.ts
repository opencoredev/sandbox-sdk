/** @superserve/sdk 0.11.4; https://docs.superserve.ai/sdk-reference/sandbox */
import type { Sandbox, SandboxInfo as NativeInfo } from "@superserve/sdk";
import type { Provider, SandboxInfo } from "../../provider.js";
import { files, python, type Guest } from "../boxd/guest.js";
import { failure, superserveError } from "./errors.js";
import { execute } from "./execute.js";
import { bootstrapCommand, checkBootstrap } from "./bootstrap.js";
export interface SuperserveOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Native template name or UUID. Defaults to superserve/node-22.
   * Must include git, tar, and nohup. Python 3 is required unless installPython is enabled.
   * Template-owned resources cannot be overridden by the SDK size option.
   */
  template?: string;
  /** Allow apt to install missing Python 3, pip and venv on first use.
   * Defaults to false: a template without Python fails with unsupported on first use.
   * The public default superserve/node-22 currently requires this opt-in.
   */
  installPython?: boolean;
  requestTimeoutMs?: number;
}
export type SuperserveProvider = Provider<Sandbox, "pause" | "snapshot">;
export function superserve(options: SuperserveOptions = {}): SuperserveProvider {
  const boxes = new Map<string, Sandbox>();
  const environments = new Map<string, Record<string, string>>();
  const workspacePrepared = new Set<string>();
  const prepared = new Set<string>();
  const deleting = new Map<string, Promise<void>>();
  const connection = () => {
    const apiKey = options.apiKey ?? process.env.SUPERSERVE_API_KEY;
    if (!apiKey?.trim()) throw failure("Set SUPERSERVE_API_KEY", "auth");
    return { apiKey, baseUrl: options.baseUrl };
  };
  const timeout = options.requestTimeoutMs ?? 90000;
  async function safe<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw superserveError(error, id);
    }
  }
  let sdk: Promise<typeof import("@superserve/sdk")> | undefined;
  async function api() {
    connection();
    return sdk ??= import("@superserve/sdk");
  }
  async function vm(id: string) {
    let value = boxes.get(id);
    if (!value) {
      value = await (
        await api()
      ).Sandbox.connect(id, { ...connection(), signal: AbortSignal.timeout(timeout) });
      boxes.set(id, value);
    }
    return value;
  }
  function info(v: NativeInfo): SandboxInfo {
    if (v.metadata["sandbox-sdk"] !== "1") throw failure("Not an SDK sandbox", "not_found", v.id);
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(v.metadata))
      if (key.startsWith("label:")) labels[key.slice(6)] = value;
    return {
      id: v.id,
      key: v.metadata["sdk-key"],
      labels,
      createdAt: v.createdAt.getTime(),
      state:
        v.status === "active"
          ? "running"
          : ["paused", "pausing"].includes(v.status)
            ? "paused"
            : "stopped",
    };
  }
  function preparation(id: string, command: string, execution: boolean) {
    if (execution ? prepared.has(id) : workspacePrepared.has(id)) return { command, env: {} };
    const setup = bootstrapCommand({ env: environments.get(id), installPython: options.installPython, execution });
    return { command: `${setup.command} && ${command}`, env: setup.env };
  }
  async function runGuest(id: string, command: string, settings: { env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }, execution = false) {
    const setup = preparation(id, command, execution);
    const result = await (await vm(id)).commands.run(setup.command, { ...settings, env: { ...settings.env, ...setup.env } });
    checkBootstrap(result.exitCode, id);
    if (result.exitCode === 0) { workspacePrepared.add(id); if (execution) prepared.add(id); }
    return result;
  }
  async function guest(id: string): Promise<Guest> {
    const box = await vm(id);
    return {
      name: "superserve",
      raw: async (command) => {
        const r = await runGuest(id, command, { timeoutMs: timeout });
        if (r.exitCode !== 0) throw failure("Guest operation failed", "provider", id);
        return r.stdout;
      },
      upload: async (path, bytes) => box.files.write(path, bytes, { timeoutMs: timeout }),
      read: async (path, range) => {
        try {
          if (range) {
            const r = await runGuest(id,
              python(
                "import sys,base64; f=open(sys.argv[1],'rb'); f.seek(int(sys.argv[2])); print(base64.b64encode(f.read(int(sys.argv[3]))).decode())",
                path,
                String(range.offset),
                String(range.length),
              ),
              { timeoutMs: timeout },
            );
            if (r.exitCode !== 0) throw failure("File range read failed", "file_not_found", id);
            return new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
          }
          return await box.files.read(path, { timeoutMs: timeout });
        } catch (error) {
          if (superserveError(error).code === "not_found")
            throw failure("File does not exist", "file_not_found", id);
          throw error;
        }
      },
    };
  }
  const provider: SuperserveProvider = {
    name: "superserve",
    keyMode: "best-effort",
    inlineActivity: true,
    capabilities: new Set(["pause", "snapshot"]),
    create: (input) =>
      safe(undefined, async () => {
        if (
          input.size !== undefined ||
          input.idleTimeoutMs !== undefined ||
          input.timeoutMs !== undefined ||
          (input.network && input.network !== "all")
        )
          throw failure(
            "Template resources cannot be overridden; SDK idle/lifetime limits and network restrictions are not implemented",
            "unsupported",
          );
        if (!Number.isSafeInteger(timeout) || timeout <= 0)
          throw failure("requestTimeoutMs must be a positive integer", "invalid_argument");
        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        const metadata: Record<string, string> = {
          "sandbox-sdk": "1",
          ...(input.key !== undefined ? { "sdk-key": input.key } : {}),
        };
        for (const [key, value] of Object.entries(input.labels)) metadata[`label:${key}`] = value;
        const createdAt = Date.now();
        let box: Sandbox;
        try {
          box = await (
            await api()
          ).Sandbox.create({
            ...connection(),
            name: `sbxsdk-${crypto.randomUUID()}`,
            metadata,
            envVars: input.env,
            previewAccess: "private",
            ...(input.from
              ? { fromSnapshot: input.from }
              : { fromTemplate: options.template ?? "superserve/node-22" }),
            signal: AbortSignal.timeout(timeout),
          });
        } catch (error) {
          const mapped = superserveError(error);
          if (["timeout", "unavailable", "aborted"].includes(mapped.code))
            throw failure(
              "Creation outcome unknown; inspect SDK-labelled sandboxes before retrying",
              "outcome_unknown",
            );
          throw mapped;
        }
        boxes.set(box.id, box);
        try {
          if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
          environments.set(box.id, { ...input.env });
          if (input.from) {
            const details = await box.getInfo();
            if (details.timeoutSeconds !== undefined) await box.update({ timeoutSeconds: null });
          }
          return { id: box.id, key: input.key, labels: { ...input.labels, "sandbox-sdk": "1" }, createdAt, state: "running" };
        } catch (error) {
          await provider.destroy(box.id);
          throw error;
        }
      }),
    list: (labels) =>
      safe(undefined, async () => {
        const values = await (
          await api()
        ).Sandbox.list({
          ...connection(),
          metadata: { "sandbox-sdk": "1" },
          signal: AbortSignal.timeout(timeout),
        });
        return values
          .filter((v) => v.status !== "deleted")
          .map(info)
          .filter((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x));
      }),
    async find(key) {
      const value = (await provider.list({})).find((v) => v.key === key);
      return value ? provider.connect(value.id) : undefined;
    },
    connect: (id) => safe(id, async () => info(await (await vm(id)).getInfo())),
    destroy(id) {
      let pending = deleting.get(id);
      if (!pending) {
        pending = safe(id, async () => {
          await (
            await api()
          ).Sandbox.killById(id, { ...connection(), signal: AbortSignal.timeout(timeout) });
          boxes.delete(id); environments.delete(id); prepared.delete(id); workspacePrepared.delete(id);
        });
        deleting.set(id, pending);
        pending.finally(() => deleting.delete(id)).catch(() => {});
      }
      return pending;
    },
    async close(id) {
      boxes.delete(id); environments.delete(id); prepared.delete(id); workspacePrepared.delete(id);
    },
    exec: (id, input) =>
      safe(id, async () => {
        const box = await vm(id),
          g = await guest(id);
        return execute(
          {
            raw: g.raw,
            read: async (path, range) => {
              const text = await g.raw(
                python(
                  "import sys,base64; f=open(sys.argv[1],'rb'); f.seek(int(sys.argv[2])); print(base64.b64encode(f.read(int(sys.argv[3]))).decode())",
                  path,
                  String(range.offset),
                  String(range.length),
                ),
              );
              return new Uint8Array(Buffer.from(text.trim(), "base64"));
            },
            run: async (command, env, timeoutMs, signal) => {
              if (signal?.aborted) throw failure("Command interrupted", "aborted", id);
              let abort = () => {};
              const stopped = new Promise<never>((_, reject) => {
                abort = () => reject(failure("Command interrupted", "aborted", id));
              });
              signal?.addEventListener("abort", abort, { once: true });
              try {
                // Keep the supervisor alive for lock-based cancellation and exit recovery.
                const completion = runGuest(id, command, { env, timeoutMs }, true);
                const r = await Promise.race([completion, stopped]);
                if (r.exitCode !== 0 || r.truncated) throw failure("Supervisor failed", "provider", id);
                return r.stdout;
              } finally { signal?.removeEventListener("abort", abort); }
            },
            exec: async (command, stdin, timeoutMs, signal) => {
              const setup = preparation(id, command, true);
              const session = await box.commands.spawn(setup.command, {
                env: setup.env,
                startupSignal: signal,
                timeoutMs,
              });
              let abort = () => {},
                waiting = false;
              try {
                session.stdin.write(stdin);
                session.stdin.close();
                const stopped = new Promise<never>((_, reject) => {
                  abort = () => {
                    reject(failure("Command interrupted", "aborted", id));
                  };
                });
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted) abort();
                const completion = session.wait().finally(() => session.close());
                waiting = true;
                const r = await Promise.race([completion, stopped]);
                checkBootstrap(r.exitCode, id);
                if (r.exitCode !== 0) throw failure("Supervisor failed", "provider", id);
                prepared.add(id); workspacePrepared.add(id);
                return r.stdout;
              } finally {
                signal?.removeEventListener("abort", abort);
                if (!waiting) await session.close();
              }
            },
          },
          input,
        );
      }),
    files: files(guest, safe),
    previewUrl: (id, port) =>
      safe(id, async () => {
        const box = await vm(id);
        await box.publishPreviewPort(port, { access: "private" });
        const token = await box.getPreviewToken(port);
        return {
          url: box.getPreviewUrl(port),
          headers: { [token.header]: token.token },
          ...(token.expiresAt ? { expiresAt: token.expiresAt.getTime() } : {}),
        };
      }),
    pause: (id) =>
      safe(id, async () => {
        await (await vm(id)).pause({ wait: true, timeoutMs: timeout });
      }),
    resume: (id) =>
      safe(id, async () => {
        await (await vm(id)).resume({ timeoutMs: timeout });
      }),
    snapshot: (id) =>
      safe(id, async () => {
        const name = `sbxsdk-${crypto.randomUUID()}`;
        try {
          return {
            id: (await (await vm(id)).snapshot({ name, idempotencyKey: name, timeoutMs: timeout }))
              .id,
          };
        } catch {
          throw failure(
            `Snapshot outcome unknown; recover snapshot named ${name} from source ${id}`,
            "outcome_unknown",
            id,
          );
        }
      }),
    native(id) {
      const box = boxes.get(id);
      if (!box) throw failure("Connect the sandbox first", "not_found", id);
      return box;
    },
  };
  return provider;
}
