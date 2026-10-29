import { promises as fs } from "node:fs";
import { MockGuest } from "./cloud-guest-mock.js";
import type {
  CreateVmOptions,
  VmData,
  ExecOptions,
  InlineFirewallRule,
  CreateTlsRuleOptions,
} from "freestyle";
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
      ...(params.autoDeleteSeconds === undefined ? {} : { autoDeleteSeconds: params.autoDeleteSeconds }),
    };
  }
  async data() {
    if (freestyleState.error) throw error(freestyleState.error);
    return this.record;
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
    readTextFile: async (path: string) => new TextDecoder().decode(await this.guest.read(path)),
  };
  async exec(options: ExecOptions) {
    let input = options.stdin ? Buffer.from(options.stdin, "base64").toString() : "";
    if (options.command.includes("for path,content in v") && !options.command.includes("marshal.loads")) {
      const envelope: unknown = JSON.parse(input);
      if (envelope && typeof envelope === "object" && "command" in envelope && typeof envelope.command === "string" && envelope.command.includes("sandbox-sdk-exec-v2.py") && "stdin" in envelope && typeof envelope.stdin === "string") {
        envelope.stdin = Buffer.from(this.guest.rewrite(Buffer.from(envelope.stdin, "base64").toString())).toString("base64");
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
      ? options.command.replace("v=marshal.loads(bytes.fromhex(sys.stdin.read()))", "v=marshal.loads(bytes.fromhex(sys.stdin.read()))" + mapping).replace("data.hex()", `data.replace(${JSON.stringify(this.guest.root)}.encode(),bytes()).hex()`)
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
      return { vm: value, vmId: value.id, data: value.record, firewallRules: (await value.firewallRules()).rules, tlsRules: [] };
    },
    ref: (id: string) => this.get(id),
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
