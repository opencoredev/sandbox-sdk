import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Readable } from "node:stream";
import type { NetworkPolicy, Sandbox, SandboxMounts, SandboxRegion } from "@vercel/sandbox";
import type { Provider, CreateInput, SandboxInfo, FileInfo, ExecInput } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { quote } from "../../shared/shell.js";
import { apiCode, unsupported, vercelError } from "./errors.js";
import type { NativeSandbox, VercelClient } from "./transport.js";

type NativeCreate = NonNullable<Parameters<typeof Sandbox.create>[0]>;

/** A git repository or tarball that Vercel puts in `/vercel/sandbox` on a fresh sandbox. */
export type VercelSource = Exclude<NonNullable<NativeCreate["source"]>, { type: "snapshot" }>;

/** A Vercel Container Registry image, such as `vercel/sandbox/node:24` or `my-repo:v1`. */
export type VercelImage = NonNullable<NativeCreate["image"]>;

/** A legacy Vercel runtime (Amazon Linux 2023), such as `node24`. */
export type VercelRuntime = NonNullable<NativeCreate["runtime"]>;

type VercelBaseOptions = {
  token?: string;
  teamId?: string;
  projectId?: string;
  /** Keep the file system when the sandbox stops, so `pause()` and `resume()` work. Default: true. With false, a sandbox that stops (timeout, `snapshot()`) cannot run again. */
  persistent?: boolean;
  /** Git repository or tarball for fresh sandboxes; ignored with `from`. Default: none. */
  source?: VercelSource;
  /** Region for new sessions. Default: `iad1`. */
  region?: SandboxRegion;
  /** Regions to fail over to, in order; must not include `region`. Default: none. */
  failoverRegions?: SandboxRegion[];
  /** Full native network policy (subnets, header injection, proxying). Default: allow all. Pass this or `network` to `createSandbox`, not both. */
  networkPolicy?: NetworkPolicy;
  /** Secure Compute private network ID. Default: none. */
  networkId?: string;
  /** Vercel drives keyed by absolute mount path. Default: none. */
  mounts?: SandboxMounts;
  /** Default lifetime of every snapshot of this sandbox, including the automatic ones that persistence relies on. `0` never expires; otherwise at least one day. Default: Vercel's. */
  snapshotExpiresInMs?: number;
  /** Keep only the newest `count` (1 to 10) snapshots. `expiresInMs` defaults to `snapshotExpiresInMs`; `deleteEvicted` defaults to true. */
  keepLastSnapshots?: { count: number; expiresInMs?: number; deleteEvicted?: boolean };
  /** Delete the sandbox's snapshots that no other sandbox uses when it is destroyed. Snapshots you have not restored yet count as unused. Default: false. */
  deleteOrphanSnapshots?: boolean;
  /** Fetch implementation for Vercel API calls. Default: `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
};

export type VercelOptions = VercelBaseOptions &
  (
    | {
        /** Base image for fresh sandboxes; ignored with `from`. Default: `vercel/sandbox/universal:latest`. */
        image?: VercelImage;
        runtime?: never;
      }
    | {
        image?: never;
        /** Legacy runtime for fresh sandboxes; ignored with `from`. Prefer `image`. */
        runtime?: VercelRuntime;
      }
  );

export type VercelCapability = "pause" | "snapshot" | "network-policy" | "size";

/** A non-persistent sandbox loses its files when it stops, so it cannot pause. */
export type VercelNonPersistentCapability = Exclude<VercelCapability, "pause">;

const day = 86_400_000;

function invalid(message: string): never {
  throw new SandboxError(message, { code: "invalid_argument", provider: "vercel" });
}

function expiration(ms: number | undefined, name: string): number | undefined {
  if (ms !== undefined && (!Number.isSafeInteger(ms) || (ms !== 0 && ms < day)))
    invalid(
      `${name} must be 0 (never expires) or at least ${day} ms (one day). Vercel rejects shorter snapshot lifetimes.`,
    );

  return ms;
}

const keyTag = "sandbox-sdk-key";
const keyName = (key: string) => `sdk-${createHash("sha256").update(key).digest("hex")}`;
const workspace = `flock -x /tmp/.sandbox-sdk-workspace-ready.lock sh -c 'if [ ! -f /tmp/.sandbox-sdk/prepared-workspace ]; then sudo mkdir -p /workspace && sudo chmod 777 /workspace && mkdir -p /tmp/.sandbox-sdk && touch /tmp/.sandbox-sdk/prepared-workspace || exit 1; fi' || exit 1`;
const guestStat = `stat --printf '%n\\0%f %s %y\\0' --`;

function decodeStats(text: string): FileInfo[] {
  const fields = text.split("\0");

  if (fields.pop() !== "" || fields.length % 2) throw new Error("Invalid Vercel file metadata");
  const result: FileInfo[] = [];

  for (let i = 0; i < fields.length; i += 2) {
    const path = fields[i],
      line = fields[i + 1];

    const match = line?.match(/^([0-9a-f]+) ([0-9]+) (.+)$/);

    if (path === undefined || !match) throw new Error("Invalid Vercel stat response");

    const mode = Number.parseInt(match[1] ?? "", 16),
      size = Number(match[2]),
      modifiedAt = Date.parse(match[3] ?? "");

    if (![mode, size, modifiedAt].every(Number.isFinite))
      throw new Error("Invalid Vercel stat fields");
    result.push({
      path,
      type:
        (mode & 0xf000) === 0xa000 ? "symlink" : (mode & 0xf000) === 0x4000 ? "directory" : "file",
      size,
      modifiedAt,
    });
  }

  return result;
}

// Files survive a session; processes do not. Invalidate inherited live records.
const invalidate = `for d in /tmp/.sandbox-sdk/procs/*; do [ -f "$d/spec.json" ] && [ ! -f "$d/exit" ] && printf 137 > "$d/exit"; done; rm -rf /tmp/.sandbox-sdk/runs; true`;

/** Internal injection point used by the offline SDK contract tests. */
export function createVercelProvider<N extends NativeSandbox>(
  load: () => Promise<VercelClient<N>>,
  options: VercelOptions = {},
): Provider<N, VercelCapability> {
  const boxes = new Map<string, N>();
  const prepared = new Set<string>();
  const persistent = options.persistent ?? true;
  const keep = options.keepLastSnapshots;

  if (
    keep !== undefined &&
    (!Number.isSafeInteger(keep.count) || keep.count < 1 || keep.count > 10)
  )
    invalid("keepLastSnapshots.count must be a whole number from 1 to 10.");

  const snapshotSettings = {
    snapshotExpiration: expiration(options.snapshotExpiresInMs, "snapshotExpiresInMs"),
    keepLastSnapshots: keep && {
      count: keep.count,
      expiration: expiration(keep.expiresInMs, "keepLastSnapshots.expiresInMs"),
      deleteEvicted: keep.deleteEvicted,
    },
  };

  let client: Promise<VercelClient<N>> | undefined;
  const sdk = () => (client ??= load());

  const safe = async <T>(id: string | undefined, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      // On an existing sandbox, a missing snapshot means the session cannot resume: it was not
      // persistent, or its persistence snapshot expired. Without an ID it is a missing `from` snapshot.
      if (id !== undefined && apiCode(error) === "snapshot_not_found")
        throw new SandboxError(
          "Sandbox session has ended. Vercel has no saved file system to resume from, because the sandbox is not persistent or its snapshot expired. Destroy it and create a new sandbox.",
          { code: "not_found", provider: "vercel", sandboxId: id },
        );
      throw vercelError(error, id);
    }
  };

  const api = () => ({
    ...credentials(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  function credentials() {
    const token = options.token ?? process.env.VERCEL_TOKEN;
    const teamId = options.teamId ?? process.env.VERCEL_TEAM_ID;
    const projectId = options.projectId ?? process.env.VERCEL_PROJECT_ID;

    if (token) {
      if (!teamId || !projectId)
        throw new SandboxError(
          "Vercel credentials are incomplete. Token authentication requires teamId and projectId. Set VERCEL_TEAM_ID and VERCEL_PROJECT_ID.",
          { code: "auth", provider: "vercel" },
        );

      return { token, teamId, projectId };
    }

    // Let the SDK resolve and refresh the deployment's OIDC context. Supplying
    // partial credentials prevents that SDK path, so omit all three together.
    return {};
  }

  const clean = async (box: NativeSandbox, workspaceReady = false) => {
    const cmd = await box.runCommand({
      cmd: "sh",
      args: [
        "-c",
        invalidate +
          (workspaceReady
            ? "; mkdir -p /tmp/.sandbox-sdk && touch /tmp/.sandbox-sdk/prepared-workspace"
            : ""),
      ],
      detached: true,
    });

    if ((await cmd.wait()).exitCode !== 0)
      throw new Error("Could not invalidate restored processes");
  };

  const native = (id: string): N => {
    const box = boxes.get(id);

    if (!box)
      throw new SandboxError(
        "Sandbox is not attached. No local native object exists. Connect the sandbox first.",
        { code: "not_found", provider: "vercel", sandboxId: id },
      );

    return box;
  };

  function info(box: N): SandboxInfo {
    const labels = { ...box.tags };
    const key = labels[keyTag];
    delete labels[keyTag];

    return {
      id: box.name,
      key,
      labels,
      createdAt: box.createdAt.getTime(),
      state:
        box.status === "running" || box.status === "pending"
          ? "running"
          : box.status === "stopped" && box.persistent
            ? "paused"
            : "stopped",
    };
  }

  // A non-persistent sandbox in a final state has no file system to resume.
  const dead = (box: N) =>
    !box.persistent &&
    (box.status === "stopped" || box.status === "failed" || box.status === "aborted");

  const attach = async (id: string, resume = false) => {
    const client = await sdk();
    let box = await client.get({ ...api(), name: id, resume, onResume: clean });
    const deadline = Date.now() + 60_000;

    while (box.tags?.["sandbox-sdk"] === "pending") {
      if (Date.now() >= deadline)
        throw new SandboxError(
          "Sandbox initialization is incomplete. The creator has not finished setup. Retry connection later.",
          { code: "unavailable", provider: "vercel", sandboxId: id, retryable: true },
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
      box = await client.get({ ...api(), name: id, resume: false, onResume: clean });
    }

    boxes.set(id, box);

    return box;
  };

  const get = async (id: string) => boxes.get(id) ?? attach(id);

  function resources(size: CreateInput["size"]) {
    if (size === undefined) return undefined;

    if (typeof size === "string") return { vcpus: { small: 1, medium: 2, large: 4 }[size] };

    if (
      Number.isSafeInteger(size.cpu) &&
      size.cpu > 0 &&
      size.memoryMb === size.cpu * 2048 &&
      size.diskGb === undefined
    )
      return { vcpus: size.cpu };
    unsupported(
      "Custom sizes need a whole number of vCPUs, memoryMb equal to 2048 per vCPU, and no diskGb; Vercel derives memory from vCPUs and has no disk setting",
    );
  }

  const fileInfo = async (id: string, path: string): Promise<FileInfo> => {
    const stat = await (await get(id)).fs.lstat(path);

    return {
      path,
      type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    };
  };

  async function initialFile(
    id: string,
    script: string,
    args: string[],
    data?: Uint8Array,
  ): Promise<string | undefined> {
    if (prepared.has(id) || !(args[0] === "/workspace" || args[0]?.startsWith("/workspace/")))
      return undefined;
    const box = await get(id);

    // First-use setup and the file operation share one native command. A guest
    // marker makes initialization idempotent across clients and concurrent ops.
    const command = await box.runCommand({
      cmd: "sh",
      args: ["-c", `${workspace}; ${script}`, "sh", ...args],
      cwd: "/",
      env: { LC_ALL: "C" },
      stdin: data === undefined ? false : Readable.from([data]),
      detached: true,
    });

    let output = "",
      stderr = "";

    const logs = (async () => {
      for await (const chunk of command.logs()) {
        if (chunk.stream === "stdout") output += chunk.data;
        else stderr += chunk.data;
      }
    })();

    const [exit] = await Promise.all([command.wait(), logs]);

    if (exit.exitCode !== 0) {
      if (/No such file or directory/.test(stderr)) throw vercelError({ code: "ENOENT" }, id);

      if (/Not a directory|Directory not empty/.test(stderr))
        throw vercelError({ code: "ENOTDIR" }, id);
      throw new Error("Vercel workspace or file operation failed");
    }

    prepared.add(id);

    return output;
  }

  async function launch(box: N, input: ExecInput, timeoutMs: number) {
    const path = `/tmp/sandbox-sdk-${crypto.randomUUID()}.pid`;
    // GNU timeout owns this new session's process group. Its remote timer
    // survives client loss and leaves no sleeping watchdog behind on success.
    const errorPath = `${path}.error`;
    const inner = `${prepared.has(box.name) ? "" : `(${workspace}) || { echo setup-error > ${quote(errorPath)}; exit 125; }; `}cd ${quote(input.cwd)} || { echo cwd-error > ${quote(errorPath)}; exit 125; }; exec sh -c ${quote(input.command)}`;
    const wrapper = `echo $$ > ${quote(path)}; exec timeout --signal=KILL ${timeoutMs / 1000}s sh -c ${quote(inner)}`;

    const command = await box.runCommand({
      cmd: "setsid",
      args: ["--wait", "sh", "-c", wrapper],
      cwd: "/",
      env: input.env,
      stdin: input.stdin === undefined ? false : Readable.from([input.stdin]),
      detached: true,
    });

    let pid: number | undefined;

    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          pid = Number((await box.fs.readFile(path)).toString());

          if (Number.isInteger(pid) && pid > 0) break;
        } catch (error) {
          if (vercelError(error, box.name).code !== "file_not_found") throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      if (!pid || !Number.isInteger(pid)) {
        await command.kill("SIGKILL");
        throw new SandboxError(
          "Command launch could not be confirmed. Remote process ID was unavailable. Reconnect and inspect the sandbox.",
          { code: "outcome_unknown", provider: "vercel" },
        );
      }

      await box.fs.rm(path, { force: true });
    } catch (error) {
      // A failed PID read/removal must not strand a detached command. Recover
      // the remote PID in a separate control command when the read failed.
      const target =
        pid && Number.isInteger(pid) && pid > 0 ? String(pid) : `$(cat ${quote(path)})`;

      const control = await box.runCommand({
        cmd: "sh",
        args: [
          "-c",
          `pid=${target}; case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -KILL -"$pid" 2>/dev/null || true`,
        ],
        detached: true,
      });

      if ((await control.wait()).exitCode !== 0)
        throw new SandboxError(
          "Command launch cleanup could not be confirmed. The remote PID is unavailable. Inspect or destroy the sandbox.",
          { code: "outcome_unknown", provider: "vercel", sandboxId: box.name },
        );
      await command.wait();
      throw error;
    }

    const group = pid;

    const kill = async (signal: "KILL" | "TERM") => {
      const control = await box.runCommand({
        cmd: "sh",
        args: ["-c", `kill -${signal} -${group} 2>/dev/null || true`],
        detached: true,
      });

      await control.wait();
    };

    return { command, pid, kill, errorPath };
  }

  const provider: Provider<N, VercelCapability> = {
    name: "vercel",
    keyMode: "exact",
    capabilities: new Set<VercelCapability>(
      persistent
        ? ["pause", "snapshot", "network-policy", "size"]
        : ["snapshot", "network-policy", "size"],
    ),
    native,
    create: (input) =>
      safe(undefined, async () => {
        if (input.idleTimeoutMs !== undefined)
          unsupported("idleTimeoutMs is not exposed by the Vercel SDK");

        const tags = {
          ...input.labels,
          "sandbox-sdk": "1",
          ...(input.key === undefined ? {} : { [keyTag]: input.key }),
        };

        if (Object.keys(tags).length > 5)
          unsupported(
            "Vercel supports at most five tags, including sandbox-sdk and sandbox-sdk-key",
          );

        if (new Set(input.ports).size > 15)
          unsupported("Vercel supports at most fifteen declared ports");

        if (input.network !== undefined && options.networkPolicy !== undefined)
          invalid("Pass network to createSandbox or networkPolicy to vercel(), not both.");

        const networkPolicy =
          input.network === "none"
            ? "deny-all"
            : typeof input.network === "object"
              ? { allow: input.network.allow }
              : input.network === "all"
                ? "allow-all"
                : (options.networkPolicy ?? "allow-all");

        // Vercel's timeout bounds each session; every resume starts a full new one.
        const common = {
          ...api(),
          name: input.key === undefined ? `sdk-${crypto.randomUUID()}` : keyName(input.key),
          persistent,
          timeout: input.timeoutMs === undefined ? undefined : Math.ceil(input.timeoutMs),
          env: input.env,
          tags,
          ports: input.ports,
          resources: resources(input.size),
          networkPolicy,
          networkId: options.networkId,
          region: options.region,
          failoverRegions: options.failoverRegions,
          mounts: options.mounts,
          ...snapshotSettings,
          signal: input.signal,
          onResume: clean,
        } satisfies Parameters<typeof Sandbox.create>[0];

        const pending = { ...common, tags: { ...tags, "sandbox-sdk": "pending" } };

        // A snapshot fixes the base file system, so image, runtime and source apply only to fresh sandboxes.
        const base =
          options.image !== undefined
            ? { image: options.image }
            : options.runtime !== undefined
              ? { runtime: options.runtime }
              : {};

        const box = await (
          await sdk()
        ).create(
          input.from
            ? { ...pending, source: { type: "snapshot", snapshotId: input.from } }
            : {
                ...common,
                ...base,
                ...(options.source === undefined ? {} : { source: options.source }),
              },
        );

        boxes.set(box.name, box);

        try {
          if (!input.from) return info(box);

          const init = await box.runCommand({
            cmd: "sh",
            args: ["-c", "mkdir -p /workspace && chmod 777 /workspace"],
            sudo: true,
            detached: true,
          });

          if ((await init.wait()).exitCode !== 0)
            throw new Error("Could not initialize /workspace");
          await clean(box, true);
          await box.update({ tags });
          prepared.add(box.name);

          return info(box);
        } catch (error) {
          await box.delete();
          boxes.delete(box.name);
          throw error;
        }
      }),
    find: (key) =>
      safe(undefined, async () => {
        let box: N;

        try {
          box = await attach(keyName(key));
        } catch (error) {
          if (vercelError(error).code === "not_found") return undefined;
          throw error;
        }

        if (box.tags?.["sandbox-sdk"] !== "1" || box.tags[keyTag] !== key) return undefined;

        // Like Vercel's getOrCreate: a keyed sandbox that can never resume is replaced.
        if (dead(box)) {
          await provider.destroy(box.name);

          return undefined;
        }

        return info(box);
      }),
    connect: (id) => safe(id, async () => info(await attach(id))),
    list: (labels) =>
      safe(undefined, async () => {
        const result: SandboxInfo[] = [];

        for await (const entry of await (
          await sdk()
        ).list({ ...api(), tags: { "sandbox-sdk": "1" } })) {
          try {
            const item = info(await attach(entry.name));

            if (
              item.labels["sandbox-sdk"] === "1" &&
              Object.entries(labels).every(([k, v]) => item.labels[k] === v)
            )
              result.push(item);
          } catch (error) {
            if (vercelError(error, entry.name).code !== "not_found") throw error;
          }
        }

        return result;
      }),
    destroy: (id) =>
      safe(id, async () => {
        try {
          await (
            await get(id)
          ).delete(options.deleteOrphanSnapshots ? { deleteOrphanSnapshots: true } : undefined);
        } catch (error) {
          if (vercelError(error).code !== "not_found") throw error;
        }

        boxes.delete(id);
        prepared.delete(id);
      }),
    exec: (id, input) =>
      safe(id, async () => {
        if (input.signal?.aborted) return { exitCode: null, timedOut: true };
        const started = Date.now();
        const box = await get(id);
        const task = await launch(box, input, input.timeoutMs);
        let timedOut = false;
        let stopping: Promise<void> | undefined;

        const abort = () => {
          timedOut = true;
          stopping ??= task.kill("KILL");
          void stopping.catch(() => {});
        };

        input.signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, Math.max(0, input.timeoutMs - (Date.now() - started)));

        if (input.signal?.aborted) abort();

        try {
          const logs = (async () => {
            for await (const chunk of task.command.logs())
              input.onChunk({ stream: chunk.stream, text: chunk.data });
          })();

          const [exit] = await Promise.all([task.command.wait(), logs]);

          // The remote watchdog also enforces the deadline if this client disconnects.
          if (exit.exitCode === 137 && Date.now() - started >= input.timeoutMs) timedOut = true;
          await stopping;

          if (!timedOut && exit.exitCode === 125) {
            let failure: string | undefined;

            try {
              failure = (await box.fs.readFile(task.errorPath)).toString().trim();
            } catch (error) {
              if (vercelError(error, id).code !== "file_not_found") throw error;
            }

            if (failure !== undefined) {
              await box.fs.rm(task.errorPath, { force: true });
              throw new SandboxError(
                "Command could not start. Workspace initialization or the requested working directory failed. Check the directory and sandbox permissions.",
                {
                  code: failure === "cwd-error" ? "invalid_argument" : "provider",
                  provider: "vercel",
                  sandboxId: id,
                },
              );
            }
          }

          if (!timedOut && exit.exitCode === 0) prepared.add(id);

          return { exitCode: timedOut ? null : exit.exitCode, timedOut };
        } catch (error) {
          await task.kill("KILL");
          await task.command.wait();
          throw error;
        } finally {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
        }
      }),
    files: {
      writeCreatesParents: true,
      writeSupportsMode: true,
      read: (id, path) =>
        safe(id, async () => {
          const value = await initialFile(id, 'base64 -- "$1"', [path]);

          return value === undefined
            ? new Uint8Array(await (await get(id)).fs.readFile(path))
            : new Uint8Array(Buffer.from(value, "base64"));
        }),
      write: (id, path, data, settings = {}) =>
        safe(id, async () => {
          const { mode } = settings;

          const initial =
            mode === undefined
              ? await initialFile(
                  id,
                  'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
                  [path],
                  data,
                )
              : await initialFile(
                  id,
                  'mkdir -p -- "$(dirname -- "$1")" && (umask 077 && cat > "$1") && chmod -- "$2" "$1"',
                  [path, mode.toString(8)],
                  data,
                );

          if (initial !== undefined) return;
          const box = await get(id);
          await box.fs.mkdir(posix.dirname(path), { recursive: true });

          if (mode === undefined) {
            await box.fs.writeFile(path, data);

            return;
          }

          // The upload applies permission bits but drops setuid, setgid and sticky.
          await box.writeFiles([{ path, content: data, mode: mode & 0o777 }]);

          if (mode & 0o7000) await box.fs.chmod(path, mode);
        }),
      stat: (id, path) =>
        safe(id, async () => {
          const value = await initialFile(id, `${guestStat} "$1"`, [path]);

          if (value === undefined) return fileInfo(id, path);
          const entry = decodeStats(value)[0];

          if (!entry) throw new Error("Missing Vercel stat response");

          return entry;
        }),
      list: (id, path) =>
        safe(id, async () => {
          const value = await initialFile(
            id,
            `if [ ! -d "$1" ]; then if [ -e "$1" ] || [ -L "$1" ]; then echo 'Not a directory' >&2; else echo 'No such file or directory' >&2; fi; exit 1; fi; find -H "$1" -mindepth 1 -maxdepth 1 -exec ${guestStat} {} +`,
            [path],
          );

          if (value === undefined)
            return Promise.all(
              (await (await get(id)).fs.readdir(path)).map((name) =>
                fileInfo(id, posix.join(path, name)),
              ),
            );

          return decodeStats(value);
        }),
      mkdir: (id, path) =>
        safe(id, async () => {
          if ((await initialFile(id, 'mkdir -p -- "$1"', [path])) !== undefined) return;
          await (await get(id)).fs.mkdir(path, { recursive: true });
        }),
      remove: (id, path, settings) =>
        safe(id, async () => {
          if (
            (await initialFile(id, 'if [ "$2" = true ]; then rm -r -- "$1"; else rm -- "$1"; fi', [
              path,
              String(settings.recursive),
            ])) !== undefined
          )
            return;
          await (await get(id)).fs.rm(path, { recursive: settings.recursive });
        }),
    },
    previewUrl: (id, port) =>
      safe(id, async () => {
        const box = await get(id);

        if (!box.routes.some((route) => route.port === port))
          throw new SandboxError(
            `Port ${port} was not declared at creation. Vercel needs ports in CreateInput. Recreate with ports: [${port}].`,
            { code: "invalid_argument", provider: "vercel", sandboxId: id },
          );

        return { url: box.domain(port) };
      }),
    close: async (id) => {
      boxes.delete(id);
      prepared.delete(id);
    },
    pause: (id) =>
      safe(id, async () => {
        await (await get(id)).stop();
      }),
    resume: (id) =>
      safe(id, async () => {
        await attach(id, true);
      }),
    snapshot: (id, settings = {}) =>
      safe(id, async () => {
        const expiresInMs = expiration(settings.expiresInMs, "expiresInMs");

        return {
          id: (
            await (
              await get(id)
            ).snapshot(expiresInMs === undefined ? undefined : { expiration: expiresInMs })
          ).snapshotId,
        };
      }),
  };

  return provider;
}
