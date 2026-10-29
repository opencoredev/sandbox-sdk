import { posix } from "node:path";
import type { Sandbox as E2BSandbox, SandboxInfo as E2BInfo, EntryInfo, CommandHandle } from "e2b";
import { loadPeer } from "../../peer.js";
import type {
  Provider,
  SandboxInfo,
  ExecInput,
  FileInfo,
  NativeProcess,
  CreateInput,
} from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { e2bError } from "./errors.js";

export interface E2BOptions {
  /** Defaults to E2B_API_KEY; required on first use. */
  apiKey?: string;
  /** Template name or ID, including custom hardware templates. Defaults to base. */
  template?: string;
  /** Self-hosted domain. Defaults to E2B_DOMAIN, then e2b.app. */
  domain?: string;
  /** Deadline for each E2B control-plane request. Default: 60 s (the E2B SDK default). */
  requestTimeoutMs?: number;
  /** Serve preview URLs without authentication. Default: true. With false, `preview()` returns the `e2b-traffic-access-token` header. */
  public?: boolean;
  /** Pause instead of kill when the sandbox timeout runs out. `timeoutMs` then sets the running time before the pause, not a hard lifetime. Default: false. */
  autoPause?: boolean;
  /** Wake an auto-paused sandbox when traffic reaches a preview URL. Requires `autoPause`. Default: false. */
  autoResume?: boolean;
  /** E2B volumes to mount, keyed by absolute mount path. Values are volume names or IDs. */
  volumes?: Record<string, string>;
}

const keyTag = "sandbox-sdk-key";
const workspaceMarker = "/tmp/.sandbox-sdk-workspace-ready";
const deadlineTag = "sandbox-sdk-deadline";
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const prepareWorkspace = `flock -x ${workspaceMarker}.lock sh -c ${quote(`if [ ! -e ${workspaceMarker} ]; then mkdir -p /workspace && touch ${workspaceMarker} || exit 125; fi`)} || exit 125`;

const missing = (cause: unknown) =>
  e2bError(cause, undefined, true).code === "file_not_found" ||
  (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const unsupported = (message: string) =>
  new SandboxError(
    `${message}. E2B cannot enforce this option. Choose a compatible template or omit the option.`,
    { code: "unsupported", provider: "e2b" },
  );

const infoOf = (info: E2BInfo): SandboxInfo => ({
  id: info.sandboxId,
  key: info.metadata[keyTag],
  labels: Object.fromEntries(
    Object.entries(info.metadata).filter(([key]) => ![keyTag, deadlineTag].includes(key)),
  ),
  state: info.state,
  createdAt: info.startedAt.getTime(),
});

const fileOf = (entry: EntryInfo): FileInfo => ({
  path: entry.path,
  type: entry.type === "dir" ? "directory" : entry.type === "symlink" ? "symlink" : "file",
  size: entry.size,
  modifiedAt: entry.modifiedTime?.getTime() ?? 0,
});

export type E2BProvider = Provider<E2BSandbox, "pause" | "snapshot" | "network-policy">;

/** E2B's template fixes CPU, RAM and disk; explicit size requests fail closed.
 * Cloud modules are loaded only on first provider I/O, never by importing core.
 */
export function e2b(options: E2BOptions = {}): E2BProvider {
  let module: Promise<typeof import("e2b")> | undefined;
  const sdk = () => (module ??= loadPeer("e2b", "e2b", () => import("e2b")));

  const api = () => {
    const apiKey = options.apiKey ?? process.env.E2B_API_KEY;

    if (!apiKey?.trim())
      throw new SandboxError(
        "E2B API key is missing. Authentication is required. Set E2B_API_KEY or pass apiKey.",
        { code: "auth", provider: "e2b" },
      );

    return { apiKey, domain: options.domain, requestTimeoutMs: options.requestTimeoutMs };
  };

  const clients = new Map<string, E2BSandbox>();
  const deadlines = new Map<string, number>();
  const workspaces = new Map<string, number>();
  const detached = new Map<string, { wait: Promise<void>; release(): void }>();

  function detach(id: string) {
    if (detached.has(id)) return;
    let release = () => {};

    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    detached.set(id, { wait, release });
  }

  function attached(id: string) {
    detached.get(id)?.release();
    detached.delete(id);
  }

  const handles = new Map<string, Set<CommandHandle>>();

  async function call<T>(
    id: string | undefined,
    action: () => Promise<T>,
    file = false,
  ): Promise<T> {
    try {
      return await action();
    } catch (cause) {
      throw e2bError(cause, id, file);
    }
  }

  async function attach(id: string): Promise<E2BInfo> {
    const { Sandbox } = await sdk();
    const info = await Sandbox.getInfo(id, api());
    const deadline = Number(info.metadata[deadlineTag]);

    if (Number.isFinite(deadline) && deadline > 0) {
      deadlines.set(id, deadline);

      if (deadline <= Date.now()) {
        await Sandbox.kill(id, api());
        throw new SandboxError(
          "Sandbox lifetime expired. Its hard deadline passed. Create another sandbox.",
          { code: "not_found", provider: "e2b", sandboxId: id },
        );
      }
    }

    const box = await Sandbox.connect(id, {
      ...api(),
      timeoutMs: deadlines.has(id) ? Math.max(1, (deadlines.get(id) ?? 0) - Date.now()) : undefined,
    });

    clients.set(id, box);

    // Reconnect may precede the original creator's first guest operation.
    try {
      await box.files.getInfo("/workspace", { user: "root" });
      await box.files.write(workspaceMarker, "ready", { user: "root" });
      workspaces.delete(id);
    } catch (cause) {
      if (!missing(cause)) throw cause;

      try {
        await box.files.getInfo(workspaceMarker, { user: "root" });
        workspaces.delete(id);
      } catch (cause) {
        if (!missing(cause)) throw cause;
        workspaces.set(id, info.startedAt.getTime());
      }
    }

    // connect may lengthen the native timeout; clamp it back to the hard deadline.
    if (deadlines.has(id)) await box.setTimeout(Math.max(1, (deadlines.get(id) ?? 0) - Date.now()));
    attached(id);

    return { ...info, state: "running" };
  }

  async function client(id: string) {
    if (!clients.has(id)) await attach(id);
    const box = clients.get(id);

    if (!box)
      throw new SandboxError("Sandbox is detached. No local client exists. Connect first.", {
        code: "not_found",
        provider: "e2b",
        sandboxId: id,
      });

    return box;
  }

  async function reconcileWorkspace(id: string, box: E2BSandbox) {
    if (!workspaces.has(id)) return;

    try {
      await box.files.getInfo(workspaceMarker, { user: "root" });
      workspaces.delete(id);
    } catch (cause) {
      if (!missing(cause)) throw cause;
    }
  }

  async function list(metadata: Record<string, string>) {
    const { Sandbox } = await sdk();

    const pages = Sandbox.list({
      ...api(),
      query: { metadata: { ...metadata, "sandbox-sdk": "1" }, state: ["running", "paused"] },
    });

    const result: SandboxInfo[] = [];

    while (pages.hasNext) result.push(...(await pages.nextItems()).map(infoOf));

    return result;
  }

  async function groupSignal(box: E2BSandbox, pid: number, signal: "TERM" | "KILL") {
    await box.commands.run(`kill -${signal} -- -${pid} 2>/dev/null || true`, {
      user: "root",
      timeoutMs: 10_000,
      stdin: false,
    });
  }

  async function launch(id: string, input: Omit<ExecInput, "timeoutMs">) {
    const box = await client(id);
    // E2B supplies the launch PID out of band. Keep that PID as the group
    // leader: setsid must not fork when envd already made it a group leader.
    // /proc fields after the final ')' are state, parent PID, then group PID.
    // No user output is interpreted as transport metadata.
    const pending = workspaces.has(id);
    // envd rejects a missing cwd as an invalid request. Change directory in the
    // shell instead, so a bad cwd is a non-zero exit with the error on stderr.
    const command = `${pending ? `${prepareWorkspace}; ` : ""}cd ${quote(input.cwd)} && exec sh -c ${quote(input.command)}`;
    const script = `set -- "$(</proc/$$/stat)" || exit 125; set -- \${1##*) }; [[ "$3" =~ ^[0-9]+$ ]] || exit 125; if [[ "$3" = "$$" ]]; then exec sh -c ${quote(command)}; else exec setsid -w sh -c ${quote(command)}; fi`;

    const handle = await box.commands.run(script, {
      background: true,
      cwd: "/",
      envs: input.env,
      user: "root",
      stdin: input.stdin !== undefined,
      timeoutMs: 0,
      onStdout: (text) => input.onChunk({ stream: "stdout", text }),
      onStderr: (text) => input.onChunk({ stream: "stderr", text }),
    });

    const active = handles.get(id) ?? new Set<CommandHandle>();
    handles.set(id, active);
    active.add(handle);

    // Attach rejection handling immediately (a short command may already exit).
    const result = handle.wait().then(
      (value) => ({ exitCode: value.exitCode, signal: null }),
      async (cause) => {
        const { CommandExitError } = await sdk();

        if (cause instanceof CommandExitError) return { exitCode: cause.exitCode, signal: null };
        throw cause;
      },
    );

    void result.catch(() => {});

    try {
      if (input.stdin !== undefined) {
        try {
          await handle.sendStdin(input.stdin);
          await handle.closeStdin();
        } catch (cause) {
          // A command that ignores stdin can exit before delivery. Preserve its
          // exit result; only a still-running command makes delivery failure fatal.
          if (handle.exitCode === undefined) throw cause;
        }
      }

      const settled = result
        .then(async (value) => {
          if (pending) {
            if (value.exitCode >= 0 && value.exitCode < 128 && value.exitCode !== 125)
              workspaces.delete(id);
            else await reconcileWorkspace(id, box);
          }

          return value;
        })
        .finally(() => active.delete(handle));

      void settled.catch(() => {});

      return { box, handle, pid: handle.pid, result: settled };
    } catch (cause) {
      // Failed stdin delivery can leave work running; destroy before returning.
      await provider.destroy(id);
      throw cause;
    }
  }

  const provider: E2BProvider = {
    name: "e2b",
    keyMode: "best-effort",
    capabilities: new Set(["pause", "snapshot", "network-policy"]),
    create: (input) =>
      call(undefined, async () => {
        validate(input, options);
        const { Sandbox } = await sdk();
        const createdAt = Date.now();

        // An auto-paused sandbox outlives its timeout, so no hard deadline is recorded.
        const deadline =
          input.timeoutMs === undefined || options.autoPause
            ? undefined
            : createdAt + input.timeoutMs;

        const box = await Sandbox.create(input.from ?? options.template ?? "base", {
          ...api(),
          envs: input.env,
          metadata: {
            ...input.labels,
            "sandbox-sdk": "1",
            ...(input.key === undefined ? {} : { [keyTag]: input.key }),
            ...(deadline === undefined ? {} : { [deadlineTag]: String(deadline) }),
          },
          timeoutMs: input.timeoutMs,
          lifecycle: options.autoPause
            ? { onTimeout: "pause", autoResume: options.autoResume ?? false }
            : { onTimeout: "kill", autoResume: false },
          ...(input.network === "none"
            ? { allowInternetAccess: false }
            : typeof input.network === "object"
              ? {}
              : { allowInternetAccess: true }),
          ...(typeof input.network === "object" || options.public === false
            ? {
                network: {
                  ...(typeof input.network === "object"
                    ? { denyOut: ["0.0.0.0/0"], allowOut: input.network.allow }
                    : {}),
                  ...(options.public === false ? { allowPublicTraffic: false } : {}),
                },
              }
            : {}),
          ...(options.volumes === undefined ? {} : { volumeMounts: options.volumes }),
        });

        clients.set(box.sandboxId, box);

        if (deadline !== undefined) deadlines.set(box.sandboxId, deadline);

        try {
          if (input.signal?.aborted)
            throw new SandboxError(
              "Creation aborted. Cancellation arrived during E2B creation. Retry with a fresh signal.",
              { code: "aborted", provider: "e2b" },
            );

          // The native create object carries connection fields, not network policy.
          const info =
            input.network === "none" ||
            typeof input.network === "object" ||
            options.public === false
              ? await box.getInfo()
              : undefined;

          if (
            input.network === "none" &&
            info?.allowInternetAccess !== false &&
            !(info?.network?.denyOut?.includes("0.0.0.0/0") && !info?.network.allowOut?.length)
          )
            throw unsupported("E2B did not confirm that internet access is disabled");

          if (typeof input.network === "object") {
            const requested = input.network.allow;
            const allowed = info?.network?.allowOut ?? [];

            if (
              !info?.network?.denyOut?.includes("0.0.0.0/0") ||
              requested.some((host) => !allowed.includes(host)) ||
              allowed.some((host) => !requested.includes(host))
            )
              throw unsupported("E2B did not confirm the requested outbound allow list");
          }

          if (
            options.public === false &&
            (info?.network?.allowPublicTraffic !== false || !box.trafficAccessToken)
          )
            throw unsupported(
              "E2B did not confirm that preview URLs require a traffic access token",
            );
          workspaces.set(box.sandboxId, createdAt);

          if (input.from !== undefined) await reconcileWorkspace(box.sandboxId, box);

          if (input.signal?.aborted)
            throw new SandboxError("Creation aborted during E2B policy confirmation", {
              code: "aborted",
              provider: "e2b",
            });

          return {
            id: box.sandboxId,
            key: input.key,
            labels: { ...input.labels, "sandbox-sdk": "1" },
            state: "running",
            createdAt,
          };
        } catch (cause) {
          await provider.destroy(box.sandboxId);
          throw cause;
        }
      }),
    find: (key) =>
      call(undefined, async () => {
        const info = (await list({ [keyTag]: key }))[0];

        return info ? provider.connect(info.id) : undefined;
      }),
    connect: (id) => call(id, async () => infoOf(await attach(id))),
    list: (labels) => call(undefined, () => list(labels)),
    destroy: (id) =>
      call(id, async () => {
        const { Sandbox } = await sdk();
        await Sandbox.kill(id, api());
        clients.delete(id);
        workspaces.delete(id);
        deadlines.delete(id);
        attached(id);

        for (const handle of handles.get(id) ?? []) await handle.disconnect();
        handles.delete(id);
      }),
    close: (id) =>
      call(id, async () => {
        detach(id);

        for (const handle of handles.get(id) ?? []) await handle.disconnect();
        handles.delete(id);
        clients.delete(id);
      }),
    native(id) {
      const box = clients.get(id);

      if (!box)
        throw new SandboxError(
          "Sandbox client is detached. There is no cached native object. Connect the sandbox first.",
          { code: "not_found", provider: "e2b", sandboxId: id },
        );

      return box;
    },
    exec: (id, input) =>
      call(id, async () => {
        if (input.signal?.aborted) return { exitCode: null, timedOut: true };
        const started = Date.now();
        let cancelled = false;
        let cancel = () => {};

        const cancellation = new Promise<"cancelled">((resolve) => {
          cancel = () => {
            cancelled = true;
            resolve("cancelled");
          };
        });

        input.signal?.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(cancel, input.timeoutMs);

        try {
          const running = await launch(id, input);

          if (input.signal?.aborted || Date.now() - started >= input.timeoutMs) cancel();

          const outcome = cancelled
            ? "cancelled"
            : await Promise.race([running.result, cancellation]);

          if (outcome !== "cancelled") return { exitCode: outcome.exitCode, timedOut: false };

          // Stop bootstrap first: it may not have established its group yet.
          // The final group signal then catches every descendant it did launch.
          try {
            await running.handle.kill();
            await groupSignal(running.box, running.pid, "KILL");
          } catch (cause) {
            await provider.destroy(id);
            throw cause;
          }

          await running.result.catch(() => {});
          await running.handle.disconnect();

          return { exitCode: null, timedOut: true };
        } finally {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", cancel);
        }
      }),
    files: {
      writeCreatesParents: true,
      read: (id, path) =>
        call(
          id,
          async () =>
            new Uint8Array(
              await (await client(id)).files.read(path, { format: "bytes", user: "root" }),
            ),
          true,
        ),
      write: (id, path, data) =>
        call(
          id,
          async () => {
            const box = await client(id);

            if (handles.get(id)?.size) await reconcileWorkspace(id, box);

            if (posix.normalize(path) === "/workspace" && workspaces.has(id))
              throw new SandboxError("Cannot write a file over the workspace directory", {
                code: "invalid_argument",
                provider: "e2b",
                sandboxId: id,
              });

            if (workspaces.has(id) && posix.normalize(path).startsWith("/workspace/")) {
              await box.files.write(
                [
                  { path, data: new Uint8Array(data).buffer },
                  { path: workspaceMarker, data: "ready" },
                ],
                { user: "root" },
              );
              workspaces.delete(id);
            } else await box.files.write(path, new Uint8Array(data).buffer, { user: "root" });
          },
          true,
        ),
      list: (id, path) =>
        call(
          id,
          async () => {
            try {
              const entries = (
                await (await client(id)).files.list(path, { user: "root", depth: 1 })
              ).map(fileOf);

              if (handles.get(id)?.size) await reconcileWorkspace(id, await client(id));
              const createdAt = workspaces.get(id);

              if (
                posix.normalize(path) === "/" &&
                createdAt !== undefined &&
                !entries.some((entry) => entry.path === "/workspace")
              )
                entries.push({
                  path: "/workspace",
                  type: "directory",
                  size: 0,
                  modifiedAt: createdAt,
                });

              return entries;
            } catch (cause) {
              if (handles.get(id)?.size) await reconcileWorkspace(id, await client(id));

              if (posix.normalize(path) === "/workspace" && workspaces.has(id) && missing(cause))
                return [];
              throw cause;
            }
          },
          true,
        ),
      stat: (id, path) =>
        call(
          id,
          async () => {
            try {
              return fileOf(await (await client(id)).files.getInfo(path, { user: "root" }));
            } catch (cause) {
              if (handles.get(id)?.size) await reconcileWorkspace(id, await client(id));
              const createdAt = workspaces.get(id);

              if (
                posix.normalize(path) === "/workspace" &&
                createdAt !== undefined &&
                missing(cause)
              )
                return { path, type: "directory", size: 0, modifiedAt: createdAt };
              throw cause;
            }
          },
          true,
        ),
      mkdir: (id, path) =>
        call(
          id,
          async () => {
            const box = await client(id);

            if (workspaces.has(id)) {
              await box.commands.run(`${prepareWorkspace}; mkdir -p ${quote(path)}`, {
                user: "root",
                cwd: "/",
                stdin: false,
              });
              workspaces.delete(id);
            } else await box.files.makeDir(path, { user: "root" });
          },
          true,
        ),
      remove: (id, path, options) =>
        call(
          id,
          async () => {
            const box = await client(id);

            if (posix.normalize(path) === "/workspace" && workspaces.has(id)) {
              try {
                await box.commands.run(
                  `${prepareWorkspace}; if [ -L /workspace ]; then rm /workspace; else ${options.recursive ? "rm -rf" : "rmdir"} /workspace; fi`,
                  { user: "root", cwd: "/", stdin: false },
                );
                workspaces.delete(id);

                return;
              } catch (cause) {
                const { CommandExitError } = await sdk();

                if (!options.recursive && cause instanceof CommandExitError)
                  throw new SandboxError("Directory is not empty. Pass recursive: true.", {
                    code: "invalid_argument",
                    provider: "e2b",
                    sandboxId: id,
                  });
                throw cause;
              }
            }

            if (
              !options.recursive &&
              (await box.files.getInfo(path, { user: "root" })).type === "dir" &&
              (await box.files.list(path, { user: "root", depth: 1 })).length
            )
              throw new SandboxError(
                "Directory is not empty. Recursive removal was not requested. Pass recursive: true.",
                { code: "invalid_argument", provider: "e2b", sandboxId: id },
              );
            await box.files.remove(path, { user: "root" });
          },
          true,
        ),
    },
    previewUrl: (id, port) =>
      call(id, async () => {
        const box = await client(id);

        if (options.public !== false) return { url: `https://${box.getHost(port)}` };

        if (!box.trafficAccessToken)
          throw new SandboxError(
            "Preview access token is missing. E2B returned no traffic access token for this private sandbox. Reconnect, or create it with public previews.",
            { code: "unsupported", provider: "e2b", sandboxId: id },
          );

        return {
          url: `https://${box.getHost(port)}`,
          headers: { "e2b-traffic-access-token": box.trafficAccessToken },
        };
      }),
    pause: (id) =>
      call(id, async () => {
        detach(id);

        try {
          const { Sandbox } = await sdk();
          await Sandbox.pause(id, api());
          clients.delete(id);

          for (const handle of handles.get(id) ?? []) await handle.disconnect();
        } catch (cause) {
          attached(id);
          throw cause;
        }
      }),
    resume: (id) =>
      call(id, async () => {
        await attach(id);
      }),
    snapshot: (id, settings) =>
      call(id, async () => {
        if (settings?.expiresInMs)
          throw new SandboxError(
            "Snapshot expiry is unavailable. E2B keeps snapshots until you delete them. Omit expiresInMs, or pass 0.",
            { code: "unsupported", provider: "e2b", sandboxId: id },
          );
        const box = await client(id);

        if (workspaces.has(id)) {
          await box.commands.run(prepareWorkspace, { user: "root", cwd: "/", stdin: false });
          workspaces.delete(id);
        }

        return { id: (await box.createSnapshot()).snapshotId };
      }),
    startProcess: (id, input) =>
      call(id, async (): Promise<NativeProcess> => {
        const running = await launch(id, input);
        // envd reports -1 for a signalled process. Report what the other providers do:
        // 143 after stop() (it sends SIGTERM first), otherwise null, which core records as 137.
        let stopped = false;

        const exit = (exitCode: number) => ({
          exitCode: exitCode >= 0 ? exitCode : stopped ? 143 : null,
          signal: null,
        });

        return {
          pid: running.pid,
          wait: () =>
            call(id, async () => {
              try {
                return exit((await running.result).exitCode);
              } catch {}

              await detached.get(id)?.wait;

              const handle = await (
                await client(id)
              ).commands.connect(running.handle.pid, { timeoutMs: 0 });

              try {
                return exit((await handle.wait()).exitCode);
              } catch (cause) {
                const { CommandExitError } = await sdk();

                if (cause instanceof CommandExitError) return exit(cause.exitCode);
                throw cause;
              }
            }),
          stop: (options) =>
            call(id, async () => {
              stopped = true;
              await groupSignal(running.box, running.pid, "TERM");
              await sleep(options.graceMs);
              await running.handle.kill();
              await groupSignal(running.box, running.pid, "KILL");
            }),
        };
      }),
  };

  return provider;
}

function validate(input: CreateInput, options: E2BOptions) {
  if (options.autoResume && !options.autoPause)
    throw new SandboxError(
      "autoResume requires autoPause. E2B can only wake a sandbox it paused. Set autoPause: true or drop autoResume.",
      { code: "invalid_argument", provider: "e2b" },
    );

  if (input.size !== undefined)
    throw unsupported(
      "Machine size is fixed by the E2B template; small, medium, large and custom sizes are unavailable at creation",
    );

  if (input.idleTimeoutMs !== undefined)
    throw unsupported(
      "E2B timeouts measure elapsed time, not idle time; idleTimeoutMs is unavailable",
    );

  if (input.labels[keyTag] !== undefined || input.labels[deadlineTag] !== undefined)
    throw new SandboxError(
      "Reserved E2B metadata key. SDK lifecycle metadata must not be overwritten. Rename the label.",
      { code: "invalid_argument", provider: "e2b" },
    );
}
