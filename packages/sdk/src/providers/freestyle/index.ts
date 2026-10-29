/** Calls Freestyle's public API directly (https://api.freestyle.sh/openapi.json), reproducing freestyle 0.2.20.
 * https://www.freestyle.sh/docs/quickstart
 * https://www.freestyle.sh/docs/vms/network/firewall
 * https://www.freestyle.sh/docs/vms/network/tls-inbound
 */
import { createHash } from "node:crypto";
import { createNativeApi, sdkCall, sdkConstruct, type NativeApi, type NativeSdkBinding } from "../../native.js";
import type { Provider, SandboxInfo, CreateInput } from "../../provider.js";
import { files, python, type Guest } from "../boxd/guest.js";
import { defaultBaseUrl, freestyleClient, type ExecResponse, type FreestylePlane, type VmData } from "./client.js";
import { failure, freestyleError, requestEvidence } from "./errors.js";
import { execute, supervisor } from "./execute.js";
import { deadline, operationSignal } from "./deadline.js";
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
/** What `native.sdk(load)` needs from the module: the `Freestyle` client class and its `vms.ref(id)`. */
type FreestyleModule = { Freestyle: new (options: { apiKey: string; baseUrl: string }) => { vms: { ref(vmIdOrSlug: string): unknown } } };
/** `box.native.sdk`: the SDK's `Vm` handle for this VM, typed from the module you import. */
export type FreestyleVmSdk = <M extends FreestyleModule>(load: () => Promise<M>) => Promise<ReturnType<InstanceType<M["Freestyle"]>["vms"]["ref"]>>;
/** `provider.api.sdk`: the SDK's `Freestyle` client. */
export type FreestyleClientSdk = <M extends FreestyleModule>(load: () => Promise<M>) => Promise<InstanceType<M["Freestyle"]>>;
export type { FreestylePlane };
/** `box.native`: Freestyle's API with `{vmId}` bound to the sandbox. Paths include `/v5`. */
export type FreestyleNative = NativeApi<FreestylePlane, FreestyleVmSdk>;
/** `provider.api`: Freestyle's API with no VM bound. */
export type FreestyleApi = NativeApi<FreestylePlane, FreestyleClientSdk>;
export type FreestyleProvider = Provider<FreestyleNative, "pause" | "snapshot" | "network-policy"> & {
  /** Account-level calls, such as `api.request("GET", "/v5/snapshots")`. */
  readonly api: FreestyleApi;
};
const marker = "/var/lib/sandbox-sdk.json";
const supervisorHash = createHash("sha256").update(supervisor).digest("hex");
// Native metadata is committed with VM allocation, before guest setup can be
// interrupted. Freestyle allows 64 entries with at most 63 characters each.
const nativeInfo = "sandbox-sdk-info";
function creationMetadata(input: CreateInput): Record<string, string> {
  const encoded = Buffer.from(JSON.stringify({ key: input.key ?? null, labels: input.labels })).toString("base64url");
  const chunks = encoded.match(/.{1,63}/g) ?? [];
  if (chunks.length > 62) throw failure("Key and labels exceed Freestyle's native metadata budget", "unsupported");
  return { "sandbox-sdk": "1", [nativeInfo]: String(chunks.length), ...Object.fromEntries(chunks.map((chunk, i) => [`${nativeInfo}-${i}`, chunk])) };
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
type InlineFirewallRule = { action: "allow"; source: Record<string, never>; destination: { public: true } };
function rules(input: CreateInput): InlineFirewallRule[] {
  if (
    input.network === "none" ||
    (typeof input.network === "object" && input.network.allow.length === 0)
  )
    return [];
  if (typeof input.network === "object")
    throw failure("Host allow lists are not implemented; use all or none", "unsupported");
  return [{ action: "allow", source: {}, destination: { public: true } }];
}
export function freestyle(options: FreestyleOptions = {}): FreestyleProvider {
  const known = new Set<string>();
  const pending = new Map<string, [string, string][]>();
  const previews = new Map<string, string>();
  const natives = new Map<string, FreestyleNative>();
  const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
  if (options.autoDeleteMs !== undefined && (!Number.isSafeInteger(options.autoDeleteMs) || options.autoDeleteMs < 0))
    throw failure("autoDeleteMs must be a non-negative integer of milliseconds", "invalid_argument");
  const autoDeleteSeconds = options.autoDeleteMs === undefined ? undefined : Math.ceil(options.autoDeleteMs / 1000);
  const baseUrl = options.baseUrl ?? defaultBaseUrl;
  /** Checks the configuration on first use, so the factory constructs freely. */
  function apiKey(): string {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
      throw failure("requestTimeoutMs must be a positive integer", "invalid_argument");
    const key = options.apiKey ?? process.env.FREESTYLE_API_KEY;
    if (!key?.trim()) throw failure("Freestyle API key is missing. Authentication is required. Set FREESTYLE_API_KEY or pass apiKey.", "auth");
    return key;
  }
  const client = freestyleClient({ baseUrl, apiKey, requestTimeoutMs: Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 30000 });
  const binding: NativeSdkBinding = {
    package: "freestyle",
    async connect(module, sandboxId) {
      const sdk = sdkConstruct(module, "Freestyle", [{ apiKey: apiKey(), baseUrl }], "freestyle");
      if (sandboxId === undefined) return sdk;
      const vms: unknown = typeof sdk === "object" && sdk !== null ? Reflect.get(sdk, "vms") : undefined;
      return await sdkCall(vms, "ref", [sandboxId], "freestyle");
    },
  };
  const api = createNativeApi<FreestylePlane, FreestyleClientSdk>({ http: client.http, placeholder: ["vmId", "vmIdOrSlug"], sdk: binding });
  async function safe<T>(
    id: string | undefined,
    action: () => Promise<T>,
    signal?: AbortSignal,
    timeoutMs = requestTimeoutMs,
  ): Promise<T> {
    return requestEvidence.run({ deniedValues: requestEvidence.getStore()?.deniedValues }, async () => {
      try {
        return await deadline(action, timeoutMs, signal ?? operationSignal.getStore()?.signal);
      } catch (error) {
        throw freestyleError(error, id);
      }
    });
  }
  async function run(id: string, command: string, stdin: string | undefined, timeoutMs: number): Promise<ExecResponse> {
    const contents = pending.get(id);
    if (!contents) return client.exec(id, { command, ...(stdin === undefined ? {} : { stdin }), timeoutMs });
    const result = await client.exec(id, {
      command: python(`import os,sys,json,tempfile,base64
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
 os.execvp('sh',['sh','-c',v['command']])`),
      stdin: Buffer.from(JSON.stringify({ files: contents, command, stdin })).toString("base64"),
      timeoutMs,
    });
    if (result.stdout?.startsWith("SDK_PREPARED:")) {
      pending.delete(id);
      return { ...result, stdout: result.stdout.slice(13) };
    }
    return result;
  }
  async function guest(id: string): Promise<Guest> {
    return {
      name: "freestyle",
      raw: async (command) => {
        const r = await safe(id, () =>
          run(id, command, undefined, requestTimeoutMs),
        );
        if (r.statusCode !== 0)
          throw failure(
            "Guest operation failed",
            r.statusCode === null ? "timeout" : "provider",
            id,
          );
        return r.stdout ?? "";
      },
      // Without a mode both paths keep an existing file's mode; new files get the guest default (0644 live).
      upload: (path, bytes, mode) => safe(id, async () => {
        if (pending.has(id)) {
          const result = await run(id, python("import os,sys; p=sys.argv[1]; os.makedirs(os.path.dirname(p),exist_ok=True); m=int(sys.argv[2],8) if sys.argv[2] else None; f=open(p,'wb'); f.write(sys.stdin.buffer.read()); f.close()\nif m is not None: os.chmod(p,m)", path, mode === undefined ? "" : mode.toString(8)), Buffer.from(bytes).toString("base64"), requestTimeoutMs);
          if (result.statusCode !== 0) throw failure("File upload failed", "provider", id);
        } else await client.writeFile(id, path, bytes, mode);
      }),
      read: (path, range) => safe(id, () => client.readFile(id, path, range)),
    };
  }
  async function readInfo(data: VmData, nativeOwnership = false): Promise<{ info: SandboxInfo; supervisorHash?: string }> {
    if (data.metadata["sandbox-sdk"] !== "1") throw failure("Not an SDK VM", "not_found", data.id);
    let text: string;
    if (nativeOwnership && data.metadata[nativeInfo] !== undefined) {
      const count = Number(data.metadata[nativeInfo]);
      if (!Number.isInteger(count) || count < 1 || count > 62) throw failure("Invalid SDK metadata", "not_found", data.id);
      let encoded = "";
      for (let i = 0; i < count; i++) {
        const chunk = data.metadata[`${nativeInfo}-${i}`];
        if (!chunk || !/^[A-Za-z0-9_-]{1,63}$/.test(chunk)) throw failure("Invalid SDK metadata", "not_found", data.id);
        encoded += chunk;
      }
      text = Buffer.from(encoded, "base64url").toString();
    } else text = new TextDecoder().decode(await client.readFile(data.id, marker));
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw failure("Invalid SDK metadata", "not_found", data.id); }
    if (
      !value ||
      typeof value !== "object" ||
      !("key" in value) ||
      (value.key !== null && typeof value.key !== "string") ||
      !("labels" in value) ||
      !value.labels ||
      (typeof value.labels !== "object" || Array.isArray(value.labels))
    )
      throw failure("Invalid SDK metadata", "not_found", data.id);
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(value.labels)) {
      if (typeof v !== "string") throw failure("Invalid SDK label", "not_found", data.id);
      Object.defineProperty(labels, k, { value: v, enumerable: true });
    }
    const createdAt = Date.parse(data.createdAt);
    if (!Number.isFinite(createdAt)) throw failure("Invalid VM creation time", "provider", data.id);
    return {
      supervisorHash: "supervisorHash" in value && typeof value.supervisorHash === "string" ? value.supervisorHash : undefined,
      info: {
        id: data.id,
        key: value.key ?? undefined,
        labels,
        createdAt,
        state:
          data.state === "running"
            ? "running"
            : data.state === "paused" || data.state === "pausing"
              ? "paused"
              : "stopped",
      },
    };
  }
  async function info(data: VmData, nativeOwnership = false): Promise<SandboxInfo> {
    return (await readInfo(data, nativeOwnership)).info;
  }
  const provider: FreestyleProvider = {
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
          if (input.signal?.aborted || operationSignal.getStore()?.signal.aborted)
            throw failure("Creation aborted", "aborted");
          const params = {
            snapshotId: input.from ?? options.snapshotId ?? "freestyle/ubuntu",
            metadata: creationMetadata(input),
            firewall: { rules: firewall },
            tls: { rules: [] },
            vpcs: [],
            idleTimeoutSeconds: idleTimeoutSeconds ?? -1,
            ttlSeconds,
            ...(autoDeleteSeconds === undefined ? {} : { autoDeleteSeconds }),
          };
          // No retries: a transport failure may have allocated a VM. An unknown
          // outcome must be inspected before another create is attempted.
          let result: Awaited<ReturnType<typeof client.createVm>>;
          const createdAt = Date.now();
          // Check credentials first: a missing key allocated nothing, so it is not an unknown outcome.
          apiKey();
          try {
            // The caller's abort must not cut the request: Freestyle may allocate the VM anyway, and only the
            // response names it. The request follows the operation's timeout alone, and the check below deletes
            // a VM that lands after an abort.
            const operation = operationSignal.getStore();
            result = operation
              ? await operationSignal.run({ signal: operation.timeout, timeout: operation.timeout, remaining: operation.remaining }, () => client.createVm(params))
              : await client.createVm(params);
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
          const { data, firewallRules: actual, tlsRules: tls } = result;
          const id = data.id;
          known.add(id);
          try {
            if (input.signal?.aborted || operationSignal.getStore()?.signal.aborted)
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
              !Array.isArray(data.vpcs) || data.vpcs.length ||
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
            if (tls.length)
              throw failure("Unexpected TLS egress grants", "unsupported", id);
            const contents: [string, string][] = [[marker, JSON.stringify({ key: input.key ?? null, labels: input.labels, supervisorHash })]];
            if (Object.keys(input.env ?? {}).length || input.from !== undefined || options.snapshotId !== undefined)
              contents.push([envFile, JSON.stringify(input.env ?? {})]);
            pending.set(id, contents);
            // Private create-time env must survive reconnects before first use.
            if (Object.keys(input.env ?? {}).length || input.from !== undefined || options.snapshotId !== undefined) {
              const setup = await run(id, "true", undefined, requestTimeoutMs);
              if (setup.statusCode !== 0) throw failure("Guest setup failed", "provider", id);
            }
            // Successful guest execution supersedes the allocation-time state.
            return await info({ ...data, createdAt: data.createdAt || new Date(createdAt).toISOString(), state: "running" }, true);
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
          const page = await client.listVms(100, offset);
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
      try { return await provider.connect(v.id); }
      catch (error) { if (freestyleError(error, v.id).code !== "not_found") throw error; return undefined; }
    },
    connect: (id) =>
      safe(id, async () => {
        const data = await client.getVm(id);
        known.add(id);
        let stored: Awaited<ReturnType<typeof readInfo>>;
        try { stored = await readInfo(data); }
        catch (error) {
          if (!["file_not_found", "not_found"].includes(freestyleError(error, id).code)) throw error;
          stored = await readInfo(data, true);
          pending.set(id, [[marker, JSON.stringify({ key: stored.info.key ?? null, labels: stored.info.labels, supervisorHash })]]);
        }
        return stored.info;
      }),
    destroy: (id) =>
      safe(id, async () => {
        try {
          await client.deleteVm(id);
        } catch (error) {
          if (freestyleError(error).code !== "not_found") throw error;
        }
        known.delete(id);
        natives.delete(id);
        pending.delete(id);
        for (const key of previews.keys()) if (key.startsWith(id + ":")) previews.delete(key);
      }),
    async close(id) {
      known.delete(id);
      natives.delete(id);
    },
    exec: async (id, input) => {
      try {
        if (!known.has(id)) await provider.connect(id);
        const g = await guest(id);
        const contents = pending.get(id);
        const result = await execute(
          {
            id,
            raw: g.raw,
            read: (path, range, signal) =>
              safe(
                id,
                () => client.readFile(id, path, range),
                signal,
              ),
            exec: (command, stdin, timeoutMs, signal) =>
              safe(
                id,
                async () => {
                  const result = await client.exec(id, { command, stdin: Buffer.from(stdin).toString("base64"), timeoutMs });
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
        const rule = await client.createTlsRule({
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
        await client.lifecycle(id, "pause");
      }),
    resume: (id) =>
      safe(id, async () => {
        await client.lifecycle(id, "start");
      }),
    snapshot: (id, snapshotOptions) => safe(id, async () => {
      const expiresInMs = snapshotOptions?.expiresInMs;
      if (expiresInMs !== undefined && (!Number.isSafeInteger(expiresInMs) || expiresInMs < 0))
        throw failure("expiresInMs must be a non-negative integer", "invalid_argument", id);
      // 0 keeps the snapshot until deleted (or until the plan's cap).
      return { id: await client.snapshot(id, expiresInMs ? { ttlSeconds: Math.ceil(expiresInMs / 1000) } : {}) };
    }),
    native(id) {
      if (!known.has(id)) throw failure("Connect the VM first", "not_found", id);
      let value = natives.get(id);
      if (!value) {
        value = createNativeApi<FreestylePlane, FreestyleVmSdk>({ http: client.http, placeholder: ["vmId", "vmIdOrSlug"], sandboxId: id, sdk: binding });
        natives.set(id, value);
      }
      return value;
    },
    api,
  };
  return provider;
}
