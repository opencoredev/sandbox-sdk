/** Verified against freestyle 0.2.20 (the current SDK, not freestyle-sandboxes).
 * https://www.freestyle.sh/docs/quickstart
 * https://www.freestyle.sh/docs/vms/network/firewall
 * https://www.freestyle.sh/docs/vms/network/tls-inbound
 */
import type { Freestyle, Vm, VmData, CreateVmOptions, InlineFirewallRule } from "freestyle";
import type { Provider, SandboxInfo, CreateInput } from "../../provider.js";
import { files, python, type Guest } from "../boxd/guest.js";
import { failure, freestyleError } from "./errors.js";
import { execute, supervisor, supervisorPath } from "./execute.js";
import { deadline, operationSignal } from "./deadline.js";
export interface FreestyleOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Base snapshot ID or slug. Defaults to freestyle/ubuntu. */
  snapshotId?: string;
  /** Overall deadline for control/file operations, including background polls. Default 30 s. Commands use their run timeout. */
  requestTimeoutMs?: number;
}
export type FreestyleProvider = Provider<Vm, "pause" | "snapshot" | "network-policy">;
const marker = "/var/lib/sandbox-sdk.json";
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
  let client: Promise<Freestyle> | undefined;
  const boxes = new Map<string, Vm>();
  const installations = new Map<string, Promise<void>>();
  const previews = new Map<string, string>();
  const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
  async function api() {
    return (client ??= (async () => {
      if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
        throw failure("requestTimeoutMs must be a positive integer", "invalid_argument");
      const apiKey = options.apiKey ?? process.env.FREESTYLE_API_KEY;
      if (!apiKey?.trim()) throw failure("Set FREESTYLE_API_KEY", "auth");
      const { Freestyle, FreestyleApiError } = await import("freestyle");
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
          try {
            return await fetch(url, {
              ...init,
              signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
            });
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
    try {
      return await deadline(action, timeoutMs, signal ?? operationSignal.getStore());
    } catch (error) {
      throw freestyleError(error, id);
    }
  }
  async function vm(id: string) {
    let value = boxes.get(id);
    if (!value) {
      value = (await api()).vms.ref(id);
      boxes.set(id, value);
    }
    return value;
  }
  async function guest(id: string): Promise<Guest> {
    const value = await vm(id);
    return {
      name: "freestyle",
      raw: async (command) => {
        const r = await safe(id, () =>
          value.exec({ command, linuxUser: "root", timeoutMs: requestTimeoutMs }),
        );
        if (r.statusCode !== 0)
          throw failure(
            "Guest operation failed",
            r.statusCode === null ? "timeout" : "provider",
            id,
          );
        return r.stdout ?? "";
      },
      upload: (path, bytes) =>
        safe(id, () =>
          value.fs.writeFile(path, bytes, { mode: 0o600, signal: operationSignal.getStore() }),
        ),
      read: (path, range) =>
        safe(id, () => value.fs.readFile(path, { ...range, signal: operationSignal.getStore() })),
    };
  }
  async function info(data: VmData): Promise<SandboxInfo> {
    if (data.metadata["sandbox-sdk"] !== "1") throw failure("Not an SDK VM", "not_found", data.id);
    const value: unknown = JSON.parse(await (await vm(data.id)).fs.readTextFile(marker));
    if (
      !value ||
      typeof value !== "object" ||
      !("key" in value) ||
      (value.key !== null && typeof value.key !== "string") ||
      !("labels" in value) ||
      !value.labels ||
      typeof value.labels !== "object"
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
    };
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
            metadata: { "sandbox-sdk": "1" },
            firewall: { rules: firewall },
            tls: { rules: [] },
            vpcs: [],
            idleTimeoutSeconds: idleTimeoutSeconds ?? -1,
            ttlSeconds,
          };
          // No retries: a transport failure may have allocated a VM. An unknown
          // outcome must be inspected before another create is attempted.
          let result: Awaited<ReturnType<Freestyle["vms"]["create"]>>;
          try {
            result = await (await api()).vms.create(params);
          } catch (error) {
            const mapped = freestyleError(error);
            if (mapped.code === "unavailable" || mapped.code === "timeout")
              throw failure(
                "VM creation outcome is unknown; inspect the account before retrying",
                "outcome_unknown",
              );
            throw error;
          }
          const { vm: value, vmId: id } = result;
          boxes.set(id, value);
          try {
            if (input.signal?.aborted || operationSignal.getStore()?.aborted)
              throw failure("Creation aborted", "aborted");
            const data = await value.data();
            if (
              (idleTimeoutSeconds !== undefined &&
                data.idleTimeoutSeconds !== idleTimeoutSeconds) ||
              (ttlSeconds !== undefined && data.ttlSeconds !== ttlSeconds)
            )
              throw failure("Freestyle did not confirm requested limits", "unsupported", id);
            const actual = await value.firewallRules();
            // No VPCs or inherited network grants may widen a restricted VM.
            if (
              data.vpcs.length ||
              actual.totalCount !== firewall.length ||
              actual.rules.length !== firewall.length ||
              actual.rules.some(
                (r) =>
                  r.action !== "allow" ||
                  Object.keys(r.source).length !== 1 ||
                  r.source.vmId !== id ||
                  Object.keys(r.destination).length !== 1 ||
                  r.destination.public !== true,
              )
            )
              throw failure("Freestyle did not confirm the requested firewall", "unsupported", id);
            const tls = await (await api()).tls.rules.list({ vmId: id });
            if (tls.rules.some((r) => r.source.vmId === id) || tls.totalCount !== tls.rules.length)
              throw failure("Unexpected TLS egress grants", "unsupported", id);
            const g = await guest(id);
            await g.raw(
              "mkdir -p /workspace /var/lib /tmp/.sandbox-sdk; command -v python3 git tar nohup >/dev/null",
            );
            await g.upload(
              marker,
              Buffer.from(JSON.stringify({ key: input.key ?? null, labels: input.labels })),
            );
            await g.upload(envFile, Buffer.from(JSON.stringify(input.env ?? {})));
            await g.upload(supervisorPath, Buffer.from(supervisor));
            if (input.signal?.aborted || operationSignal.getStore()?.aborted)
              throw failure("Creation aborted", "aborted");
            return await info(data);
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
            const v = await info(data);
            if (Object.entries(labels).every(([k, x]) => v.labels[k] === x)) result.push(v);
          }
          offset += page.vms.length;
          if (offset >= page.totalCount) break;
          if (!page.vms.length) throw failure("VM list ended before all pages were returned");
        }
        return result;
      }),
    async find(key) {
      const v = (await provider.list({})).find((v) => v.key === key);
      return v ? provider.connect(v.id) : undefined;
    },
    connect: (id) =>
      safe(id, async () => {
        const data = await (await api()).vms.get(id);
        // One promise per sandbox in this client; atomic replace also handles
        // independent clients reconnecting to the same older sandbox.
        let installation = installations.get(id);
        if (!installation) {
          installation = (async () => {
            const g = await guest(id);
            await g.raw(
              python(
                `import os,sys,tempfile
p,content=sys.argv[1:]
try:
 with open(p) as f: current=f.read()
except FileNotFoundError: current=None
if current!=content:
 fd,tmp=tempfile.mkstemp(dir=os.path.dirname(p))
 try:
  with os.fdopen(fd,'w') as f: f.write(content)
  os.replace(tmp,p)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)`,
                supervisorPath,
                supervisor,
              ),
            );
          })();
          installations.set(id, installation);
          installation.catch(() => {
            if (installations.get(id) === installation) installations.delete(id);
          });
        }
        await installation;
        return info(data);
      }),
    destroy: (id) =>
      safe(id, async () => {
        try {
          await (await api()).vms.delete(id);
        } catch (error) {
          if (freestyleError(error).code !== "not_found") throw error;
        }
        boxes.delete(id);
        installations.delete(id);
        for (const key of previews.keys()) if (key.startsWith(id + ":")) previews.delete(key);
      }),
    async close(id) {
      boxes.delete(id);
    },
    exec: async (id, input) => {
      try {
        const value = await vm(id);
        const g = await guest(id);
        return await execute(
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
        );
      } catch (error) {
        throw freestyleError(error, id);
      }
    },
    files: files(guest, safe),
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
    snapshot: (id) => safe(id, async () => ({ id: (await (await vm(id)).snapshot()).snapshotId })),
    native(id) {
      const value = boxes.get(id);
      if (!value) throw failure("Connect the VM first", "not_found", id);
      return value;
    },
  };
  return provider;
}
