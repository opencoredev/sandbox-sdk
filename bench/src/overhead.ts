import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { ExecInput } from "@opencoredev/sandbox-sdk/provider";

/** A hook MUST use a mocked native call, require no credentials/resources, and clean up.
 * sdkCall and rawCall must reach the same mock with the same response semantics.
 * Register additional factories in overheadHooks after implementing native SDK mocks.
 */
export interface OverheadFixture {
  sdkCall(): Promise<void>;
  rawCall(): Promise<void>;
  dispose(): Promise<void>;
}
export type OverheadHook = () => Promise<OverheadFixture>;
const mockedNativeCall = async () => ({ exitCode: 0, timedOut: false });
export const overheadHooks: Record<string, OverheadHook> = {
  async local() {
    const { local } = await import("@opencoredev/sandbox-sdk/local");
    const adapter = local({ dockerHost: "unix:///var/run/docker.sock" });
    const client = adapter.native("mock-local").client;
    // No socket is opened: both paths reach the same mocked Docker exec.
    client.exec = async () => (await mockedNativeCall()).exitCode;
    const backing = memory();
    const box = await createSandbox(backing);
    backing.exec = (_id, input) => adapter.exec("mock-local", input);
    return {
      async sdkCall() { if (!(await box.run("true")).ok) throw new Error("Mocked local command failed"); },
      async rawCall() { await client.exec("mock-local", ["true"], { onChunk() {} }); },
      dispose: () => box.destroy(),
    };
  },
  async memory() {
    const provider = memory();
    const box = await createSandbox(provider);
    // Replace only exec AFTER initialization: all SDK run bookkeeping stays real.
    provider.exec = (_id: string, _input: ExecInput) => mockedNativeCall();
    return {
      async sdkCall() {
        const result = await box.run("true");
        if (!result.ok) throw new Error("Mocked SDK command failed");
      },
      async rawCall() {
        await mockedNativeCall();
      },
      dispose: () => box.destroy(),
    };
  },
};
export async function cpuPerCall(action: () => Promise<void>, iterations = 100): Promise<number> {
  const before = process.cpuUsage();
  for (let index = 0; index < iterations; index++) await action();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000 / iterations;
}
