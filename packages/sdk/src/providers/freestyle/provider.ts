/** Verified against freestyle 0.2.20 (the current SDK, not freestyle-sandboxes).
 * https://www.freestyle.sh/docs/quickstart
 * https://www.freestyle.sh/docs/vms/network/firewall
 * https://www.freestyle.sh/docs/vms/network/tls-inbound
 */
import { createHash } from "node:crypto";
import type {
  CreateSnapshotOptions,
  CreateTlsRuleOptions,
  CreateVmOptions,
  ExecOptions,
  ExecResult,
  FirewallRuleData,
  FreestyleApiError,
  FreestyleClient,
  FreestyleOptions as FreestyleClientOptions,
  InlineFirewallRule,
  ListVmsOptions,
  ListVmsResult,
  ReadFileOptions,
  SnapshotCreated,
  TlsRuleData,
  Vm,
  VmData,
  WriteFileOptions,
} from "freestyle";
import { loadPeer } from "../../peer.js";
import type { Provider, SandboxInfo, CreateInput } from "../../provider.js";
import { files, python, type Guest } from "../../shared/guest.js";
import { isObject } from "../../shared/narrow.js";
import {
  failure,
  freestyleError,
  requestEvidence,
  recordRequest,
  recordResponse,
} from "./errors.js";
import { execute, supervisor } from "./execute.js";
import { deadline, operationSignal } from "./deadline.js";
import { parseMetadata, type MetadataPart } from "../../shared/metadata.js";

export interface FreestyleOptions {
  /** Defaults to FREESTYLE_API_KEY; required on first use. */
  apiKey?: string;
  /** API endpoint. Default: https://api.freestyle.sh. */
  baseUrl?: string;
  /** Base snapshot ID or slug. Defaults to freestyle/ubuntu. */
  snapshotId?: string;
  /** Overall deadline for control/file operations, including background polls. Default 30 s. Commands use their run timeout. */
  requestTimeoutMs?: number;
  /** Delete the VM once it has gone this long without running; `0` deletes it as soon as it stops. Rounded up to whole seconds. Default: never, or your plan's cap. */
  autoDeleteMs?: number;
}

type FreestyleCapability = "pause" | "snapshot" | "network-policy";

export type FreestyleProvider = Provider<Vm, FreestyleCapability>;

/** The parts of a Freestyle VM handle the adapter uses. */
export type FreestyleVm = Pick<Vm, "id" | "pause" | "start"> & {
  snapshot(options?: CreateSnapshotOptions): Promise<Pick<SnapshotCreated, "snapshotId">>;
  fs: {
    writeFile(path: string, content: Uint8Array, options: WriteFileOptions): Promise<void>;
    readFile(path: string, options: ReadFileOptions): Promise<Uint8Array>;
    readTextFile(path: string): Promise<string>;
  };
  exec(options: ExecOptions): Promise<ExecResult>;
};

/** What `vms.create` returns, with the VM handle as the port's type. */
export interface CreatedVm<V extends FreestyleVm> {
  vm: V;
  vmId: string;
  data: VmData;
  firewallRules: Pick<FirewallRuleData, "action" | "source" | "destination">[];
  tlsRules: Pick<TlsRuleData, "id">[];
}

/** The parts of a Freestyle client the adapter uses. */
export interface FreestyleApi<V extends FreestyleVm> {
  vms: {
    create(options: CreateVmOptions): Promise<CreatedVm<V>>;
    list(options: ListVmsOptions): Promise<Pick<ListVmsResult, "vms" | "totalCount">>;
    get(id: string): Promise<VmData>;
    ref(id: string): V;
    delete(id: string): Promise<void>;
  };
  tls: {
    rules: { create(options: CreateTlsRuleOptions): Promise<Pick<TlsRuleData, "domain">> };
  };
}

/** The parts of the Freestyle SDK the adapter uses: the real `freestyle` module, or a test fixture. */
export interface FreestyleModule<V extends FreestyleVm> {
  Freestyle: new (options: FreestyleClientOptions) => FreestyleApi<V>;
  FreestyleApiError: typeof FreestyleApiError;
  FreestyleClient: new (options: FreestyleClientOptions) => Pick<FreestyleClient, "fetch">;
}

const marker = "/var/lib/sandbox-sdk.json";
const supervisorHash = createHash("sha256").update(supervisor).digest("hex");

// Native metadata is committed with VM allocation, before guest setup can be
// interrupted. Freestyle allows 64 entries with at most 63 characters each.
const nativeInfo = "sandbox-sdk-info";

function creationMetadata(input: CreateInput) {
  const encoded = Buffer.from(
    JSON.stringify({ key: input.key ?? null, labels: input.labels }),
  ).toString("base64url");

  const chunks = encoded.match(/.{1,63}/g) ?? [];

  if (chunks.length > 62)
    throw failure("Key and labels exceed Freestyle's native metadata budget", "unsupported");

  return {
    "sandbox-sdk": "1",
    [nativeInfo]: String(chunks.length),
    ...Object.fromEntries(chunks.map((chunk, i) => [`${nativeInfo}-${i}`, chunk])),
  };
}

const envFile = "/var/lib/sandbox-sdk-env.json";

function seconds(value: number | undefined, hard: boolean) {
  if (value === undefined) return undefined;

  if (!Number.isSafeInteger(value) || value <= 0)
    throw failure("Timeout must be a positive integer", "invalid_argument");

  if (hard && value < 1000)
    throw failure("Hard lifetime requires at least one second", "unsupported");

  return hard ? Math.floor(value / 1000) : Math.ceil(value / 1000);
}

function rules(input: CreateInput): InlineFirewallRule[] {
  if (input.network === "none" || (isObject(input.network) && input.network.allow.length === 0))
    return [];

  if (isObject(input.network))
    throw failure("Host allow lists are not implemented; use all or none", "unsupported");

  return [{ action: "allow", source: {}, destination: { public: true } }];
}

// Writes the pending SDK files, then execs the command with its stdin.
const prepareAndRun = `import os,sys,json,tempfile,base64
v=json.load(sys.stdin)
for path in ['/workspace','/tmp/.sandbox-sdk']:
 os.makedirs(path,exist_ok=True)
for path,content in v['files']:
 os.makedirs(os.path.dirname(path),exist_ok=True)
 fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path))
 try:
  with os.fdopen(fd,'w') as f: f.write(content)
  os.replace(tmp,path)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
with tempfile.TemporaryFile() as f:
 f.write(base64.b64decode(v.get('stdin') or '')); f.seek(0); os.dup2(f.fileno(),0)
 print('SDK_PREPARED:',end='',flush=True)
 os.execvp('sh',['sh','-c',v['command']])`;

// Writes stdin to argv[1], creating its parent and applying octal mode argv[2] if set.
const uploadFile =
  "import os,sys; p=sys.argv[1]; os.makedirs(os.path.dirname(p),exist_ok=True); m=int(sys.argv[2],8) if sys.argv[2] else None; f=open(p,'wb'); f.write(sys.stdin.buffer.read()); f.close()\nif m is not None: os.chmod(p,m)";

/** @internal The adapter behind `freestyle()`. `load` imports the Freestyle SDK; tests pass a fixture. */
export function createFreestyleProvider<V extends FreestyleVm>(
  options: FreestyleOptions,
  load: () => Promise<FreestyleModule<V>>,
): Provider<V, FreestyleCapability> {
  let client: Promise<FreestyleApi<V>> | undefined;
  const boxes = new Map<string, V>();
  const pending = new Map<string, [string, string][]>();
  const previews = new Map<string, string>();
  const requestTimeoutMs = options.requestTimeoutMs ?? 30000;

  if (
    options.autoDeleteMs !== undefined &&
    (!Number.isSafeInteger(options.autoDeleteMs) || options.autoDeleteMs < 0)
  )
    throw failure(
      "autoDeleteMs must be a non-negative integer of milliseconds",
      "invalid_argument",
    );

  const autoDeleteSeconds =
    options.autoDeleteMs === undefined ? undefined : Math.ceil(options.autoDeleteMs / 1000);

  async function api() {
    return (client ??= (async () => {
      if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
        throw failure("requestTimeoutMs must be a positive integer", "invalid_argument");
      const apiKey = options.apiKey ?? process.env.FREESTYLE_API_KEY;

      if (!apiKey?.trim())
        throw failure(
          "Freestyle API key is missing. Authentication is required. Set FREESTYLE_API_KEY or pass apiKey.",
          "auth",
        );

      const { Freestyle, FreestyleApiError, FreestyleClient } = await loadPeer(
        "freestyle",
        "freestyle",
        load,
      );

      const transport = new FreestyleClient({ apiKey, baseUrl: options.baseUrl });

      return new Freestyle({
        apiKey,
        baseUrl: options.baseUrl,
        fetch: async (url, init) => {
          const signal = operationSignal.getStore() ?? AbortSignal.timeout(requestTimeoutMs);

          // The SDK retries arbitrary polling errors for five minutes. Use its
          // terminal error type on cancellation so even that loop terminates.
          const stopped = () =>
            new FreestyleApiError(408, {
              code: "SDK_DEADLINE",
              message: "Native operation stopped",
            });

          if (signal.aborted) throw stopped();
          recordRequest(url, init?.method, apiKey);

          try {
            const response = await transport.fetch(url instanceof Request ? url.url : String(url), {
              ...init,
              signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
            });

            recordResponse(response, apiKey);

            return response;
          } catch (error) {
            if (signal.aborted) throw stopped();
            throw error;
          }
        },
      });
    })());
  }

  async function safe<T>(
    id: string | undefined,
    action: () => Promise<T>,
    signal?: AbortSignal,
    timeoutMs = requestTimeoutMs,
  ): Promise<T> {
    return requestEvidence.run(
      { deniedValues: requestEvidence.getStore()?.deniedValues },
      async () => {
        try {
          return await deadline(action, timeoutMs, signal ?? operationSignal.getStore());
        } catch (error) {
          throw freestyleError(error, id);
        }
      },
    );
  }

  async function vm(id: string) {
    let value = boxes.get(id);

    if (!value) {
      value = (await api()).vms.ref(id);
      boxes.set(id, value);
    }

    return value;
  }

  async function run(
    value: FreestyleVm,
    command: string,
    stdin: string | undefined,
    timeoutMs: number,
  ) {
    const contents = pending.get(value.id);

    if (!contents) return value.exec({ command, stdin, linuxUser: "root", timeoutMs });

    const result = await value.exec({
      command: python(prepareAndRun),
      stdin: Buffer.from(JSON.stringify({ files: contents, command, stdin })).toString("base64"),
      linuxUser: "root",
      timeoutMs,
    });

    if (result.stdout?.startsWith("SDK_PREPARED:")) {
      pending.delete(value.id);

      return { ...result, stdout: result.stdout.slice(13) };
    }

    return result;
  }

  async function guest(id: string): Promise<Guest> {
    const value = await vm(id);

    return {
      name: "freestyle",
      raw: async (command) => {
        const r = await safe(id, () => run(value, command, undefined, requestTimeoutMs));

        if (r.statusCode !== 0)
          throw failure(
            "Guest operation failed",
            r.statusCode === null ? "timeout" : "provider",
            id,
          );

        return r.stdout ?? "";
      },
      // Without a mode both paths keep an existing file's mode; new files get the guest default (0644 live).
      upload: (path, bytes, mode) =>
        safe(id, async () => {
          if (pending.has(id)) {
            const result = await run(
              value,
              python(uploadFile, path, mode === undefined ? "" : mode.toString(8)),
              Buffer.from(bytes).toString("base64"),
              requestTimeoutMs,
            );

            if (result.statusCode !== 0) throw failure("File upload failed", "provider", id);
          } else if (mode === undefined)
            await value.fs.writeFile(path, bytes, { signal: operationSignal.getStore() });
          else await value.fs.writeFile(path, bytes, { mode, signal: operationSignal.getStore() });
        }),
      read: (path, range) =>
        safe(id, () => value.fs.readFile(path, { ...range, signal: operationSignal.getStore() })),
    };
  }

  async function info(data: VmData, nativeOwnership = false): Promise<SandboxInfo> {
    if (data.metadata["sandbox-sdk"] !== "1") throw failure("Not an SDK VM", "not_found", data.id);
    let text: string;

    if (nativeOwnership && data.metadata[nativeInfo] !== undefined) {
      const count = Number(data.metadata[nativeInfo]);

      if (!Number.isInteger(count) || count < 1 || count > 62)
        throw failure("Invalid SDK metadata", "not_found", data.id);
      let encoded = "";

      for (let i = 0; i < count; i++) {
        const chunk = data.metadata[`${nativeInfo}-${i}`];

        if (!chunk || !/^[A-Za-z0-9_-]{1,63}$/.test(chunk))
          throw failure("Invalid SDK metadata", "not_found", data.id);
        encoded += chunk;
      }

      text = Buffer.from(encoded, "base64url").toString();
    } else text = await (await vm(data.id)).fs.readTextFile(marker);

    const invalid: (part: MetadataPart) => never = (part) => {
      throw failure(`Invalid SDK ${part}`, "not_found", data.id);
    };

    // The marker always stores its key, null for none.
    const { key, labels } = parseMetadata(text, invalid);

    if (key === undefined) invalid("metadata");

    const createdAt = Date.parse(data.createdAt);

    if (!Number.isFinite(createdAt)) throw failure("Invalid VM creation time", "provider", data.id);

    return {
      id: data.id,
      key: key ?? undefined,
      labels,
      createdAt,
      state:
        data.state === "running"
          ? "running"
          : data.state === "paused" || data.state === "pausing"
            ? "paused"
            : "stopped",
    };
  }

  const provider: Provider<V, FreestyleCapability> = {
    name: "freestyle",
    keyMode: "best-effort",
    inlineActivity: true,
    capabilities: new Set(["pause", "snapshot", "network-policy"]),
    create: (input) =>
      safe(
        undefined,
        async () => {
          const context = requestEvidence.getStore();

          if (context) context.deniedValues = Object.values(input.env ?? {}).filter(Boolean);

          if (input.size !== undefined)
            throw failure(
              "Explicit sizes are not implemented; select a base snapshot instead",
              "unsupported",
            );
          const firewall = rules(input);
          const idleTimeoutSeconds = seconds(input.idleTimeoutMs, false);
          const ttlSeconds = seconds(input.timeoutMs, true);

          if (input.signal?.aborted || operationSignal.getStore()?.aborted)
            throw failure("Creation aborted", "aborted");

          const params: CreateVmOptions = {
            snapshotId: input.from ?? options.snapshotId ?? "freestyle/ubuntu",
            metadata: creationMetadata(input),
            firewall: { rules: firewall },
            tls: { rules: [] },
            vpcs: [],
            idleTimeoutSeconds: idleTimeoutSeconds ?? -1,
            ttlSeconds,
          };

          if (autoDeleteSeconds !== undefined) params.autoDeleteSeconds = autoDeleteSeconds;

          // No retries: a transport failure may have allocated a VM. An unknown
          // outcome must be inspected before another create is attempted.
          let result: CreatedVm<V>;
          const createdAt = Date.now();
          // Load the SDK first: a missing peer allocated nothing, so it is not an unknown outcome.
          const client = await api();

          try {
            result = await client.vms.create(params);
          } catch (error) {
            const mapped = freestyleError(error);

            if (mapped.code === "unavailable" || mapped.code === "timeout")
              throw failure(
                "VM creation outcome is unknown; inspect the account before retrying",
                "outcome_unknown",
                undefined,
                mapped.cause,
              );
            throw error;
          }

          const { vm: value, vmId: id, data, firewallRules: actual, tlsRules: tls } = result;
          boxes.set(id, value);

          try {
            if (input.signal?.aborted || operationSignal.getStore()?.aborted)
              throw failure("Creation aborted", "aborted");

            if (
              (idleTimeoutSeconds !== undefined &&
                data.idleTimeoutSeconds !== idleTimeoutSeconds) ||
              (ttlSeconds !== undefined && data.ttlSeconds !== ttlSeconds) ||
              (autoDeleteSeconds !== undefined && data.autoDeleteSeconds !== autoDeleteSeconds)
            )
              throw failure("Freestyle did not confirm requested limits", "unsupported", id);

            // No VPCs or inherited network grants may widen a restricted VM.
            if (
              data.vpcs.length ||
              actual.length !== firewall.length ||
              actual.some(
                (r) =>
                  r.action !== "allow" ||
                  Object.keys(r.source).length !== 1 ||
                  r.source.vmId !== id ||
                  Object.keys(r.destination).length !== 1 ||
                  r.destination.public !== true,
              )
            )
              throw failure("Freestyle did not confirm the requested firewall", "unsupported", id);

            if (tls.length) throw failure("Unexpected TLS egress grants", "unsupported", id);

            const contents: [string, string][] = [
              [
                marker,
                JSON.stringify({ key: input.key ?? null, labels: input.labels, supervisorHash }),
              ],
            ];

            if (
              Object.keys(input.env ?? {}).length ||
              input.from !== undefined ||
              options.snapshotId !== undefined
            )
              contents.push([envFile, JSON.stringify(input.env ?? {})]);
            pending.set(id, contents);

            // Private create-time env must survive reconnects before first use.
            if (
              Object.keys(input.env ?? {}).length ||
              input.from !== undefined ||
              options.snapshotId !== undefined
            ) {
              const setup = await run(value, "true", undefined, requestTimeoutMs);

              if (setup.statusCode !== 0) throw failure("Guest setup failed", "provider", id);
            }

            // Successful guest execution supersedes the allocation-time state.
            return await info(
              {
                ...data,
                createdAt: data.createdAt || new Date(createdAt).toISOString(),
                state: "running",
              },
              true,
            );
          } catch (error) {
            await operationSignal.exit(() => provider.destroy(id));
            throw error;
          }
        },
        input.signal,
      ).catch((error) => {
        const mapped = freestyleError(error);

        if (mapped.code === "timeout")
          throw failure(
            "VM creation outcome is unknown; inspect the account before retrying",
            "outcome_unknown",
            undefined,
            mapped.cause,
          );
        throw mapped;
      }),
    list: (labels) =>
      safe(undefined, async () => {
        const result: SandboxInfo[] = [];
        let offset = 0;

        while (true) {
          const page = await (await api()).vms.list({ limit: 100, offset });

          for (const data of page.vms) {
            if (data.metadata["sandbox-sdk"] !== "1") continue;

            try {
              const v = await info(data, true);

              if (Object.entries(labels).every(([k, x]) => v.labels[k] === x)) result.push(v);
            } catch (error) {
              if (freestyleError(error, data.id).code !== "not_found") throw error;
            }
          }

          offset += page.vms.length;

          if (offset >= page.totalCount) break;

          if (!page.vms.length) throw failure("VM list ended before all pages were returned");
        }

        return result;
      }),
    async find(key) {
      const v = (await provider.list({})).find((v) => v.key === key);

      if (!v) return undefined;

      try {
        return await provider.connect(v.id);
      } catch (error) {
        if (freestyleError(error, v.id).code !== "not_found") throw error;

        return undefined;
      }
    },
    connect: (id) =>
      safe(id, async () => {
        const client = await api();
        const data = await client.vms.get(id);
        boxes.set(id, client.vms.ref(id));
        let stored: SandboxInfo;

        try {
          stored = await info(data);
        } catch (error) {
          if (!["file_not_found", "not_found"].includes(freestyleError(error, id).code))
            throw error;
          stored = await info(data, true);
          pending.set(id, [
            [
              marker,
              JSON.stringify({
                key: stored.key ?? null,
                labels: stored.labels,
                supervisorHash,
              }),
            ],
          ]);
        }

        return stored;
      }),
    destroy: (id) =>
      safe(id, async () => {
        try {
          await (await api()).vms.delete(id);
        } catch (error) {
          if (freestyleError(error).code !== "not_found") throw error;
        }

        boxes.delete(id);
        pending.delete(id);

        for (const key of previews.keys()) if (key.startsWith(id + ":")) previews.delete(key);
      }),
    async close(id) {
      boxes.delete(id);
    },
    exec: async (id, input) => {
      try {
        if (!boxes.has(id)) await provider.connect(id);
        const value = await vm(id);
        const g = await guest(id);
        const contents = pending.get(id);

        const result = await execute(
          {
            raw: g.raw,
            read: (path, range, signal) =>
              safe(
                id,
                () => value.fs.readFile(path, { ...range, signal: operationSignal.getStore() }),
                signal,
              ),
            exec: (command, stdin, timeoutMs, signal) =>
              safe(
                id,
                async () => {
                  const result = await value.exec({
                    command,
                    stdin: Buffer.from(stdin).toString("base64"),
                    linuxUser: "root",
                    timeoutMs,
                  });

                  if (result.statusCode !== 0 || !result.stdout)
                    throw failure("Guest execution failed", "provider", id);

                  return result.stdout;
                },
                signal,
                timeoutMs,
              ),
          },
          input,
          contents,
        );

        if (!result.timedOut && pending.get(id) === contents) pending.delete(id);

        return result;
      } catch (error) {
        throw freestyleError(error, id);
      }
    },
    files: { ...files(guest, safe), writeSupportsMode: true },
    previewUrl: (id, port) =>
      safe(id, async () => {
        const key = `${id}:${port}`;
        const cached = previews.get(key);

        if (cached) return { url: cached };
        const domain = `sdk-${crypto.randomUUID()}.style.dev`;

        const rule = await (
          await api()
        ).tls.rules.create({
          action: "allow",
          domain,
          source: { public: true },
          destination: { vmId: id, port },
        });

        if (rule.domain !== domain)
          throw failure("Freestyle returned a different preview domain", "provider", id);
        const url = `https://${rule.domain}`;
        previews.set(key, url);

        return { url };
      }),
    pause: (id) =>
      safe(id, async () => {
        await (await vm(id)).pause();
      }),
    resume: (id) =>
      safe(id, async () => {
        await (await vm(id)).start();
      }),
    snapshot: (id, snapshotOptions) =>
      safe(id, async () => {
        const expiresInMs = snapshotOptions?.expiresInMs;

        if (expiresInMs !== undefined && (!Number.isSafeInteger(expiresInMs) || expiresInMs < 0))
          throw failure("expiresInMs must be a non-negative integer", "invalid_argument", id);

        // 0 keeps the snapshot until deleted (or until the plan's cap).
        return {
          id: (
            await (
              await vm(id)
            ).snapshot(expiresInMs ? { ttlSeconds: Math.ceil(expiresInMs / 1000) } : undefined)
          ).snapshotId,
        };
      }),
    native(id) {
      const value = boxes.get(id);

      if (!value) throw failure("Connect the VM first", "not_found", id);

      return value;
    },
  };

  return provider;
}
