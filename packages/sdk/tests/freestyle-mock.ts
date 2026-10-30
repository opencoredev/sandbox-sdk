/** A fake Freestyle API: `freestyleFetch` serves the /v5 routes the adapter calls from these mock VMs. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { MockGuest } from "./cloud-guest-mock.js";

interface InlineFirewallRule {
  action: string;
  source: Record<string, unknown>;
  destination: Record<string, unknown>;
}
interface CreateVmOptions {
  snapshotId?: string;
  metadata?: Record<string, string>;
  firewall: { rules: InlineFirewallRule[] };
  tls?: { rules: unknown[] };
  vpcs?: string[];
  idleTimeoutSeconds?: number;
  ttlSeconds?: number;
  autoDeleteSeconds?: number;
}
interface VmData {
  id: string;
  state: string;
  resources: { cpu: number; memory: number; storage: number };
  metadata: Record<string, string>;
  vpcs: string[];
  networks: unknown[];
  createdAt: string;
  updatedAt: string;
  idleTimeoutSeconds?: number;
  ttlSeconds?: number;
  autoDeleteSeconds?: number;
}
interface ExecOptions {
  command: string;
  stdin?: string;
  linuxUser?: string;
  timeoutMs?: number;
}
type CreateTlsRuleOptions = Record<string, unknown>;
export const freestyleState = {
  boxes: new Map<string, MockVm>(),
  creates: [] as CreateVmOptions[],
  snapshots: new Map<string, string>(),
  rules: [] as CreateTlsRuleOptions[],
  error: 0,
  listError: 0,
  widen: false,
  delay: 0,
  peak: 0,
  snapshotOptions: [] as unknown[],
};
const error = (status: number) => Object.assign(new Error("secret-native-error"), { status });
export class MockVm {
  readonly id: string;
  readonly record: VmData;
  constructor(
    readonly guest: MockGuest,
    readonly params: CreateVmOptions,
  ) {
    this.id = guest.id;
    this.record = {
      id: this.id,
      state: "running",
      resources: { cpu: 4, memory: 8192, storage: 32768 },
      metadata: params.metadata ?? {},
      vpcs: [],
      networks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      idleTimeoutSeconds: params.idleTimeoutSeconds,
      ttlSeconds: params.ttlSeconds,
      ...(params.autoDeleteSeconds === undefined
        ? {}
        : { autoDeleteSeconds: params.autoDeleteSeconds }),
    };
  }
  fs = {
    writeFile: async (path: string, bytes: Uint8Array, options?: { mode?: number }) => {
      await this.guest.upload(path, bytes);
      await fs.chmod(this.guest.rewrite(path), options?.mode ?? 0o600);
      const upload = this.guest.uploads.at(-1);
      if (upload) upload.mode = options?.mode ?? 0o600;
    },
    readFile: (path: string, options?: { offset?: number; length?: number }) =>
      this.guest.read(path, options),
  };
  async exec(options: ExecOptions) {
    let input = options.stdin ? Buffer.from(options.stdin, "base64").toString() : "";
    if (
      options.command.includes("for path,content in v") &&
      !options.command.includes("marshal.loads")
    ) {
      const envelope: unknown = JSON.parse(input);
      if (
        envelope &&
        typeof envelope === "object" &&
        "command" in envelope &&
        typeof envelope.command === "string" &&
        envelope.command.includes("sandbox-sdk-exec-v2.py") &&
        "stdin" in envelope &&
        typeof envelope.stdin === "string"
      ) {
        envelope.stdin = Buffer.from(
          this.guest.rewrite(Buffer.from(envelope.stdin, "base64").toString()),
        ).toString("base64");
        input = JSON.stringify(envelope);
      }
    }
    const mapping = `
def sdk_paths(value):
 if isinstance(value,str): return value.replace("/"+"workspace",bytes.fromhex("${Buffer.from(this.guest.root + "/workspace").toString("hex")}").decode()).replace("/tmp/"+".sandbox-sdk",bytes.fromhex("${Buffer.from(this.guest.root + "/tmp/.sandbox-sdk").toString("hex")}").decode()).replace("/var/lib/"+"sandbox-sdk",bytes.fromhex("${Buffer.from(this.guest.root + "/var/lib/sandbox-sdk").toString("hex")}").decode())
 if isinstance(value,list): return [sdk_paths(x) for x in value]
 if isinstance(value,dict): return {k:sdk_paths(x) for k,x in value.items()}
 return value
v=sdk_paths(v)`;
    const command = options.command.includes("class Process:")
      ? options.command
          .replace(
            "v=marshal.loads(bytes.fromhex(sys.stdin.read()))",
            "v=marshal.loads(bytes.fromhex(sys.stdin.read()))" + mapping,
          )
          .replace(
            "data.hex()",
            `data.replace(${JSON.stringify(this.guest.root)}.encode(),bytes()).hex()`,
          )
      : options.command;
    const result = options.stdin
      ? await this.guest.buffered(command, input)
      : { stdout: await this.guest.raw(options.command), stderr: "", statusCode: 0 };
    const stdout = result.stdout;
    freestyleState.peak = Math.max(freestyleState.peak, Buffer.byteLength(stdout));
    return result;
  }
  async delete() {
    await this.guest.destroy();
    freestyleState.boxes.delete(this.id);
  }
  async pause() {
    this.record.state = "paused";
    return this.record;
  }
  async start() {
    this.record.state = "running";
    return this.record;
  }
  async snapshot(options?: unknown) {
    freestyleState.snapshotOptions.push(options);
    const snapshotId = crypto.randomUUID();
    const root = await fs.mkdtemp("/tmp/sdk-freestyle-snapshot-");
    await fs.cp(this.guest.root, root, { recursive: true });
    freestyleState.snapshots.set(snapshotId, root);
    return { snapshotId, sourceVmId: this.id };
  }
  async firewallRules() {
    let rules: InlineFirewallRule[] = this.params.firewall.rules;
    if (freestyleState.widen)
      rules = [...rules, { action: "allow", source: {}, destination: { public: true } }];
    return {
      totalCount: rules.length,
      rules: rules.map((r, i) => ({
        ...r,
        id: String(i),
        source: { vmId: this.id },
        dependencies: [],
        createdAt: "",
        updatedAt: "",
      })),
    };
  }
}
export class MockFreestyle {
  vms = {
    create: async (params: CreateVmOptions) => {
      if (freestyleState.error) throw error(freestyleState.error);
      freestyleState.creates.push(params);
      const guest = await MockGuest.create();
      if (params.snapshotId) {
        const root = freestyleState.snapshots.get(params.snapshotId);
        if (root) await fs.cp(root, guest.root, { recursive: true });
      }
      const value = new MockVm(guest, params);
      freestyleState.boxes.set(value.id, value);
      if (freestyleState.delay) await new Promise((r) => setTimeout(r, freestyleState.delay));
      return {
        vm: value,
        vmId: value.id,
        data: value.record,
        firewallRules: (await value.firewallRules()).rules,
        tlsRules: [],
      };
    },
    get: async (id: string) => this.get(id).record,
    list: async (options?: { limit?: number; offset?: number }) => {
      if (freestyleState.listError) throw error(freestyleState.listError);
      const vms = [...freestyleState.boxes.values()].map((v) => v.record);
      return {
        vms: vms.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? 100)),
        totalCount: vms.length,
      };
    },
    delete: async (id: string) => {
      const v = freestyleState.boxes.get(id);
      if (v) await v.delete();
    },
  };
  tls = {
    rules: {
      create: async (params: CreateTlsRuleOptions) => {
        freestyleState.rules.push(params);
        return { ...params, id: crypto.randomUUID() };
      },
      list: async () => ({ rules: [], totalCount: 0 }),
    },
  };
  get(id: string) {
    if (freestyleState.error) throw error(freestyleState.error);
    const v = freestyleState.boxes.get(id);
    if (!v) throw error(404);
    return v;
  }
}
export async function cleanupFreestyle() {
  await Promise.all([...freestyleState.boxes.values()].map((v) => v.delete()));
  await Promise.all(
    [...freestyleState.snapshots.values()].map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
  freestyleState.snapshots.clear();
}

const origin = "https://api.freestyle.sh";
const backend = new MockFreestyle();
function vmOf(id: string) {
  return backend.get(decodeURIComponent(id));
}
/** One parsed request the fake served, for assertions on the wire. */
export const freestyleRequests: {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body?: unknown;
}[] = [];
async function route(
  method: string,
  url: URL,
  headers: Headers,
  body: Uint8Array,
): Promise<Response> {
  const json = (): unknown => (body.byteLength ? JSON.parse(new TextDecoder().decode(body)) : {});
  const parts = url.pathname.split("/").filter(Boolean);
  const [v5, vms, id, ...rest] = parts;
  if (v5 !== "v5") throw new Error(`Unexpected Freestyle route ${method} ${url.pathname}`);
  if (vms === "tls" && method === "POST" && id === undefined)
    return Response.json(await backend.tls.rules.create(json() as CreateTlsRuleOptions));
  if (vms !== "vms") throw new Error(`Unexpected Freestyle route ${method} ${url.pathname}`);
  if (id === undefined) {
    if (method === "POST") {
      const { data, firewallRules, tlsRules } = await backend.vms.create(json() as CreateVmOptions);
      return Response.json({ ...data, firewallRules, tlsRules }, { status: 201 });
    }
    if (method === "GET")
      return Response.json(
        await backend.vms.list({
          limit: Number(url.searchParams.get("limit") ?? 100),
          offset: Number(url.searchParams.get("offset") ?? 0),
        }),
      );
  }
  const action = rest.join("/");
  if (action === "" && method === "GET")
    return Response.json(await backend.vms.get(decodeURIComponent(id ?? "")));
  if (action === "" && method === "DELETE") {
    await backend.vms.delete(decodeURIComponent(id ?? ""));
    return new Response(null, { status: 204 });
  }
  const vm = vmOf(id ?? "");
  switch (`${method} ${action}`) {
    case "POST exec-await":
      return Response.json(await vm.exec(json() as ExecOptions));
    case "POST pause":
      return Response.json(await vm.pause());
    case "POST start":
      return Response.json(await vm.start());
    case "POST snapshot":
      return Response.json(await vm.snapshot(json()));
    case "GET fs/read": {
      const path = url.searchParams.get("path") ?? "";
      const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
      const bytes = await vm.fs.readFile(
        path,
        range
          ? { offset: Number(range[1]), length: Number(range[2]) - Number(range[1]) + 1 }
          : undefined,
      );
      return new Response(new Uint8Array(bytes), {
        status: range ? 206 : 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    case "PUT fs/write": {
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (url.searchParams.get("sha256") !== sha256)
        return Response.json({ code: "SHA256_MISMATCH", message: "body damaged" }, { status: 400 });
      const mode = url.searchParams.get("mode");
      await vm.fs.writeFile(
        url.searchParams.get("path") ?? "",
        body,
        mode === null ? {} : { mode: Number(mode) },
      );
      return new Response(null, { status: 204 });
    }
  }
  throw new Error(`Unexpected Freestyle route ${method} ${url.pathname}`);
}
/**
 * `fetch` for the fake API. A thrown error with a `status` becomes that HTTP error (its message is the body's
 * message, as Freestyle sends it); any other thrown error is a network failure. A request whose signal aborts
 * rejects, but the server-side work it started still finishes, like a real API.
 */
export async function freestyleFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== origin) throw new Error("Cloud HTTP is forbidden in offline provider tests");
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (headers.get("authorization") !== "Bearer mock-key")
    return Response.json({ code: "UNAUTHORIZED", message: "bad key" }, { status: 401 });
  const body =
    init.body === undefined || init.body === null
      ? new Uint8Array()
      : new Uint8Array(await new Response(init.body).arrayBuffer());
  const record: (typeof freestyleRequests)[number] = {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers,
  };
  if (body.byteLength && headers.get("content-type") === "application/json")
    record.body = JSON.parse(new TextDecoder().decode(body));
  freestyleRequests.push(record);
  const served = route(method, url, headers, body).catch((failure: unknown) => {
    if (
      typeof failure === "object" &&
      failure !== null &&
      "status" in failure &&
      typeof failure.status === "number"
    )
      return Response.json(
        {
          code: "code" in failure && typeof failure.code === "string" ? failure.code : "ERROR",
          message: failure instanceof Error ? failure.message : "error",
        },
        { status: failure.status },
      );
    throw new TypeError("fetch failed", { cause: failure });
  });
  const signal = init.signal;
  if (!signal) return served;
  return await new Promise<Response>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    const done = () => signal.removeEventListener("abort", abort);
    served.then(
      (response) => {
        done();
        resolve(response);
      },
      (failure: unknown) => {
        done();
        reject(failure);
      },
    );
  });
}
