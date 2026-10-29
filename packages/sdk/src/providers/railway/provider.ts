/** Official API references (railway 3.16.0):
 * https://docs.railway.com/sandboxes
 * https://docs.railway.com/sandboxes/quickstart
 * https://docs.railway.com/integrations/api
 * https://github.com/railwayapp/railway-ts-sdk
 * Calls and pagination fields also checked against railway/dist/index.d.ts and
 * its generated RailwaySandboxes query. No control-plane labels API exists;
 * discovery reads a versioned marker file from each running VM instead.
 */
import { posix } from "node:path";
import type {
  Sandbox,
  SandboxTemplate,
  CreateOptions,
  ConnectOptions,
  ExecHandle,
  ExecOptions,
  FileReadOptions,
  FileWriteOptions,
  SandboxFileEntry,
} from "railway";
import { loadPeer } from "../../peer.js";
import type { Provider, SandboxInfo, Labels, FileInfo, ExecInput } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { quote } from "../../shared/shell.js";
import {
  railwayError,
  rememberRailwayErrors,
  unsupported,
  type RailwayErrorClasses,
} from "./errors.js";

export type RailwayOptions = {
  /** Defaults to RAILWAY_API_TOKEN; required for authentication. */
  token?: CreateOptions["token"];
  /** Defaults to RAILWAY_ENVIRONMENT_ID; required for authentication. */
  environmentId?: CreateOptions["environmentId"];
  /** Deployment region; default: the Railway service default. */
  region?: CreateOptions["region"];
  /** Network isolation; default: the native Railway SDK setting. */
  networkIsolation?: CreateOptions["networkIsolation"];
  /** Token kind; default: the native Railway SDK authentication mode. */
  authType?: CreateOptions["authType"];
  /** vCPUs (fractions allowed) and memory in decimal GB, such as `{ cpu: 2, memoryGB: 4 }`. Railway caps both at the workspace's VM maximum. Default: the plan default. */
  resources?: CreateOptions["resources"];
} & (
  | {
      /** Base template; default: the Railway service default; mutually exclusive with checkpoint. */
      template?: SandboxTemplate;
      checkpoint?: never;
    }
  | {
      template?: never;
      /** Checkpoint to restore; default: none; mutually exclusive with template. */
      checkpoint?: string;
    }
);

const marker = "/tmp/.sandbox-sdk/railway.json";

/** Every exec carries a unique value in this variable, so a follow-up exec can find and kill what it left behind. */
const execTag = "SANDBOX_SDK_EXEC_ID";

// One grep reads every environ file (NUL-separated, so -z), then each match is killed.
const reapCommand = (token: string) =>
  `for f in $(grep -lzx ${quote(`${execTag}=${token}`)} /proc/[0-9]*/environ 2>/dev/null); do p=\${f#/proc/}; kill -KILL "\${p%/environ}" 2>/dev/null; done; true`;

type Metadata = { version: 1; key?: string; labels: Labels };

/** The marker before its labels are checked one by one. */
function isMarker(data: unknown): data is { version: 1; key?: string; labels: object } {
  return (
    typeof data === "object" &&
    data !== null &&
    "version" in data &&
    data.version === 1 &&
    "labels" in data &&
    typeof data.labels === "object" &&
    data.labels !== null &&
    !Array.isArray(data.labels) &&
    (!("key" in data) || data.key === undefined || typeof data.key === "string")
  );
}

function isLabelValue(value: unknown): value is string {
  return typeof value === "string";
}

function metadata(text: string): Metadata {
  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    throw new SandboxError("Invalid Railway SDK metadata", {
      code: "not_found",
      provider: "railway",
    });
  }

  if (!isMarker(data))
    throw new SandboxError("Invalid Railway SDK metadata", {
      code: "not_found",
      provider: "railway",
    });
  const labels: Labels = {};

  for (const [key, value] of Object.entries(data.labels)) {
    if (!isLabelValue(value))
      throw new SandboxError("Invalid Railway SDK label", {
        code: "not_found",
        provider: "railway",
      });
    // defineProperty, so a "__proto__" label stays an ordinary label.
    Object.defineProperty(labels, key, { value, enumerable: true });
  }

  return { version: 1, key: data.key, labels };
}

/** The page of sandbox IDs in a RailwaySandboxes query response. */
function isListResponse(data: unknown): data is { data: { sandboxes: unknown } } {
  return (
    typeof data === "object" &&
    data !== null &&
    !("errors" in data && data.errors) &&
    "data" in data &&
    typeof data.data === "object" &&
    data.data !== null &&
    "sandboxes" in data.data
  );
}

function isConnection(value: unknown): value is { edges: unknown[]; pageInfo: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "edges" in value &&
    Array.isArray(value.edges) &&
    "pageInfo" in value
  );
}

function isSandboxEdge(edge: unknown): edge is { node: { id: string } } {
  return (
    typeof edge === "object" &&
    edge !== null &&
    "node" in edge &&
    typeof edge.node === "object" &&
    edge.node !== null &&
    "id" in edge.node &&
    typeof edge.node.id === "string"
  );
}

function isPageInfo(page: unknown): page is { hasNextPage: boolean } {
  return (
    typeof page === "object" &&
    page !== null &&
    "hasNextPage" in page &&
    typeof page.hasNextPage === "boolean"
  );
}

function hasCursor(page: {
  hasNextPage: boolean;
}): page is { hasNextPage: boolean; endCursor: string } {
  return "endCursor" in page && typeof page.endCursor === "string";
}

/** The parts of a Railway sandbox the adapter uses. */
export type RailwayBox = Pick<
  Sandbox,
  "id" | "createdAt" | "status" | "domains" | "checkpoint" | "destroy"
> & {
  files: {
    read(path: string): Promise<string>;
    read(path: string, options: FileReadOptions & { format: "bytes" }): Promise<Uint8Array>;
    write(path: string, data: Uint8Array, options?: FileWriteOptions): Promise<void>;
    list(path: string): Promise<SandboxFileEntry[]>;
    stat(path: string): Promise<SandboxFileEntry>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
  };
  exec(command: string, options: ExecOptions): Pick<ExecHandle, "then" | "stdin">;
};

/** The parts of the Railway SDK the adapter uses: the real `railway` module, or a test fixture. */
export interface RailwayModule<B extends RailwayBox> extends RailwayErrorClasses {
  Sandbox: {
    create(options: CreateOptions): Promise<B>;
    create(checkpointName: string, options: CreateOptions): Promise<B>;
    create(template: SandboxTemplate, options: CreateOptions): Promise<B>;
    connect(id: string, options: ConnectOptions): Promise<B>;
  };
  DEFAULT_RAILWAY_GRAPHQL_ENDPOINT: string;
}

function info(box: RailwayBox, data: Metadata): SandboxInfo {
  const createdAt = Date.parse(box.createdAt);

  if (!Number.isFinite(createdAt)) throw new Error("Invalid Railway creation time");

  return {
    id: box.id,
    key: data.key,
    labels: data.labels,
    state: box.status === "RUNNING" ? "running" : "stopped",
    createdAt,
  };
}

export type RailwayProvider = Provider<Sandbox, "snapshot">;

/** @internal The adapter behind `railway()`. `load` imports the Railway SDK; tests pass a fixture. */
export function createRailwayProvider<B extends RailwayBox>(
  options: RailwayOptions,
  load: () => Promise<RailwayModule<B>>,
): Provider<B, "snapshot"> {
  let module: Promise<RailwayModule<B>> | undefined;

  const sdk = () =>
    (module ??= loadPeer("railway", "railway", load).then((loaded) => {
      rememberRailwayErrors(loaded);

      return loaded;
    }));

  const api = () => ({
    token: options.token ?? process.env.RAILWAY_API_TOKEN,
    environmentId: options.environmentId ?? process.env.RAILWAY_ENVIRONMENT_ID,
    authType: options.authType,
  });

  const clients = new Map<string, B>();
  // Ownership of sandboxes this provider created or connected. A VM that is not
  // RUNNING cannot serve its marker file, so list() falls back to this record.
  const owned = new Map<string, Metadata>();

  async function call<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (cause) {
      throw railwayError(cause, id);
    }
  }

  async function client(id: string) {
    const cached = clients.get(id);

    if (cached) return cached;
    const { Sandbox } = await sdk();
    const box = await Sandbox.connect(id, api());
    clients.set(id, box);

    return box;
  }

  // The SDK list() drops pageInfo. Read IDs through the same documented public
  // GraphQL connection, then use SDK clients for all sandbox operations.
  async function ids(): Promise<string[]> {
    const config = api();

    if (!config.token || !config.environmentId)
      throw new SandboxError(
        "Railway credentials are missing. Authentication requires a token and environment ID. Set RAILWAY_API_TOKEN and RAILWAY_ENVIRONMENT_ID or pass token and environmentId.",
        { code: "auth", provider: "railway" },
      );
    const result: string[] = [];
    let after: string | null = null;

    do {
      const response = await fetch((await sdk()).DEFAULT_RAILWAY_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.authType === "project-token"
            ? { "Project-Access-Token": config.token }
            : { Authorization: `Bearer ${config.token}` }),
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          query:
            "query SandboxSdkRailwayList($environmentId: String!, $after: String) { sandboxes(environmentId: $environmentId, first: 100, after: $after) { edges { node { id } } pageInfo { hasNextPage endCursor } } }",
          variables: { environmentId: config.environmentId, after },
        }),
      });

      if (!response.ok)
        throw Object.assign(new Error("Railway list failed"), { status: response.status });
      const data: unknown = await response.json();

      if (!isListResponse(data)) throw new Error("Invalid Railway list response");
      const connection = data.data.sandboxes;

      if (!isConnection(connection)) throw new Error("Invalid Railway connection");

      for (const edge of connection.edges) {
        if (!isSandboxEdge(edge)) throw new Error("Invalid Railway sandbox ID");
        result.push(edge.node.id);
      }

      const page = connection.pageInfo;

      if (!isPageInfo(page)) throw new Error("Invalid Railway pagination");

      if (!page.hasNextPage) break;

      if (!hasCursor(page) || !page.endCursor || page.endCursor === after)
        throw new Error("Missing Railway cursor");
      after = page.endCursor;
    } while (after !== null);

    return result;
  }

  /** Kill every process that still carries this exec's tag, including descendants that left its process group. */
  async function reap(id: string, token: string): Promise<boolean> {
    try {
      const result = await execute(
        id,
        { command: reapCommand(token), cwd: "/", env: {}, timeoutMs: 15_000, onChunk() {} },
        false,
      );

      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  const unconfirmed = (id: string) =>
    new SandboxError(
      "Command outcome unknown. Railway did not confirm that the command stopped, and the cleanup command failed. Check the sandbox, or destroy it if the command must not keep running.",
      { code: "outcome_unknown", provider: "railway", sandboxId: id },
    );

  // A timeout or abort kills only the command. The SDK signals its process group
  // and confirms the exit. When that confirmation is lost, Railway still cleans up
  // the group of an ephemeral exec on disconnect, and a tagged follow-up kill
  // covers the rest. The sandbox is never destroyed for a command's sake.
  async function execute(id: string, input: ExecInput, cleanup = true) {
    if (input.signal?.aborted) return { exitCode: null, timedOut: true };
    const box = await client(id);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, input.timeoutMs);
    input.signal?.addEventListener("abort", abort, { once: true });

    if (input.signal?.aborted) abort();
    const token = crypto.randomUUID();

    try {
      const handle = box.exec(input.command, {
        cwd: input.cwd,
        env: { ...input.env, [execTag]: token },
        stdin: input.stdin !== undefined,
        ephemeral: true,
        captureOutput: false,
        signal: controller.signal,
        onStdout: (text) => input.onChunk({ stream: "stdout", text }),
        onStderr: (text) => input.onChunk({ stream: "stderr", text }),
      });

      const completion = Promise.resolve(handle);
      // Stdin delivery runs before the result is awaited; a rejection then must not go unhandled.
      void completion.catch(() => {});

      try {
        if (input.stdin !== undefined) {
          try {
            await handle.stdin.write(input.stdin);
            await handle.stdin.end();
          } catch {
            // Railway rejects pending writes when a command exits before reading
            // all input. A confirmed exit is authoritative, even after EPIPE.
            // If it is still running, the deadline/abort signal bounds this wait.
            await completion;
          }
        }

        const result = await completion;

        // A null exit after a native deadline means the kill was not confirmed.
        if (result.timedOut && result.exitCode === null && cleanup && !(await reap(id, token)))
          throw unconfirmed(id);

        return { exitCode: result.timedOut ? null : result.exitCode, timedOut: result.timedOut };
      } catch (cause) {
        if (cause instanceof SandboxError && cause.code === "outcome_unknown") throw cause;

        // The SDK rejects with the abort reason only after confirmed group termination.
        if (controller.signal.aborted) {
          // It rejects with the abort reason once the group is gone; only settling matters.
          await completion.catch(() => {});

          if (cause !== controller.signal.reason && cleanup && !(await reap(id, token)))
            throw unconfirmed(id);

          return { exitCode: null, timedOut: true };
        }

        // A lost connection leaves the outcome unknown. Stop the command, then report it.
        if (cleanup && railwayError(cause, id).code === "outcome_unknown") await reap(id, token);
        throw cause;
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  }

  async function stat(id: string, path: string): Promise<FileInfo> {
    let output = "";

    const result = await execute(id, {
      command: `stat -c '%f %s %Y' -- ${quote(path)}`,
      cwd: "/",
      env: {},
      timeoutMs: 30_000,
      onChunk: (chunk) => {
        if (chunk.stream === "stdout") output += chunk.text;
      },
    });

    if (result.exitCode !== 0) {
      // Native stat distinguishes missing files from transport/permission errors.
      await (await client(id)).files.stat(path);
      throw new Error("Railway stat command failed");
    }

    const [modeText, sizeText, timeText] = output.trim().split(/\s+/);
    const mode = Number.parseInt(modeText ?? "", 16);
    const size = Number(sizeText);
    const modifiedAt = Number(timeText) * 1000;

    if (![mode, size, modifiedAt].every(Number.isFinite))
      throw new Error("Invalid Railway stat output");

    return {
      path,
      type:
        (mode & 0xf000) === 0xa000 ? "symlink" : (mode & 0xf000) === 0x4000 ? "directory" : "file",
      size,
      modifiedAt,
    };
  }

  const provider: Provider<B, "snapshot"> = {
    name: "railway",
    commandShell: "bash",
    keyMode: "best-effort",
    capabilities: new Set(["snapshot"]),
    create: (input) =>
      call(undefined, async () => {
        if (input.size !== undefined)
          unsupported(
            "Railway resources set CPU and memory but cannot set diskGb; size presets and exact sizes are unavailable",
          );

        if (input.network !== undefined && input.network !== "all")
          unsupported("Railway isolation modes retain outbound internet access");

        if (input.timeoutMs !== undefined)
          unsupported(
            "Railway has no hard sandbox lifetime; idle destruction is not a lifetime limit",
          );

        if (input.signal?.aborted)
          throw new SandboxError(
            "Creation aborted. The signal was cancelled. Retry with a fresh signal.",
            { code: "aborted", provider: "railway" },
          );

        if (
          input.ports &&
          (input.ports.length > 10 || new Set(input.ports).size !== input.ports.length)
        )
          unsupported("Railway accepts at most 10 unique preview ports");

        if (input.ports?.length && options.networkIsolation === "ISOLATED")
          unsupported("Public domains require PRIVATE networking");

        if (
          input.idleTimeoutMs !== undefined &&
          (!Number.isFinite(input.idleTimeoutMs) || input.idleTimeoutMs <= 0)
        )
          throw new SandboxError(
            "Invalid idle timeout. A positive duration is required. Set idleTimeoutMs above zero.",
            { code: "invalid_argument", provider: "railway" },
          );
        const { Sandbox } = await sdk();

        const config: CreateOptions = {
          ...api(),
          region: options.region,
          env: input.env,
          idleTimeoutMinutes:
            input.idleTimeoutMs === undefined ? undefined : Math.ceil(input.idleTimeoutMs / 60_000),
          networkIsolation: input.ports?.length ? "PRIVATE" : options.networkIsolation,
          domains: input.ports?.map((port) => ({ port })),
        };

        if (options.resources !== undefined) config.resources = options.resources;

        const checkpoint = input.from ?? options.checkpoint;
        const source = checkpoint ?? options.template;
        let box: B;

        if (checkpoint !== undefined) box = await Sandbox.create(checkpoint, config);
        else if (options.template !== undefined)
          box = await Sandbox.create(options.template, config);
        else box = await Sandbox.create(config);

        clients.set(box.id, box);

        try {
          if (input.signal?.aborted)
            throw new SandboxError(
              "Creation aborted. Cancellation arrived while provisioning. Retry with a fresh signal.",
              { code: "aborted", provider: "railway" },
            );

          const data: Metadata = {
            version: 1,
            key: input.key,
            labels: { ...input.labels, "sandbox-sdk": "1" },
          };

          // The marker is required for discovery from another client. Fold the
          // workspace and restore cleanup into the same guest request.
          const cleanup =
            source === undefined
              ? ""
              : `for d in /tmp/.sandbox-sdk/procs/*; do [ -f "$d/spec.json" ] && [ ! -f "$d/exit" ] && printf 137 > "$d/exit"; done; rm -rf /tmp/.sandbox-sdk/runs; `;

          const result = await execute(box.id, {
            command: `mkdir -p /workspace /tmp/.sandbox-sdk && { ${cleanup}printf %s ${quote(JSON.stringify(data))} > ${quote(marker)}; }`,
            cwd: "/",
            env: {},
            timeoutMs: 30_000,
            onChunk() {},
          });

          if (result.timedOut || result.exitCode !== 0)
            throw new Error("Railway workspace and ownership initialization failed");

          if (input.signal?.aborted)
            throw new SandboxError(
              "Creation aborted. Cancellation arrived during initialization. Retry with a fresh signal.",
              { code: "aborted", provider: "railway" },
            );
          owned.set(box.id, data);

          return info(box, data);
        } catch (cause) {
          await provider.destroy(box.id);
          throw cause;
        }
      }),
    connect: (id) =>
      call(id, async () => {
        const { Sandbox } = await sdk();
        const box = await Sandbox.connect(id, api());
        clients.set(id, box);
        const data = metadata(await box.files.read(marker));
        owned.set(id, data);

        return info(box, data);
      }),
    find: (key) =>
      call(undefined, async () => (await provider.list({})).find((box) => box.key === key)),
    list: (labels) =>
      call(undefined, async () => {
        const result: SandboxInfo[] = [];

        // Railway has no stopped state: CREATING and FAILED VMs still exist and can be
        // destroyed. Their ownership comes from the marker when it is readable, or from
        // this provider's own record. Unproven VMs are never listed, so never reaped.
        for (const id of await ids()) {
          try {
            const { Sandbox } = await sdk();
            const box = await Sandbox.connect(id, api());

            if (box.status === "DESTROYED" || box.status === "DESTROYING") continue;
            let data: Metadata | undefined;

            try {
              data = metadata(await box.files.read(marker));
            } catch (cause) {
              data = owned.get(id);

              if (box.status === "RUNNING" && !data) throw cause;
            }

            if (
              data &&
              data.labels["sandbox-sdk"] === "1" &&
              Object.entries(labels).every(([key, value]) => data.labels[key] === value)
            )
              result.push(info(box, data));
          } catch (cause) {
            if (!["not_found", "file_not_found"].includes(railwayError(cause, id).code))
              throw cause;
          }
        }

        return result;
      }),
    destroy: (id) =>
      call(id, async () => {
        try {
          await (await client(id)).destroy();
        } catch (cause) {
          if (railwayError(cause, id).code !== "not_found") throw cause;
        }

        clients.delete(id);
        owned.delete(id);
      }),
    close: async (id) => {
      clients.delete(id);
    },
    native(id) {
      const box = clients.get(id);

      if (!box)
        throw new SandboxError(
          "Sandbox client is detached. No cached Railway object exists. Connect first.",
          { code: "not_found", provider: "railway", sandboxId: id },
        );

      return box;
    },
    exec: (id, input) => call(id, () => execute(id, input)),
    files: {
      writeCreatesParents: true,
      writeSupportsMode: true,
      read: (id, path) =>
        call(id, async () => (await client(id)).files.read(path, { format: "bytes" })),
      readRange: (id, path, range) =>
        call(id, async () =>
          range.length === 0
            ? new Uint8Array()
            : (await client(id)).files.read(path, { format: "bytes", ...range }),
        ),
      write: (id, path, data, settings) =>
        call(id, async () => {
          await (
            await client(id)
          ).files.write(
            path,
            data,
            settings?.mode === undefined ? undefined : { mode: settings.mode },
          );
        }),
      mkdir: (id, path) =>
        call(id, async () => {
          await (await client(id)).files.mkdir(path);
        }),
      stat: (id, path) => call(id, () => stat(id, path)),
      list: (id, path) =>
        call(id, async () => {
          const entries = await (await client(id)).files.list(path);
          const result: FileInfo[] = [];

          for (const entry of entries) result.push(await stat(id, posix.join(path, entry.name)));

          return result;
        }),
      remove: (id, path, opts) =>
        call(id, async () => {
          const box = await client(id);

          if (!opts.recursive) {
            await box.files.remove(path);

            return;
          }

          const result = await execute(id, {
            command: `rm -rf -- ${quote(path)}`,
            cwd: "/",
            env: {},
            timeoutMs: 30_000,
            onChunk() {},
          });

          if (result.exitCode !== 0) throw new Error("Railway recursive removal failed");
        }),
    },
    previewUrl: (id, port) =>
      call(id, async () => {
        const box = await client(id);
        const domain = box.domains.find((domain) => domain.port === port);

        if (!domain)
          unsupported("The preview port was not declared at creation; pass ports to createSandbox");

        return { url: `https://${domain.domain}` };
      }),
    snapshot: (id, settings) =>
      call(id, async () => {
        if (settings?.expiresInMs)
          unsupported(
            "Checkpoint expiry is unavailable; Railway keeps checkpoints until you delete them. Omit expiresInMs, or pass 0",
          );

        return {
          id: (await (await client(id)).checkpoint(`sandbox-sdk-${crypto.randomUUID()}`)).key,
        };
      }),
  };

  return provider;
}
