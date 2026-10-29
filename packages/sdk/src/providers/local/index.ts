import { createHash, randomUUID } from "node:crypto";
import type { Provider, SandboxInfo, FileInfo, CreateInput } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { Docker, object, string, number, array, encode, failure, parse } from "./docker.js";

/** One Docker mount. Anonymous volumes and tmpfs mounts are removed with the container; named volumes and bind sources are not. */
export interface LocalMount {
  type: "bind" | "volume" | "tmpfs";
  /** Host path for bind, volume name for volume (omit for an anonymous volume). Not used by tmpfs. */
  source?: string;
  /** Absolute path inside the container. */
  target: string;
  readOnly?: boolean;
}

export interface LocalOptions {
  /** Default: node:22-bookworm; requires git, tar, setsid, nohup, mkfifo and GNU sed. */
  image?: string;
  /** Defaults to DOCKER_HOST, then unix:///var/run/docker.sock; absolute unix:// sockets only. */
  dockerHost?: string;
  /** Image platform for pull and create, such as linux/amd64. Default: the daemon's platform. */
  platform?: string;
  /** User commands and file operations run as: name, uid or uid:gid. Default: the image user. /workspace is given to this user. */
  user?: string;
  /** OCI runtime, such as runsc (gVisor) or sysbox-runc. Default: the daemon default, usually runc. */
  runtime?: string;
  /** User-defined Docker network to join. Default: bridge. `network: "none"` still wins; host and container modes are rejected. */
  networkMode?: string;
  /** Bind mounts, volumes and tmpfs mounts. Default: none. */
  mounts?: LocalMount[];
  /** Maximum processes in the container. Default: unlimited. */
  pidsLimit?: number;
  /** /dev/shm size in MB. Default: Docker's 64 MB. */
  shmSizeMb?: number;
  /** Linux capabilities to add, such as SYS_ADMIN. Default: none. */
  capAdd?: string[];
  /** Linux capabilities to drop, such as NET_RAW. Default: none. */
  capDrop?: string[];
  /** Docker security options, such as seccomp=unconfined or no-new-privileges. Default: none. */
  securityOpt?: string[];
}

export interface LocalNative {
  readonly id: string;
  readonly client: Docker;
}

type LocalCapability = "pause" | "snapshot" | "size" | "network-policy";

const deadlineLabel = "sandbox-sdk.local.deadline";
const idleLabel = "sandbox-sdk.local.idle-ms";
const activity = "/tmp/.sandbox-sdk-activity";
const keyLabel = "sandbox-sdk.local.key";
const snapshotLabel = "sandbox-sdk.local.snapshot";

/** Adapter bookkeeping kept in Docker labels. Callers see only their labels and `sandbox-sdk`. A restored container inherits its image's snapshot label. */
const internal = new Set([deadlineLabel, idleLabel, keyLabel, snapshotLabel]);

const userLabels = (labels: Record<string, string>) =>
  Object.fromEntries(Object.entries(labels).filter(([key]) => !internal.has(key)));

const name = (key: string) => `sandbox-sdk-${createHash("sha256").update(key).digest("hex")}`;
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const presets = {
  small: { cpu: 1, memoryMb: 1024 },
  medium: { cpu: 2, memoryMb: 4096 },
  large: { cpu: 4, memoryMb: 8192 },
};

function limits(size: CreateInput["size"]) {
  if (!size) return {};

  if (typeof size !== "string" && size.diskGb !== undefined)
    throw failure(
      "Docker cannot enforce diskGb portably; pass only cpu and memoryMb, or use small, medium, or large",
      "unsupported",
    );
  const value = typeof size === "string" ? presets[size] : size;

  if (!value) throw failure("Unknown size preset", "unsupported");

  if (
    !(value.cpu > 0) ||
    !Number.isFinite(value.cpu) ||
    !Number.isSafeInteger(value.memoryMb) ||
    value.memoryMb < 6
  )
    throw failure("Custom sizes need cpu above 0 and memoryMb of at least 6", "invalid_argument");

  return {
    NanoCpus: Math.round(value.cpu * 1e9),
    Memory: value.memoryMb * 1024 * 1024,
    MemorySwap: value.memoryMb * 1024 * 1024,
  };
}

function samePlatform(image: unknown, platform: string) {
  const value = object(image);

  return platform.startsWith(`${String(value.Os)}/${String(value.Architecture)}`);
}

const positive = (value: number | undefined, label: string) => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
    throw failure(`${label} must be a positive integer`, "invalid_argument");
};

/** Validates adapter options once and returns the HostConfig fields they add. */
function hostOptions(options: LocalOptions) {
  positive(options.pidsLimit, "pidsLimit");
  positive(options.shmSizeMb, "shmSizeMb");
  const mode = options.networkMode;

  if (
    mode !== undefined &&
    (!mode || mode === "host" || mode === "none" || mode.startsWith("container:"))
  )
    throw failure(
      "networkMode must name a bridge-style network; host and container modes break localhost previews and network: none",
      "unsupported",
    );

  for (const mount of options.mounts ?? []) {
    if (!["bind", "volume", "tmpfs"].includes(mount.type) || !mount.target.startsWith("/"))
      throw failure(
        "Mounts need type bind, volume or tmpfs and an absolute target",
        "invalid_argument",
      );

    if (
      mount.type === "bind"
        ? !mount.source?.startsWith("/")
        : mount.type === "tmpfs" && mount.source !== undefined
    )
      throw failure(
        "Bind mounts need an absolute host source; tmpfs mounts take none",
        "invalid_argument",
      );
  }

  return {
    ...(options.runtime === undefined ? {} : { Runtime: options.runtime }),
    ...(options.mounts?.length
      ? {
          Mounts: options.mounts.map((m) => ({
            Type: m.type,
            Target: m.target,
            ...(m.source === undefined ? {} : { Source: m.source }),
            ReadOnly: m.readOnly ?? false,
          })),
        }
      : {}),
    ...(options.pidsLimit === undefined ? {} : { PidsLimit: options.pidsLimit }),
    ...(options.shmSizeMb === undefined ? {} : { ShmSize: options.shmSizeMb * 1024 * 1024 }),
    ...(options.capAdd?.length ? { CapAdd: options.capAdd } : {}),
    ...(options.capDrop?.length ? { CapDrop: options.capDrop } : {}),
    ...(options.securityOpt?.length ? { SecurityOpt: options.securityOpt } : {}),
  };
}

/** The container's info plus its raw labels, which carry the adapter's deadline and idle settings. */
function inspected(value: unknown): { info: SandboxInfo; labels: Record<string, string> } {
  const raw = object(value);
  const config = object(raw.Config);
  const state = object(raw.State);

  const labels = Object.fromEntries(
    Object.entries(object(config.Labels ?? {})).map(([k, v]) => [k, string(v)]),
  );

  if (labels["sandbox-sdk"] !== "1")
    throw failure("Container was not created by Sandbox SDK", "not_found");

  return {
    info: {
      id: string(raw.Id),
      key: labels[keyLabel] || undefined,
      labels: userLabels(labels),
      state: state.Paused ? "paused" : state.Running ? "running" : "stopped",
      createdAt: Date.parse(string(raw.Created)),
    },
    labels,
  };
}

const info = (value: unknown): SandboxInfo => inspected(value).info;

export type LocalProvider = Provider<LocalNative, LocalCapability>;

/** Local Docker Engine transport. No Docker CLI or daemon inside the container. */
export function local(options: LocalOptions = {}): LocalProvider {
  const client = new Docker(options.dockerHost);
  const image = options.image ?? "node:22-bookworm";
  const host = hostOptions(options);
  const platform = options.platform ? `&platform=${encode(options.platform)}` : "";
  const destroying = new Map<string, Promise<void>>();
  const timers = new Set<string>();
  const timings = new Map<string, Record<string, number>>();
  const inspect = (id: string) => client.call("GET", `/containers/${encode(id)}/json`);

  async function raw(id: string, command: string[], stdin?: string) {
    let stdout = "";
    let stderr = "";

    const tracked = timers.has(id)
      ? [
          "sh",
          "-c",
          `touch ${activity}; "$@"; code=$?; touch ${activity}; exit "$code"`,
          "sh",
          ...command,
        ]
      : command;

    const code = await client.exec(id, tracked, {
      stdin,
      onChunk(chunk) {
        if (chunk.stream === "stdout") stdout += chunk.text;
        else stderr += chunk.text;
      },
    });

    if (code !== 0)
      throw failure(
        `Container operation exited ${code}: ${stderr}`,
        stderr.includes("ENOENT") || stderr.includes("No such file")
          ? "file_not_found"
          : "provider",
      );

    return stdout;
  }

  const node = (id: string, script: string, args: string[] = [], stdin?: string) =>
    raw(id, ["node", "-e", script, ...args], stdin);

  const statScript = `const fs=require('fs'); const p=require('path'); const stat=x=>{const s=fs.lstatSync(x);return {path:x,type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':'file',size:s.size,modifiedAt:s.mtimeMs}};`;

  function fileInfo(value: unknown): FileInfo {
    const item = object(value);
    const type = item.type;

    if (type !== "file" && type !== "directory" && type !== "symlink")
      throw failure("Invalid file type");

    return {
      path: string(item.path),
      type,
      size: number(item.size),
      modifiedAt: number(item.modifiedAt),
    };
  }

  const provider: LocalProvider = {
    name: "local",
    keyMode: "exact",
    capabilities: new Set<LocalCapability>(["pause", "snapshot", "size", "network-policy"]),
    async create(input) {
      if (typeof input.network === "object")
        throw failure(
          "Network allow-lists cannot be enforced by this Docker adapter",
          "unsupported",
        );

      for (const value of [input.idleTimeoutMs, input.timeoutMs])
        if (value !== undefined && (!Number.isFinite(value) || value <= 0))
          throw failure("Timeouts must be positive milliseconds", "invalid_argument");
      const resources = limits(input.size);

      if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
      const phases: Record<string, number> = {};
      let phase = performance.now();
      const source = input.from ?? image;
      let present: boolean;

      try {
        const found = await client.call("GET", `/images/${encode(source)}/json`);
        // A cached image for another platform must be pulled for the requested one.
        present =
          !options.platform || input.from !== undefined || samePlatform(found, options.platform);
      } catch (error) {
        if (!(error instanceof SandboxError) || error.code !== "not_found") throw error;

        if (input.from) throw failure("Snapshot image not found", "not_found");
        present = false;
      }

      if (!present)
        await client.call("POST", `/images/create?fromImage=${encode(source)}${platform}`);
      phases.createInspectMs = performance.now() - phase;

      if (input.signal?.aborted) throw failure("Creation aborted after image pull", "aborted");
      const ports = [...new Set(input.ports ?? [3000])];

      const bindings = Object.fromEntries(
        ports.map((port) => [`${port}/tcp`, [{ HostIp: "127.0.0.1", HostPort: "" }]]),
      );

      phase = performance.now();
      const createdAt = Date.now();

      // Always set the timer labels: a snapshot image carries its source's, and Docker merges image labels into the container's.
      const labels = {
        ...input.labels,
        "sandbox-sdk": "1",
        [keyLabel]: input.key ?? "",
        [deadlineLabel]: input.timeoutMs === undefined ? "" : String(createdAt + input.timeoutMs),
        [idleLabel]: input.idleTimeoutMs === undefined ? "" : String(input.idleTimeoutMs),
      };

      const created = object(
        await client.call(
          "POST",
          `/containers/create?name=${encode(input.key ? name(input.key) : `sandbox-sdk-${randomUUID()}`)}${input.from === undefined ? platform : ""}`,
          {
            Image: source,
            WorkingDir: "/workspace",
            Cmd: ["sh", "-c", "exec sleep infinity"],
            ...(options.user === undefined ? {} : { User: options.user }),
            Env: Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`),
            Labels: labels,
            ExposedPorts: Object.fromEntries(ports.map((port) => [`${port}/tcp`, {}])),
            HostConfig: {
              ...host,
              ...resources,
              NetworkMode: input.network === "none" ? "none" : (options.networkMode ?? "bridge"),
              PortBindings: input.network === "none" ? {} : bindings,
              Init: true,
            },
          },
        ),
      );

      phases.createContainerMs = performance.now() - phase;
      const id = string(created.Id);
      timings.set(id, phases);

      if (input.timeoutMs !== undefined || input.idleTimeoutMs !== undefined) timers.add(id);

      try {
        phase = performance.now();
        await client.call("POST", `/containers/${encode(id)}/start`);
        phases.createStartMs = performance.now() - phase;
        // Docker creates WorkingDir as root before start. A configured user needs to own it.
        phase = performance.now();

        if (options.user !== undefined) {
          const code = await client.exec(id, ["chown", "--", options.user, "/workspace"], {
            user: "0",
            onChunk() {},
          });

          if (code !== 0)
            throw failure(`Could not give /workspace to user ${options.user}`, "invalid_argument");
        }

        phases.createPrerequisiteMs = performance.now() - phase;

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");

        if (input.timeoutMs !== undefined || input.idleTimeoutMs !== undefined)
          return await provider.connect(id);

        return { id, key: input.key, labels: userLabels(labels), state: "running", createdAt };
      } catch (error) {
        await provider.destroy(id);
        throw error;
      }
    },
    async find(key) {
      try {
        const found = await provider.connect(name(key));

        return found.key === key ? found : undefined;
      } catch (error) {
        if (error instanceof SandboxError && error.code === "not_found") return undefined;
        throw error;
      }
    },
    async connect(id) {
      const { info: current, labels } = inspected(await inspect(id));
      const limit = (value: string | undefined) => (value ? Number(value) : Infinity);

      const deadline = limit(labels[deadlineLabel]),
        idle = limit(labels[idleLabel]);

      if (Number.isFinite(deadline) || Number.isFinite(idle)) timers.add(current.id);
      let expired = Date.now() >= deadline;

      if (!expired && Number.isFinite(idle) && current.state === "running") {
        let last = "";

        const code = await client.exec(
          current.id,
          [
            "node",
            "-e",
            `const f=require('fs'), p='/tmp/.sandbox-sdk';const busy=(f.existsSync(p+'/runs')&&f.readdirSync(p+'/runs').length)||(f.existsSync(p+'/procs')&&f.readdirSync(p+'/procs').some(n=>!f.existsSync(p+'/procs/'+n+'/exit')));process.stdout.write(String(busy?Date.now():Math.max(${current.createdAt},f.existsSync('${activity}')?f.statSync('${activity}').mtimeMs:0)))`,
          ],
          {
            onChunk(chunk) {
              if (chunk.stream === "stdout") last += chunk.text;
            },
          },
        );

        if (code !== 0 || !Number.isFinite(Number(last)))
          throw failure("Could not check local idle deadline", "provider");
        expired = Date.now() - Number(last) >= idle;
      }

      if (expired) {
        await provider.destroy(current.id);
        throw failure("Local sandbox deadline expired; create another sandbox", "not_found");
      }

      return current;
    },
    async list(labels) {
      const filters = encode(
        JSON.stringify({
          label: Object.entries({ ...labels, "sandbox-sdk": "1" }).map(([k, v]) => `${k}=${v}`),
        }),
      );

      const containers = array(
        await client.call("GET", `/containers/json?all=1&filters=${filters}`),
      );

      const result: SandboxInfo[] = [];

      for (const item of containers) {
        try {
          result.push(info(await inspect(string(object(item).Id))));
        } catch (error) {
          if (!(error instanceof SandboxError) || error.code !== "not_found") throw error;
        }
      }

      return result;
    },
    async destroy(id) {
      const pending = destroying.get(id);

      if (pending) return pending;

      const task = (async () => {
        try {
          const current = info(await inspect(id));

          if (current.state === "paused")
            await client.call("POST", `/containers/${encode(id)}/unpause`);

          if (current.state !== "stopped")
            await client.call("POST", `/containers/${encode(id)}/stop?t=1`);
          await client.call("DELETE", `/containers/${encode(id)}?force=1&v=1`);
        } catch (error) {
          if (!(error instanceof SandboxError) || error.code !== "not_found") throw error;
        }
      })();

      destroying.set(id, task);

      try {
        await task;
      } finally {
        destroying.delete(id);
        timers.delete(id);
        timings.delete(id);
      }
    },
    async exec(id, input) {
      const started = performance.now();

      if (input.signal?.aborted) return { exitCode: null, timedOut: true };
      const pidfile = `/tmp/.sandbox-sdk-exec-${randomUUID()}`;
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

      // The wrapper writes its session leader PID before running any user code. It
      // changes directory itself: a missing cwd then fails as a shell error on stderr,
      // not as Docker's OCI chdir error on stdout.
      const command = [
        "setsid",
        "--wait",
        "sh",
        "-c",
        `echo $$ > ${quote(pidfile)}; ${timers.has(id) ? `touch ${activity}; trap 'touch ${activity}' EXIT;` : ""} cd ${quote(input.cwd)} || exit; sh -c ${quote(input.command)}`,
      ];

      const execution = client.exec(id, command, {
        env: input.env,
        stdin: input.stdin,
        onChunk: input.onChunk,
      });

      void execution.catch(() => {});

      try {
        await Promise.race([execution, cancellation]);

        if (cancelled) {
          // Wait for the PID publication if cancellation raced exec startup. No
          // success is reported until the negative-PID kill has been delivered.
          await raw(id, [
            "sh",
            "-c",
            `i=0; while [ ! -s ${quote(pidfile)} ]; do i=$((i+1)); [ "$i" -lt 3000 ] || exit 1; sleep .01; done; p=$(cat ${quote(pidfile)}); node -e 'try {process.kill(-Number(process.argv[1]), "SIGKILL")} catch(e) {if(e.code!=="ESRCH") throw e}' "$p"`,
          ]);
        }

        const exitCode = await execution;

        return { exitCode: cancelled ? null : exitCode, timedOut: cancelled };
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", cancel);
        await raw(id, ["rm", "-f", pidfile]).catch(() => {});
        const phases = timings.get(id);

        if (phases && phases.firstCommandMs === undefined)
          phases.firstCommandMs = performance.now() - started;
      }
    },
    files: {
      writeCreatesParents: true,
      writeSupportsMode: true,
      async read(id, path) {
        return new Uint8Array(
          Buffer.from(
            await node(
              id,
              "process.stdout.write(require('fs').readFileSync(process.argv[1]).toString('base64'))",
              [path],
            ),
            "base64",
          ),
        );
      },
      // One exec writes, creates parents and applies the exact mode, unaffected by umask.
      async write(id, path, data, options) {
        await node(
          id,
          "const f=require('fs'),p=process.argv[1];f.mkdirSync(require('path').dirname(p),{recursive:true});f.writeFileSync(p,Buffer.from(f.readFileSync(0,'utf8'),'base64'));if(process.argv[2])f.chmodSync(p,parseInt(process.argv[2],8))",
          [path, options?.mode === undefined ? "" : options.mode.toString(8)],
          Buffer.from(data).toString("base64"),
        );
      },
      async stat(id, path) {
        return fileInfo(
          parse(
            await node(
              id,
              statScript + "process.stdout.write(JSON.stringify(stat(process.argv[1])))",
              [path],
            ),
          ),
        );
      },
      async list(id, path) {
        return array(
          parse(
            await node(
              id,
              statScript +
                "process.stdout.write(JSON.stringify(fs.readdirSync(process.argv[1]).map(x=>stat(p.join(process.argv[1],x)))))",
              [path],
            ),
          ),
        ).map(fileInfo);
      },
      async mkdir(id, path) {
        await node(id, "require('fs').mkdirSync(process.argv[1],{recursive:true})", [path]);
      },
      async remove(id, path, options) {
        await node(
          id,
          "require('fs').rmSync(process.argv[1],{recursive:process.argv[2]==='true'})",
          [path, String(options.recursive)],
        );
      },
    },
    async previewUrl(id, port) {
      const data = object(await inspect(id));
      const settings = object(data.NetworkSettings);
      const ports = object(settings.Ports ?? {});
      const binding = array(ports[`${port}/tcp`] ?? [])[0];

      if (!binding)
        throw failure(
          `Port ${port} has no localhost mapping; declare it in ports when creating the sandbox`,
          "unsupported",
        );
      const entry = object(binding);

      if (entry.HostIp !== "127.0.0.1")
        throw failure("Preview binding is not loopback", "unsupported");

      return { url: `http://127.0.0.1:${string(entry.HostPort)}/` };
    },
    native(id) {
      return { id, client };
    },
    async usage(id) {
      const value = object(await inspect(id));
      const state = object(value.State);

      return {
        ...timings.get(id),
        runningMs:
          state.Running && !state.Paused
            ? Math.max(0, Date.now() - Date.parse(string(state.StartedAt)))
            : 0,
      };
    },
    async pause(id) {
      await provider.connect(id);
      await client.call("POST", `/containers/${encode(id)}/pause`);
    },
    async resume(id) {
      await provider.connect(id);
      await client.call("POST", `/containers/${encode(id)}/unpause`);
    },
    async snapshot(id, options) {
      if (options?.expiresInMs)
        throw failure(
          "Docker images do not expire; omit expiresInMs and delete the snapshot image when you are done",
          "unsupported",
        );
      await provider.connect(id);

      const value = object(
        await client.call("POST", `/commit?container=${encode(id)}&pause=true`, {
          Labels: { "sandbox-sdk": "1", [snapshotLabel]: "1" },
        }),
      );

      return { id: string(value.Id) };
    },
  };

  return provider;
}
