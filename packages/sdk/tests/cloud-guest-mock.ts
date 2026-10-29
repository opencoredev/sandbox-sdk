/** Fake control plane; the guest commands, supervisor and files execute on Linux. */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecStream,
  type StreamExecParams,
  type Machine,
  type MachineCreateParams,
  type ExecParams,
  type Proxy,
} from "@boxd-sh/sdk";
import { isString } from "../src/shared/narrow.js";

const exec = promisify(execFile);

export class MockGuest {
  cancelGraceMs = 0;
  cancelWithoutTermination = false;
  readonly id = crypto.randomUUID();
  readonly commands: string[] = [];
  readonly inputs: string[] = [];
  readonly reads: { path: string; range?: { offset?: number; length?: number } }[] = [];
  readonly uploads: { path: string; bytes: Uint8Array; mode: number }[] = [];
  constructor(readonly root: string) {}
  static async create() {
    return new MockGuest(await fs.mkdtemp(join(tmpdir(), "sdk-cloud-")));
  }
  rewrite(s: string) {
    return s.replace(
      /\/var\/lib\/sandbox-sdk\/metadata\.json|\/var\/lib\/sandbox-sdk(?=[ ;]|$)|\/workspace|\/var\/lib\/sandbox-sdk(?:-env)?\.json|\/var\/lib\/sandbox-sdk-exec-v2\.py|\/tmp\/\.sandbox-sdk|\/tmp\/sdk-bare/g,
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
  stream(command: string) {
    this.commands.push(command);
    let input = "";
    let child: ReturnType<typeof spawn> | undefined;

    const stream = new ExecStream({
      write: (bytes) => {
        input += new TextDecoder().decode(bytes);
      },
      resize() {},
      end: () => {
        this.inputs.push(input);
        child = spawn("sh", ["-c", this.rewrite(command)], { cwd: this.root, detached: true });
        child.stdin?.end(this.rewrite(input));
        child.stdout?.on("data", (bytes) =>
          stream.stdout.push(Buffer.from(Buffer.from(bytes).toString().split(this.root).join(""))),
        );
        child.stderr?.on("data", (bytes) => stream.stderr.push(bytes));
        child.on("close", (code) => {
          stream.stdout.close();
          stream.stderr.close();
          stream._setExit(code ?? 137);
        });
      },
      cancel: () => {
        if (child?.pid) {
          try {
            if (this.cancelWithoutTermination) {
              stream._setError(new Error("RPC cancelled before remote termination"));
            } else if (this.cancelGraceMs) {
              const pid = child.pid;
              process.kill(-pid, "SIGTERM");
              setTimeout(() => {
                try {
                  process.kill(-pid, "SIGKILL");
                } catch {}
              }, this.cancelGraceMs);
            } else process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
      },
    });

    return stream;
  }
  async buffered(command: string, stdin: string) {
    const stream = this.stream(command);
    stream.write(stdin);
    stream.end();

    let stdout = "",
      stderr = "";

    const [statusCode] = await Promise.all([
      stream.wait(),
      (async () => {
        for await (const chunk of stream.stdout) stdout += new TextDecoder().decode(chunk);
      })(),
      (async () => {
        for await (const chunk of stream.stderr) stderr += new TextDecoder().decode(chunk);
      })(),
    ]);

    return { statusCode, stdout: stdout.split(this.root).join(""), stderr };
  }
  async bytes(command: string) {
    this.commands.push(command);

    const result = await exec("sh", ["-c", this.rewrite(command)], {
      cwd: this.root,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "buffer",
    });

    return result.stdout;
  }
  async read(path: string, range?: { offset?: number; length?: number }) {
    this.reads.push({ path, range });

    try {
      const data = await fs.readFile(this.rewrite(path));

      return new Uint8Array(
        range
          ? data.subarray(
              range.offset ?? 0,
              range.length === undefined ? undefined : (range.offset ?? 0) + range.length,
            )
          : data,
      );
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error("read failed"), {
        grpcCode: 5,
        status: 404,
      });
    }
  }
  async upload(path: string, bytes: Uint8Array) {
    const dest = this.rewrite(path);
    await fs.mkdir(join(dest, ".."), { recursive: true });

    const data =
      path.endsWith("/supervisor") || path.endsWith("-exec-v2.py")
        ? Buffer.from(
            this.rewrite(Buffer.from(bytes).toString()).replace(
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

const creates: MachineCreateParams[] = [];

export const boxdState = {
  boxes: new Map<string, { machine: Machine; guest: MockGuest }>(),
  creates,
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
    streamExec: (id: string, params: StreamExecParams) => {
      if (!isString(params.command)) throw new Error("Expected shell command");

      return this.entry(id).guest.stream(params.command);
    },
    exec: this.exec.bind(this),
    files: {
      upload: async (id: string, path: string, bytes: Uint8Array) => {
        // The real boxd guest is non-root and cannot upload directly into /var/lib.
        if (path === "/var/lib/sandbox-sdk.json")
          throw Object.assign(new Error("upload failed: Permission denied"), { grpcCode: 13 });
        await this.entry(id).guest.upload(path, bytes);

        return bytes.length;
      },
      download: async (id: string, path: string) => this.entry(id).guest.read(path),
    },
    proxies: {
      list: async (id: string): Promise<Proxy[]> => [
        {
          name: null,
          machineId: id,
          machineName: id,
          domain: "test.boxd.sh",
          port: 3000,
          portMode: "locked",
          isDefault: true,
        },
      ],
      setPort: async () => {},
      create: async () => ({ name: "sdk-3000", port: 3000 }),
    },
    setEgressAllow: async (_id: string, entries: string[]) => entries,
    setBotProtection: async (_id: string, _mode: string) => {},
    pause: async (id: string) => {
      this.entry(id).machine.status = "suspended";

      return { suspendUs: 0 };
    },
    resume: async (id: string) => {
      this.entry(id).machine.status = "running";

      return { resumeUs: 0 };
    },
  };
  private exec(
    id: string,
    params: ExecParams & { encoding: "buffer" },
  ): Promise<{ stdout: Uint8Array; stderr: string; exitCode: number }>;
  private exec(
    id: string,
    params: ExecParams,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  private async exec(
    id: string,
    params: ExecParams,
  ): Promise<{ stdout: string | Uint8Array; stderr: string; exitCode: number }> {
    if (boxdState.error)
      throw Object.assign(new Error("secret-native-error"), { grpcCode: boxdState.error });

    if (!isString(params.command)) throw new Error("Expected shell command");

    const stdout =
      params.encoding === "buffer"
        ? await this.entry(id).guest.bytes(params.command)
        : await this.entry(id).guest.raw(params.command);

    return { stdout, stderr: "", exitCode: 0 };
  }
  entry(id: string) {
    if (boxdState.error)
      throw Object.assign(new Error("secret-native-error"), { grpcCode: boxdState.error });
    const v = boxdState.boxes.get(id);

    if (!v) throw Object.assign(new Error("missing"), { grpcCode: 5 });

    return v;
  }
}
