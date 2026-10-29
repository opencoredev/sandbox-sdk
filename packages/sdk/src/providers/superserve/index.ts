/** @superserve/sdk 0.11.4; https://docs.superserve.ai/sdk-reference/sandbox */
import type { NetworkConfig, Sandbox, SandboxInfo as NativeInfo } from "@superserve/sdk";
import type { CreateInput, Provider, SandboxInfo } from "../../provider.js";
import { loadPeer } from "../../peer.js";
import { files, python, type Guest } from "../boxd/guest.js";
import { failure, superserveError } from "./errors.js";
import { execute } from "./execute.js";
import { bootstrapCommand, checkBootstrap } from "./bootstrap.js";

export interface SuperserveOptions {
  /** Defaults to SUPERSERVE_API_KEY; required on first use. */
  apiKey?: string;
  /** Defaults to SUPERSERVE_BASE_URL, then https://api.superserve.ai. */
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
  /** Native request deadline. Default: 90 s. */
  requestTimeoutMs?: number;
  /** Auto-pause after this much active time per session, re-armed on resume. Rounded up to whole seconds. Default: never. */
  autoPauseMs?: number;
  /** Delete the sandbox once it has been paused this long; `0` deletes it as soon as it pauses. Rounded up to whole seconds. Default: never. */
  autoDeleteMs?: number;
  /** Bind stored Superserve secrets to env vars: `{ ENV_VAR: secretName }`. The sandbox sees a proxy token; the real value is attached at egress. */
  secretBindings?: Record<string, string>;
  /** Access for preview ports. `private` returns a token header with each preview; `public` URLs need none. Default: `private`. */
  previewAccess?: "private" | "public";
}

export type SuperserveProvider = Provider<Sandbox, "pause" | "snapshot" | "network-policy">;

// Superserve resolves names through these; a domain allow-list needs them reachable.
const resolvers = ["1.1.1.1/32", "8.8.8.8/32"];
const cidr = (entry: string) => /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(entry);

/** Maps SDK network policy to Superserve egress rules; undefined leaves egress open. */
function egress(network: CreateInput["network"]): NetworkConfig | undefined {
  if (network === undefined || network === "all") return undefined;

  if (network === "none") return { allowOut: [], denyOut: ["0.0.0.0/0"] };

  for (const entry of network.allow)
    if (
      !cidr(entry) &&
      !/^(\*\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(
        entry,
      )
    )
      throw failure(
        "Network allow entries must be hostnames, *.wildcards, IPv4 addresses or IPv4 CIDRs",
        "unsupported",
      );

  const allow = network.allow.map((entry) =>
    cidr(entry) && !entry.includes("/") ? `${entry}/32` : entry,
  );

  const domains = allow.some((entry) => !cidr(entry));

  return {
    allowOut: [...new Set([...allow, ...(domains ? resolvers : [])])],
    denyOut: ["0.0.0.0/0"],
  };
}

function sameEgress(requested: NetworkConfig, actual: NetworkConfig | undefined) {
  const same = (a: string[] = [], b: string[] = []) =>
    a.length === b.length && a.every((x) => b.includes(x));

  return same(requested.allowOut, actual?.allowOut) && same(requested.denyOut, actual?.denyOut);
}

const wholeSeconds = (value: number | undefined, label: string, zero: boolean) => {
  if (value === undefined) return undefined;

  if (!Number.isSafeInteger(value) || value < 0 || (!zero && value === 0))
    throw failure(
      `${label} must be a ${zero ? "non-negative" : "positive"} integer of milliseconds`,
      "invalid_argument",
    );

  return Math.ceil(value / 1000);
};

export function superserve(options: SuperserveOptions = {}): SuperserveProvider {
  const boxes = new Map<string, Sandbox>();
  const environments = new Map<string, Record<string, string>>();
  const workspacePrepared = new Set<string>();
  const prepared = new Set<string>();
  const deleting = new Map<string, Promise<void>>();

  const connection = () => {
    const apiKey = options.apiKey ?? process.env.SUPERSERVE_API_KEY;

    if (!apiKey?.trim())
      throw failure(
        "Superserve API key is missing. Authentication is required. Set SUPERSERVE_API_KEY or pass apiKey.",
        "auth",
      );

    return { apiKey, baseUrl: options.baseUrl };
  };

  const timeout = options.requestTimeoutMs ?? 90000;
  const autoPauseSeconds = wholeSeconds(options.autoPauseMs, "autoPauseMs", false);
  const autoDeleteSeconds = wholeSeconds(options.autoDeleteMs, "autoDeleteMs", true);
  const previewAccess = options.previewAccess ?? "private";

  if (previewAccess !== "private" && previewAccess !== "public")
    throw failure("previewAccess must be private or public", "invalid_argument");

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

    return (sdk ??= loadPeer("@superserve/sdk", "superserve", () => import("@superserve/sdk")));
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

    const setup = bootstrapCommand({
      env: environments.get(id),
      installPython: options.installPython,
      execution,
    });

    return { command: `${setup.command} && ${command}`, env: setup.env };
  }

  async function runGuest(
    id: string,
    command: string,
    settings: { env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
    execution = false,
  ) {
    const setup = preparation(id, command, execution);

    const result = await (
      await vm(id)
    ).commands.run(setup.command, { ...settings, env: { ...settings.env, ...setup.env } });

    checkBootstrap(result.exitCode, id);

    if (result.exitCode === 0) {
      workspacePrepared.add(id);

      if (execution) prepared.add(id);
    }

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
            const r = await runGuest(
              id,
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
    capabilities: new Set(["pause", "snapshot", "network-policy"]),
    create: (input) =>
      safe(undefined, async () => {
        if (
          input.size !== undefined ||
          input.idleTimeoutMs !== undefined ||
          input.timeoutMs !== undefined
        )
          throw failure(
            "Template resources cannot be overridden, and Superserve has no idle or hard lifetime; use autoPauseMs and autoDeleteMs",
            "unsupported",
          );
        const network = egress(input.network);

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
        // Load the SDK first: a missing peer allocated nothing, so it is not an unknown outcome.
        const native = await api();

        try {
          box = await native.Sandbox.create({
            ...connection(),
            name: `sbxsdk-${crypto.randomUUID()}`,
            metadata,
            envVars: input.env,
            previewAccess,
            ...(network ? { network } : {}),
            ...(autoPauseSeconds === undefined ? {} : { timeoutSeconds: autoPauseSeconds }),
            ...(autoDeleteSeconds === undefined ? {} : { autoDeleteSeconds }),
            ...(options.secretBindings && Object.keys(options.secretBindings).length
              ? { secrets: options.secretBindings }
              : {}),
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

          if (input.from || network) {
            const details = await box.getInfo();

            // Restores inherit the snapshot's auto-pause; keep only what this adapter asked for.
            if (input.from && details.timeoutSeconds !== autoPauseSeconds)
              await box.update({ timeoutSeconds: autoPauseSeconds ?? null });

            if (network && !sameEgress(network, details.network))
              throw failure(
                "Superserve did not confirm the requested egress rules",
                "unsupported",
                box.id,
              );
          }

          return {
            id: box.id,
            key: input.key,
            labels: { ...input.labels, "sandbox-sdk": "1" },
            createdAt,
            state: "running",
          };
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
          boxes.delete(id);
          environments.delete(id);
          prepared.delete(id);
          workspacePrepared.delete(id);
        });
        deleting.set(id, pending);
        pending.finally(() => deleting.delete(id)).catch(() => {});
      }

      return pending;
    },
    async close(id) {
      boxes.delete(id);
      environments.delete(id);
      prepared.delete(id);
      workspacePrepared.delete(id);
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

                if (r.exitCode !== 0 || r.truncated)
                  throw failure("Supervisor failed", "provider", id);

                return r.stdout;
              } finally {
                signal?.removeEventListener("abort", abort);
              }
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
                prepared.add(id);
                workspacePrepared.add(id);

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
        await box.publishPreviewPort(port, { access: previewAccess });

        if (previewAccess === "public") return { url: box.getPreviewUrl(port) };
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
    snapshot: (id, snapshotOptions) =>
      safe(id, async () => {
        if (snapshotOptions?.expiresInMs)
          throw failure(
            "Superserve keeps snapshots until they are deleted; omit expiresInMs",
            "unsupported",
            id,
          );
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
