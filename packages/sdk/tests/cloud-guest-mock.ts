/** Fake control plane; the guest commands, supervisor and files execute on Linux. */
import * as boxdSdk from "@boxd-sh/sdk";
import {
  type BoxdOptions as BoxdClientOptions,
  type StreamExecParams,
  type Machine,
  type MachineCreateParams,
  type ExecParams,
  type Proxy,
} from "@boxd-sh/sdk";
import {
  createBoxdProvider,
  type BoxdClient,
  type BoxdOptions,
  type OpenTransfers,
} from "../src/providers/boxd/provider.js";
import { FileTransfers } from "../src/providers/boxd/transfers.js";
import { isString } from "../src/shared/narrow.js";
import { MockGuest } from "./mock-guest.js";

export { MockGuest };

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
  snapshots: BoxdClient["snapshots"] = {
    create: async () => {
      throw new Error("boxd snapshots are not mocked");
    },
    get: async () => {
      throw new Error("boxd snapshots are not mocked");
    },
    delete: async () => {
      throw new Error("boxd snapshots are not mocked");
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

/** The boxd adapter with `client` (by default MockBoxd) in place of the SDK's client.
 * Whole-file transfers use the real worker client unless `transfers` replaces it.
 */
export function boxd(
  options: BoxdOptions = {},
  client: new (config: BoxdClientOptions) => MockBoxd = MockBoxd,
  transfers: OpenTransfers = (config, signal) => new FileTransfers(config, signal),
) {
  return createBoxdProvider(options, async () => ({ ...boxdSdk, Boxd: client }), transfers);
}
