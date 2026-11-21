import { describe, expect, test, vi } from "vitest";
import { SandboxError, connectSandbox, createSandbox, hasCapability } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { ExecInput, Provider } from "../src/provider.js";
import { secretRecoveryCommand } from "../src/run.js";

/** A memory sandbox whose exec always fails, like a stopped Vercel sandbox. */
async function stopped() {
  const backing = memory();
  const created = await createSandbox(backing, { secrets: { TOKEN: "secret-value" } });
  const destroy = vi.fn((id: string) => backing.destroy(id));

  const exec = vi.fn(async (_id: string, _input: ExecInput): Promise<never> => {
    throw new Error("sandbox is stopped");
  });

  const provider: Provider = {
    ...backing,
    // Like a shell provider, recovery goes through exec.
    readSecretEnvironment: undefined,
    exec,
    destroy,
    capabilities: new Set(["pause", "snapshot"]),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ id: "snap" })),
    usage: vi.fn(async () => ({ cpuMs: 1 })),
  };

  return { provider, id: created.id, exec, destroy };
}

describe("connectSandbox secret recovery", () => {
  test("connect then destroy reaches provider.destroy when the recovery exec throws", async () => {
    const { provider, id, exec, destroy } = await stopped();
    await connectSandbox(provider, id).then((box) => box.destroy());
    expect(destroy).toHaveBeenCalledWith(id);
    expect(exec).not.toHaveBeenCalled();
  });

  test("lifecycle calls never run recovery; the first command does and names the escape hatch", async () => {
    const { provider, id, exec } = await stopped();
    const box = await connectSandbox(provider, id);

    if (!hasCapability(box, "pause") || !hasCapability(box, "snapshot"))
      throw new Error("stub capabilities missing");
    await box.pause();
    await box.resume();
    await box.snapshot();
    expect(await box.usage()).toMatchObject({ cpuMs: 1, commands: 0 });
    expect(exec).not.toHaveBeenCalled();
    await expect(box.run("true")).rejects.toMatchObject({ code: "provider" });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1].command).toBe(secretRecoveryCommand);
    await box.close();
  });

  test("a failed recovery exit names recoverSecrets: false and is retried on the next call", async () => {
    const backing = memory();
    const created = await createSandbox(backing, { secrets: { TOKEN: "secret-value" } });
    let failing = true;

    // A shell provider: core's recovery command fails once, then prints the record and env.
    const provider: Provider = {
      ...backing,
      readSecretEnvironment: undefined,
      exec: (id, input) => {
        if (input.command !== secretRecoveryCommand) return backing.exec(id, input);

        if (!failing) input.onChunk({ stream: "stdout", text: '["TOKEN"]\0TOKEN=secret-value\0' });

        return Promise.resolve({ exitCode: failing ? 1 : 0, timedOut: false });
      },
    };

    const box = await connectSandbox(provider, created.id);
    await expect(box.run("printenv TOKEN")).rejects.toMatchObject({
      code: "provider",
      message: expect.stringContaining("recoverSecrets: false"),
    });
    failing = false;
    expect((await box.run("printenv TOKEN")).stdout).toBe("[REDACTED]\n");
    await box.destroy();
  });

  test("recoverSecrets: false skips the recovery exec entirely", async () => {
    const backing = memory();
    const created = await createSandbox(backing, { secrets: { TOKEN: "secret-value" } });
    const commands: string[] = [];

    const provider: Provider = {
      ...backing,
      exec: (id, input) => {
        commands.push(input.command);

        return backing.exec(id, input);
      },
    };

    const box = await connectSandbox(provider, created.id, { recoverSecrets: false });
    expect((await box.run("true")).ok).toBe(true);
    expect(commands).toEqual(["true"]);
    await box.destroy();
  });

  test("a provider's recovery hook replaces the recovery exec", async () => {
    const backing = memory();
    const created = await createSandbox(backing, { secrets: { TOKEN: "secret-value" } });
    const commands: string[] = [];

    const provider: Provider = {
      ...backing,
      exec: (id, input) => {
        commands.push(input.command);

        return backing.exec(id, input);
      },
    };

    const box = await connectSandbox(provider, created.id);
    expect((await box.run("printenv TOKEN")).stdout).toBe("[REDACTED]\n");
    expect(commands).toEqual(["printenv TOKEN"]);
    await box.destroy();
  });

  test("a process handle taken first still recovers before reading logs", async () => {
    const provider = memory();
    const created = await createSandbox(provider, { secrets: { TOKEN: "secret-value" } });
    await (await created.start("printenv TOKEN", { name: "env" })).wait();
    const box = await connectSandbox(provider, created.id);
    const handle = box.process("env");
    expect(box.process("env")).toBe(handle);
    expect((await handle.logs()).text).toBe("[REDACTED]\n");
    await box.destroy();
  });

  test("unrecovered secret-recovery errors are withheld across handle operations while preserving retryAfterMs", async () => {
    const backing = memory();
    const created = await createSandbox(backing, { secrets: { TOKEN: "unrecovered-secret-999" } });

    const provider: Provider = {
      ...backing,
      readSecretEnvironment: async () => {
        throw new SandboxError("backend exploded with unrecovered-secret-999", {
          code: "quota",
          retryable: true,
          retryAfterMs: 4200,
          provider: backing.name,
          sandboxId: created.id,
        });
      },
    };

    const box = await connectSandbox(provider, created.id);
    const proc = box.process("svc");

    const ops: Array<() => Promise<void>> = [
      async () => {
        await box.run("true");
      },
      async () => {
        await box.files.read("/etc/hosts");
      },
      async () => {
        await box.start("sleep 1");
      },
      async () => {
        await proc.logs();
      },
      async () => {
        await proc.lines()[Symbol.asyncIterator]().next();
      },
      async () => {
        await proc.stop();
      },
      async () => {
        await proc.restart();
      },
      async () => {
        await proc.wait({ timeoutMs: 200 });
      },
    ];

    for (const op of ops) {
      let caught: unknown;

      try {
        await op();
      } catch (error) {
        caught = error;
      }

      if (!(caught instanceof SandboxError)) throw new Error("expected SandboxError");
      expect(caught).toMatchObject({ code: "quota", retryable: true, retryAfterMs: 4200 });
      expect(caught.message).toContain("withheld");
      expect(caught.message).not.toContain("unrecovered-secret-999");
    }

    await box.close();
  });

  test("streaming run redaction holds fixed-point marker-overlap invariants and linear expansion", async () => {
    const cases: Array<[string[], string, string?]> = [
      [["D", "R", "]["], "DD"],
      [["D", "R", "]["], "RR][", "[REDACTED]"],
      [["D"], "[REDACTED]", "[REDACTED]"],
      [["R"], "[REDACTED]", "[REDACTED]"],
      [["ACTED"], "[REDACTED]", "[REDACTED]"],
      [["D]X"], "[REDACTED]X", "[REDACTED]"],
      [["REDACTED]X"], "AC[REDACTED]XZ", "AC[REDACTED]Z"],
      [["D]X", "E[REDACTED]"], "[REDACTED]]X"],
      [["T[", "E"], "TE["],
      [["Q", "D]Z"], "Q" + "Z".repeat(100)],
      [["TED]XYZ"], "keep-before TED]XYZ" + "XYZ".repeat(550)],
      [["[REDACTED]XYZ"], "keep-before [REDACTED]XYZ" + "XYZ".repeat(550)],
      [["XYZ[REDACTED]"], "XYZ".repeat(550) + "XYZ[REDACTED] keep-after"],
      [["X[REDACTED]Y", "A"], "keep-before " + "X".repeat(600) + "A" + "Y".repeat(600) + " tail"],
      [["X[REDACTED]Y", "A"], "X".repeat(247) + "A" + "Y".repeat(247)],
      [["T["], "T".repeat(300) + "["],
      [["sk-["], "sk-".repeat(300) + "sk-["],
      [["A[REDACTED]B", "SECRET"], "hello ASECRETB"],
    ];

    for (const chunkSize of [1, 3, 7, 64, 1000]) {
      for (const [secrets, payload, expectedExact] of cases) {
        const provider = memory({
          handlers: {
            emit({ stdout }) {
              for (let i = 0; i < payload.length; i += chunkSize) {
                stdout(payload.slice(i, i + chunkSize));
              }

              return 0;
            },
          },
        });

        const box = await createSandbox(provider, {
          secrets: Object.fromEntries(secrets.map((value, i) => [`S_${i}`, value])),
        });

        try {
          const result = await box.run("emit");
          const streamed: string[] = [];

          for await (const chunk of box.run("emit")) streamed.push(chunk.text);
          const joined = streamed.join("");

          for (const text of [result.stdout, result.output, joined]) {
            for (const secret of secrets)
              if (!"[REDACTED]".includes(secret)) expect(text).not.toContain(secret);

            if (expectedExact !== undefined) expect(text).toBe(expectedExact);

            if (payload.startsWith("keep-before ")) expect(text).toContain("keep-before ");

            if (payload.endsWith(" keep-after")) expect(text).toContain(" keep-after");

            if (payload.endsWith(" tail")) expect(text).toContain(" tail");
          }
        } finally {
          await box.destroy();
        }
      }
    }
  });

  test("streaming redaction preserves stdout/stderr arrival order, stream attribution, and stays linear without dropping non-secrets", async () => {
    const orderProvider = memory({
      handlers: {
        order({ stdout, stderr }) {
          stdout("ab");
          stderr("x");
          stdout("z");

          return 0;
        },
        orderRedactLater({ stdout, stderr }) {
          stdout("ab");
          stderr("x");
          stdout("zabc");

          return 0;
        },
        orderSpanTail({ stdout, stderr }) {
          stdout("ab");
          stderr("x");
          stdout("cTAIL");

          return 0;
        },
        attrib({ stdout, stderr }) {
          stdout("a");
          stderr("bc!");

          return 0;
        },
        attribMulti({ stdout, stderr }) {
          stdout("a");
          stderr("bcMIDDLEdef!");

          return 0;
        },
        flood({ stdout }) {
          for (let i = 0; i < 20_000; i++) stdout("T");

          return 0;
        },
      },
    });

    const box = await createSandbox(orderProvider, {
      secrets: { S1: "abc", S2: "T[", S3: "def" },
    });

    try {
      const ordered = await box.run("order");
      expect(ordered.output).toBe("abxz");

      const orderedLater = await box.run("orderRedactLater");
      expect(orderedLater.output).toBe("abxz[REDACTED]");

      const orderedSpan = await box.run("orderSpanTail");
      expect(orderedSpan.output).toBe("[REDACTED]xTAIL");

      const chunks: Array<{ stream: string; text: string }> = [];

      for await (const chunk of box.run("attrib")) chunks.push(chunk);
      expect(chunks.map((c) => `${c.stream}:${c.text}`).join("|")).toBe(
        "stdout:[REDACTED]|stderr:!",
      );

      const multi: Array<{ stream: string; text: string }> = [];

      for await (const chunk of box.run("attribMulti")) multi.push(chunk);
      expect(multi.map((c) => `${c.stream}:${c.text}`).join("|")).toBe(
        "stdout:[REDACTED]|stderr:MIDDLE|stderr:[REDACTED]|stderr:!",
      );

      const t0 = Date.now();
      const flooded = await box.run("flood");
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(flooded.stdout).toBe("T".repeat(20_000));
    } finally {
      await box.destroy();
    }
  });

  test("batch redaction stays O(n) on dense marker chains and process logs preserve literal markers with inside-marker secrets", async () => {
    const chainProvider = memory({
      handlers: {
        dense({ stdout }) {
          stdout(("Xy9" + "[REDACTED]").repeat(40_000));

          return 0;
        },
        literalMarker({ stdout }) {
          for (const ch of "[REDACTED]") stdout(ch);
          stdout("\n");

          return 0;
        },
      },
    });

    const denseBox = await createSandbox(chainProvider, { secrets: { S: "]Xy9[" } });

    try {
      const t0 = Date.now();
      const dense = await denseBox.run("dense");
      expect(Date.now() - t0).toBeLessThan(500);
      expect(dense.stdout).toBe("Xy9[REDACTED]");
    } finally {
      await denseBox.destroy();
    }

    const logBox = await createSandbox(chainProvider, {
      secrets: { A: "D", B: "R", C: "][" },
    });

    try {
      const proc = await logBox.start("literalMarker", { name: "lit" });
      await proc.wait({ timeoutMs: 5000 });
      const logs = await proc.logs();
      expect(logs.text).toBe("[REDACTED]\n");
    } finally {
      await logBox.destroy();
    }
  });

  test("extension failure while unrecovered withholds error and preserves code, retryable, and retryAfterMs", async () => {
    const base = memory();
    let boxId = "";

    const provider: Provider<
      ReturnType<typeof base.native>,
      never,
      { demo: { fail(): Promise<void> } }
    > = {
      ...base,
      capabilities: new Set(),
      readSecretEnvironment: async () => {
        throw new Error("vault unreachable");
      },
      extensions: {
        demo: () => ({
          fail: async () => {
            throw new SandboxError("ext boom top-secret-xyz", {
              code: "quota",
              retryable: true,
              retryAfterMs: 5000,
            });
          },
        }),
      },
    };

    const created = await createSandbox(provider, { secrets: { KEY: "top-secret-xyz" } });
    boxId = created.id;
    const reconnected = await connectSandbox(provider, boxId);

    try {
      let caught: Error | undefined;

      try {
        await reconnected.ext.demo.fail();
      } catch (err) {
        if (err instanceof Error) caught = err;
      }

      expect(caught).toMatchObject({
        code: "quota",
        retryable: true,
        retryAfterMs: 5000,
      });
      expect(caught?.message).not.toContain("top-secret-xyz");
    } finally {
      await created.destroy();
    }
  });
});

describe("files.write mode", () => {
  const modeOf = (provider: ReturnType<typeof memory>, id: string, path: string) =>
    provider.native(id).files.get(path)?.mode;

  test("providers without native modes get one chmod for the whole write", async () => {
    const backing = memory();
    const commands: string[] = [];

    const provider: Provider = {
      ...backing,
      files: {
        ...backing.files,
        writeSupportsMode: false,
        write: (id, path, data) => backing.files.write(id, path, data),
      },
      exec: (id, input) => {
        commands.push(input.command);

        return backing.exec(id, input);
      },
    };

    const box = await createSandbox(provider);
    await box.files.write({ "a.txt": "a", "dir/it's.txt": "b" }, { mode: 0o600 });
    expect(commands).toEqual(["chmod 600 '/workspace/a.txt' '/workspace/dir/it'\\''s.txt'"]);
    expect(modeOf(backing, box.id, "/workspace/a.txt")).toBe(0o600);
    expect(modeOf(backing, box.id, "/workspace/dir/it's.txt")).toBe(0o600);
    await box.files.write("plain.txt", "c");
    expect(commands).toHaveLength(1);
    await box.destroy();
  });

  test("a failed chmod is an error, not a silent default", async () => {
    const backing = memory();

    const provider: Provider = {
      ...backing,
      files: { ...backing.files, writeSupportsMode: false },
      exec: async () => ({ exitCode: 1, timedOut: false }),
    };

    const box = await createSandbox(provider);
    await expect(box.files.write("a.txt", "a", { mode: 0o600 })).rejects.toMatchObject({
      code: "provider",
      message: expect.stringContaining("chmod exited with 1"),
    });
    await box.destroy();
  });

  test("native modes pass through without an exec", async () => {
    const backing = memory();
    const exec = vi.fn(backing.exec);
    const box = await createSandbox({ ...backing, exec });
    await box.files.write("secret", "x", { mode: 0o640 });
    expect(exec).not.toHaveBeenCalled();
    expect(modeOf(backing, box.id, "/workspace/secret")).toBe(0o640);
    await box.destroy();
  });

  test("invalid modes are rejected before anything is written", async () => {
    const provider = memory();
    const box = await createSandbox(provider);

    for (const mode of [-1, 0o10000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(box.files.write({ bad: "x" }, { mode })).rejects.toMatchObject({
        code: "invalid_argument",
      });
    expect(await box.files.exists("bad")).toBe(false);
    await box.destroy();
  });
});

test("snapshot expiresInMs is validated before the provider is called", async () => {
  const backing = memory();
  const snapshot = vi.fn(async () => ({ id: "snap" }));
  const box = await createSandbox({ ...backing, capabilities: new Set(["snapshot"]), snapshot });

  if (!hasCapability(box, "snapshot")) throw new Error("stub capabilities missing");

  for (const expiresInMs of [-1, 1.5, Number.NaN])
    await expect(box.snapshot({ expiresInMs })).rejects.toMatchObject({ code: "invalid_argument" });
  expect(snapshot).not.toHaveBeenCalled();
  expect(await box.snapshot({ expiresInMs: 0 })).toEqual({ id: "snap" });
  expect(snapshot).toHaveBeenCalledWith(box.id, { expiresInMs: 0 });
  await box.destroy();
});

test("hardening R11: per-stream marker preservation, linear non-secret floods, quoted Bearer scrubbing, cross-realm capabilities, and hook null guard", async () => {
  const vm = await import("node:vm");
  const { deleteSnapshot } = await import("../src/index.js");
  const { scrubCredentials } = await import("../src/errors.js");

  // 1. Interleaved marker absorption preserves per-stream markers so splitting chunks by stream never leaks
  const crossStream = memory({
    handlers: {
      leak({ stdout, stderr }) {
        stdout("user=hun");
        stderr("warn k3y");
        stdout("hunter2ter2\n");

        return 0;
      },
    },
  });

  const box1 = await createSandbox(crossStream, {
    secrets: { A: "hunter2", B: "k3y[" },
  });

  try {
    const chunks: Array<{ stream: string; text: string }> = [];

    for await (const chunk of box1.run("leak")) chunks.push(chunk);

    const outOnly = chunks.flatMap((c) => (c.stream === "stdout" ? [c.text] : [])).join("");
    const errOnly = chunks.flatMap((c) => (c.stream === "stderr" ? [c.text] : [])).join("");

    expect(outOnly).not.toContain("hunter2");
    expect(errOnly).not.toContain("k3y[");
    expect(chunks.map((c) => c.text).join("")).not.toContain("hunter2");
    expect(chunks.map((c) => c.text).join("")).not.toContain("k3y[");
  } finally {
    await box1.destroy();
  }

  // 2. Partial hold prefix does not stall or drop 1.2 MiB of benign output
  const floodPayload = "x".repeat(1_200_000) + "\nend\n";

  const floodProvider = memory({
    handlers: {
      flood({ stdout }) {
        stdout(floodPayload);

        return 0;
      },
    },
  });

  const box2 = await createSandbox(floodProvider, {
    secrets: { S: "xy[REDACTED]" },
  });

  try {
    const start = Date.now();
    const res = await box2.run("flood", { maxOutputBytes: 2_000_000 });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(res.stdout).toBe(floodPayload);
    expect(res.truncated).toBe(false);
  } finally {
    await box2.destroy();
  }

  // 3. Quoted Bearer credentials are scrubbed
  expect(scrubCredentials('Authorization failed: Bearer "LEAK_123"')).toBe(
    "Authorization failed: Bearer [REDACTED]",
  );

  // 4. Cross-realm provider method is accepted by validate() and null method is rejected by hook()
  const crossRealmSnapshot = vm.runInNewContext("(async () => ({ id: 'vm-snap' }))");
  const backing = memory();

  const vmBox = await createSandbox({
    ...backing,
    capabilities: new Set(["snapshot"]),
    snapshot: crossRealmSnapshot,
  });

  await vmBox.destroy();

  await expect(
    deleteSnapshot(
      {
        ...backing,
        capabilities: new Set(["snapshot-delete"]),
        // SAFETY: Test fixture exercises a malformed runtime adapter with null method.
        deleteSnapshot: null as never,
      },
      "snap-1",
    ),
  ).rejects.toMatchObject({
    code: "provider",
    message: expect.stringContaining("Invalid adapter capabilities"),
  });
});
