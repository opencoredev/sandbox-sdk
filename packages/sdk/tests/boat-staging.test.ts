import { afterAll, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { createSandbox } from "../src/index.js";
import { boat, type BoatOptions } from "../src/providers/boat/index.js";
import { sandboxer } from "../src/providers/sandboxer/index.js";
import { boatMock } from "./boat-mock.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const mocks = { boat: await boatMock("boat"), sandboxer: await boatMock("sandboxer") };

afterAll(() => Promise.all(Object.values(mocks).map((mock) => mock.dispose())));

const factories = {
  boat: (options: BoatOptions = {}) =>
    boat({ ...options, apiKey: "test-key", baseUrl: mocks.boat.apiUrl }),
  sandboxer: (options: BoatOptions = {}) =>
    sandboxer({ ...options, apiKey: "test-key", baseUrl: mocks.sandboxer.apiUrl }),
};

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** Fails when a command carries the marker, raw or inside any base64 run. */
function expectAbsent(commands: readonly string[], marker: string) {
  expect(commands.length).toBeGreaterThan(0);

  for (const command of commands) {
    expect(command.length).toBeLessThan(8192);
    expect(command).not.toContain(marker);

    for (const token of command.match(/[A-Za-z0-9+/=]{16,}/g) ?? [])
      for (const shift of [0, 1, 2, 3])
        expect(Buffer.from(token.slice(shift), "base64").toString("latin1")).not.toContain(
          marker.slice(0, 12),
        );
  }
}

describe.each(["boat", "sandboxer"] as const)(
  "%s keeps stdin and file bytes out of commands",
  (name) => {
    const mock = mocks[name];
    const factory = factories[name];

    test.each([10, 20 * 1024, 5 * 1024 * 1024])(
      "stdin of %i bytes arrives intact",
      async (size) => {
        const box = await createSandbox(factory());

        try {
          const marker = `stdin-secret-${crypto.randomUUID()}`;
          const stdin = marker.repeat(Math.ceil(size / marker.length)).slice(0, size);
          const before = mock.commands.length;
          const writes = mock.fileWrites.length;
          const result = await box.run("sha256sum | cut -d' ' -f1", { stdin });
          expect(result.stdout.trim()).toBe(sha256(stdin));
          expectAbsent(mock.commands.slice(before), marker.slice(0, Math.min(size, marker.length)));

          const staged = mock.fileWrites
            .slice(writes)
            .filter((file) => file.path.includes("/stdin-"));

          expect(staged.length).toBe(Math.ceil(size / (4 * 1024 * 1024)));

          for (const file of staged)
            expect(file).toMatchObject({ mode: 0o600, directoryMode: 0o700 });
          expect(
            (await box.run("find /tmp/.sandbox-sdk -name 'stdin-*' | wc -l")).stdout.trim(),
          ).toBe("0");
        } finally {
          await box.destroy();
        }
      },
    );

    test("a run without stdin reads EOF and uploads nothing", async () => {
      const box = await createSandbox(factory());

      try {
        const before = mock.calls.length;
        expect((await box.run("wc -c")).stdout.trim()).toBe("0");
        expect(mock.calls.slice(before).filter((call) => call.startsWith("PUT "))).toEqual([]);
        expect(
          mock.calls.slice(before).filter((call) => /POST .*\/commands$/.test(call)),
        ).toHaveLength(1);
      } finally {
        await box.destroy();
      }
    });

    test("setup failure still removes staged stdin", async () => {
      const box = await createSandbox(factory());

      try {
        mock.failSetup = true;
        await expect(box.run("cat", { stdin: "private input" })).rejects.toMatchObject({
          code: "provider",
          provider: name,
        });
        mock.failSetup = false;
        expect(
          (await box.run("find /tmp/.sandbox-sdk -name 'stdin-*' | wc -l")).stdout.trim(),
        ).toBe("0");
      } finally {
        mock.failSetup = false;
        await box.destroy();
      }
    });

    test("writes outside the file API roots or above its size limit stage privately", async () => {
      const box = await createSandbox(factory());

      try {
        const marker = `file-secret-${crypto.randomUUID()}`;
        const small = `${marker}\n`;
        const large = Buffer.from(marker.repeat(Math.ceil((6 * 1024 * 1024) / marker.length)));
        const before = mock.commands.length;
        const writes = mock.fileWrites.length;
        await box.files.write("/workspace/x", small);
        await box.files.write("/tmp/.sandbox-sdk/large/file", large);
        expect(await box.files.read("/workspace/x")).toBe(small);
        expect(
          (await box.run("sha256sum /tmp/.sandbox-sdk/large/file | cut -d' ' -f1")).stdout.trim(),
        ).toBe(sha256(large));
        expectAbsent(mock.commands.slice(before), marker);

        const staged = mock.fileWrites
          .slice(writes)
          .filter((file) => file.path.includes("/write-"));

        expect(staged).toHaveLength(3);

        for (const file of staged)
          expect(file).toMatchObject({ mode: 0o600, directoryMode: 0o700 });
        expect(
          (await box.run("find /tmp/.sandbox-sdk -name 'write-*' | wc -l")).stdout.trim(),
        ).toBe("0");
      } finally {
        await box.destroy();
      }
    });

    test("mode is applied by the adapter, including over an existing file", async () => {
      const provider = factory();
      expect(provider.files.writeSupportsMode).toBe(true);
      const box = await createSandbox(provider);
      const mode = async (path: string) => (await box.run(`stat -c %a ${path}`)).stdout.trim();

      try {
        await box.files.write("open.txt", "public");
        expect(await mode("open.txt")).not.toBe("600"); // umask default
        await box.files.write("open.txt", "secret", { mode: 0o600 });
        expect(await mode("open.txt")).toBe("600");
        expect(await box.files.read("open.txt")).toBe("secret");
        await box.files.write(
          { "bin/tool": "#!/bin/sh\necho hi\n", "bin/key": "k" },
          { mode: 0o700 },
        );
        expect([await mode("bin/tool"), await mode("bin/key")]).toEqual(["700", "700"]);
        expect((await box.run("bin/tool")).stdout).toBe("hi\n");
        // Inside the file API's roots a mode still forces private staging.
        const before = mock.calls.length;
        await box.files.write("/tmp/.sandbox-sdk/moded/file", "token", { mode: 0o640 });
        expect(mock.calls.slice(before).length).toBeGreaterThan(1);
        expect(await mode("/tmp/.sandbox-sdk/moded/file")).toBe("640");
      } finally {
        await box.destroy();
      }
    });

    test("invalid modes fail before touching the sandbox", async () => {
      const provider = factory();
      const box = await createSandbox(provider);

      try {
        const before = mock.calls.length;

        for (const mode of [-1, 0o10000, 1.5, Number.NaN])
          await expect(
            provider.files.write(box.id, "/workspace/m", new Uint8Array(), { mode }),
          ).rejects.toMatchObject({ code: "invalid_argument" });
        expect(mock.calls.length).toBe(before);
      } finally {
        await box.destroy();
      }
    });
  },
);

describe.each(["boat", "sandboxer"] as const)("%s native create options", (name) => {
  const mock = mocks[name];
  const factory = factories[name];

  test("lifetime, snapshot, monitoring and billing fields reach the create body", async () => {
    let box = await createSandbox(
      factory({ ttlSeconds: 600, snapshots: false, monitoring: false, org: "acme" }),
    );

    await box.destroy();
    expect(mock.creates.at(-1)).toMatchObject({
      noEnv: true,
      ttlSeconds: 600,
      snapshots: false,
      monitoring: false,
      org: "acme",
    });
    box = await createSandbox(factory({ ttlSeconds: null }));
    await box.destroy();
    expect(mock.creates.at(-1)).toMatchObject({ ttlSeconds: null });
    box = await createSandbox(factory());
    await box.destroy();
    expect(Object.keys(mock.creates.at(-1) ?? {})).not.toContain("ttlSeconds");
  });

  test("invalid ttlSeconds and hard lifetimes fail before creating", async () => {
    const before = mock.creates.length;

    for (const ttlSeconds of [0, 1.5, 2_592_001])
      await expect(createSandbox(factory({ ttlSeconds }))).rejects.toMatchObject({
        code: "invalid_argument",
      });
    await expect(createSandbox(factory(), { timeoutMs: 60_000 })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(mock.creates.length).toBe(before);
  });
});

test("Boat rejects idleTimeoutMs; Sandboxer maps it to whole idle-stop minutes", async () => {
  await expect(createSandbox(factories.boat(), { idleTimeoutMs: 60_000 })).rejects.toMatchObject({
    code: "unsupported",
  });
  const box = await createSandbox(factories.sandboxer(), { idleTimeoutMs: 90_000 });
  await box.destroy();
  expect(mocks.sandboxer.creates.at(-1)).toMatchObject({ idleStopMinutes: 2 });
  const before = mocks.sandboxer.creates.length;
  await expect(
    createSandbox(factories.sandboxer(), { idleTimeoutMs: 8 * 24 * 3_600_000 }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  await expect(
    createSandbox(factories.sandboxer({ snapshots: false }), { idleTimeoutMs: 60_000 }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(mocks.sandboxer.creates.length).toBe(before);
});

test("Sandboxer snapshots refuse an expiry but accept 0 (keep until deleted)", async () => {
  const box = await createSandbox(factories.sandboxer());

  try {
    await expect(box.snapshot({ expiresInMs: 60_000 })).rejects.toMatchObject({
      code: "unsupported",
      provider: "sandboxer",
    });
    expect((await box.snapshot({ expiresInMs: 0 })).id).toMatch(/^sdk-/);
  } finally {
    await box.destroy();
  }
});
