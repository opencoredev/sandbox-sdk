import { describe, expect, test } from "bun:test";
import { createSandboxHarnessProvider } from "../../src/ai/harness";
import { createEveSandboxBackend } from "../../src/eve";
import { local } from "../../src/providers/local";
import type { Experimental_SandboxSession } from "ai";

describe("managed integrations", () => {
  test("cleans up failed bootstraps and allows the identity to retry", async () => {
    const harness = createSandboxHarnessProvider({ provider: local() });
    await expect(
      harness.createSession({
        sessionId: "failed-bootstrap",
        identity: "retryable-template",
        async onFirstCreate() {
          throw new Error("bootstrap failed");
        },
      }),
    ).rejects.toThrow("bootstrap failed");

    const retried = await harness.createSession({
      sessionId: "retried-bootstrap",
      identity: "retryable-template",
      async onFirstCreate(sandbox) {
        await sandbox.writeTextFile({ path: "retry.txt", content: "ok" });
      },
    });
    expect(await retried.readTextFile({ path: "retry.txt" })).toBe("ok");
    await retried.destroy?.();
  });

  test("bootstraps once per identity and isolates sessions", async () => {
    const harness = createSandboxHarnessProvider({
      provider: local(),
      ports: [3000],
    });
    expect(harness.bridgePorts).toBeUndefined();
    let bootstraps = 0;
    const onFirstCreate = async (sandbox: Experimental_SandboxSession) => {
      bootstraps++;
      await sandbox.writeTextFile({ path: "seed.txt", content: "seed" });
    };
    const one = await harness.createSession({
      sessionId: "one",
      identity: "repo-v1",
      onFirstCreate,
    });
    const two = await harness.createSession({
      sessionId: "two",
      identity: "repo-v1",
      onFirstCreate,
    });
    expect(bootstraps).toBe(1);
    expect(await two.readTextFile({ path: "seed.txt" })).toBe("seed");
    await one.writeTextFile({ path: "only-one.txt", content: "one" });
    expect(await two.readTextFile({ path: "only-one.txt" })).toBeNull();
    expect("stop" in one.restricted()).toBe(false);
    expect("setNetworkPolicy" in one.restricted()).toBe(false);
    await one.stop();
    const resumed = await harness.resumeSession!({ sessionId: "one" });
    expect(await resumed.readTextFile({ path: "only-one.txt" })).toBe("one");
    await resumed.destroy?.();
    await two.destroy?.();
  });

  test("maps Eve prewarm, seeds, bootstrap, and reconnect state", async () => {
    const provider = local();
    const backend = createEveSandboxBackend({ provider });
    const result = await backend.prewarm({
      templateKey: "template-v1",
      runtimeContext: { appRoot: "/tmp/app" },
      seedFiles: [{ path: "seed.txt", content: "seed" }],
      async bootstrap({ use }) {
        const sandbox = await use();
        await sandbox.writeTextFile({ path: "boot.txt", content: "boot" });
      },
    });
    expect(result.reused).toBe(false);
    const handle = await backend.create({
      templateKey: "template-v1",
      sessionKey: "eve-session",
      runtimeContext: { appRoot: "/tmp/app" },
    });
    expect(await handle.session.readTextFile({ path: "seed.txt" })).toBe("seed");
    expect(await handle.session.readTextFile({ path: "boot.txt" })).toBe("boot");
    await handle.session.writeTextFile({ path: "durable.txt", content: "yes" });
    const state = await handle.captureState();
    await handle.shutdown();
    const resumed = await backend.create({
      templateKey: "template-v1",
      sessionKey: "eve-session",
      existingMetadata: state.metadata,
      runtimeContext: { appRoot: "/tmp/app" },
    });
    expect(await resumed.session.readTextFile({ path: "durable.txt" })).toBe("yes");
    await resumed.shutdown();
    await (await provider.managed!.resume({ sessionId: "eve-session" })).destroy();
  });
});
