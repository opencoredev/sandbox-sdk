/** Fake control plane; the guest commands, supervisor and files execute on Linux. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine, MachineCreateParams, ExecParams } from "@boxd-sh/sdk";
const exec = promisify(execFile);
export class MockGuest {
  readonly id = crypto.randomUUID();
  readonly commands: string[] = [];
  readonly uploads: { path: string; bytes: Uint8Array; mode: number }[] = [];
  constructor(readonly root: string) {}
  static async create() {
    return new MockGuest(await fs.mkdtemp(join(tmpdir(), "sdk-cloud-")));
  }
  rewrite(s: string) {
    return s.replace(
      /\/workspace|\/var\/lib\/sandbox-sdk(?:-env)?\.json|\/tmp\/\.sandbox-sdk|\/tmp\/sdk-bare/g,
      (p) => join(this.root, p),
    );
  }
  async raw(command: string) {
    this.commands.push(command);
    const r = await exec("sh", ["-c", this.rewrite(command)], {
      cwd: this.root,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return r.stdout.split(this.root).join("");
  }
  async upload(path: string, bytes: Uint8Array) {
    const dest = this.rewrite(path);
    await fs.mkdir(join(dest, ".."), { recursive: true });
    const data = path.endsWith("/supervisor")
      ? Buffer.from(
          Buffer.from(bytes)
            .toString()
            .replace(
              "base64.b64encode(data)",
              `base64.b64encode(data.replace(${JSON.stringify(this.root)}.encode(),b''))`,
            ),
        )
      : path.endsWith("/spec")
        ? Buffer.from(this.rewrite(Buffer.from(bytes).toString()))
        : bytes;
    await fs.writeFile(dest, data);
    this.uploads.push({ path, bytes, mode: (await fs.stat(dest)).mode & 0o777 });
  }
  async destroy() {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
export const boxdState = {
  boxes: new Map<string, { machine: Machine; guest: MockGuest }>(),
  creates: [] as MachineCreateParams[],
  error: 0,
};
export class MockBoxd {
  machines = {
    create: async (params: MachineCreateParams) => {
      boxdState.creates.push(params);
      const guest = await MockGuest.create();
      const machine: Machine = {
        id: guest.id,
        name: params.name ?? "",
        status: "running",
        imageRef: "base",
        restartPolicy: null,
        createdAt: new Date(),
        resources: { vcpu: 1, memoryBytes: 4 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 },
        org: null,
        shared: false,
        networking: { networks: [], isolated: true },
        egressAllow: [],
        access: {
          sshPort: null,
          domain: "boxd.sh",
          url: "https://test.boxd.sh",
          desktopUrl: "",
          customDomains: [],
        },
        idle: { suspendAfter: 0, hibernateAfter: 0, destroyAfter: 0 },
        botProtection: false,
        botProtectionMode: "off",
        idleIgnoreOutbound: false,
        deleteAt: null,
        deleteAfterCron: null,
        source: null,
        hibernatedAt: null,
        lastConnectedAt: null,
        bootTimeMs: null,
        pausedAutomations: 0,
      };
      boxdState.boxes.set(guest.id, { guest, machine });
      return machine;
    },
    get: async (id: string) => this.entry(id).machine,
    list: async () => [...boxdState.boxes.values()].map((v) => v.machine),
    waitUntilReady: async (id: string) => this.entry(id).machine,
    delete: async (id: string) => {
      const v = boxdState.boxes.get(id);
      if (v) {
        await v.guest.destroy();
        boxdState.boxes.delete(id);
      }
    },
    exec: async (id: string, params: ExecParams) => {
      if (boxdState.error)
        throw Object.assign(new Error("secret-native-error"), { grpcCode: boxdState.error });
      if (typeof params.command !== "string") throw new Error("Expected shell command");
      return { stdout: await this.entry(id).guest.raw(params.command), stderr: "", exitCode: 0 };
    },
    files: {
      upload: async (id: string, path: string, bytes: Uint8Array) => {
        await this.entry(id).guest.upload(path, bytes);
        return bytes.length;
      },
      download: async (id: string, path: string) => fs.readFile(this.entry(id).guest.rewrite(path)),
    },
    proxies: {
      list: async () => [{ name: "sdk-3000", domain: "test.boxd.sh", port: 3000 }],
      setPort: async () => {},
      create: async () => ({ name: "sdk-3000", port: 3000 }),
    },
    pause: async (id: string) => {
      this.entry(id).machine.status = "suspended";
    },
    resume: async (id: string) => {
      this.entry(id).machine.status = "running";
    },
  };
  entry(id: string) {
    if (boxdState.error)
      throw Object.assign(new Error("secret-native-error"), { grpcCode: boxdState.error });
    const v = boxdState.boxes.get(id);
    if (!v) throw Object.assign(new Error("missing"), { grpcCode: 5 });
    return v;
  }
}
