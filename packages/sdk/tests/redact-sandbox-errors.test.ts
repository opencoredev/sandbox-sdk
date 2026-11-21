import { describe, expect, test } from "vitest";
import { createSandbox, SandboxError } from "../src/index.js";
import { Redactor, evidenceCause, scrubCredentials } from "../src/errors.js";
import { memory } from "../src/memory.js";

const causeText = (error: SandboxError) => String(error.cause);

describe("Redactor.error scrubs a SandboxError like any other failure", () => {
  test("a token in the cause URL is removed", () => {
    const error = new Redactor().error(
      new SandboxError("request failed", {
        code: "provider",
        cause: new Error("GET https://api.example/?token=abc failed"),
      }),
      "stub",
    );

    expect(causeText(error)).not.toContain("abc");
    expect(causeText(error)).toContain("[URL REDACTED]");
  });

  test("auth headers and key=value credentials are removed from message, hint and cause", () => {
    const original = new SandboxError(
      "upload failed: Authorization: Bearer sk-live-1 api_key=k-123",
      { code: "provider", hint: "Retry with password=hunter2.", cause: "token=t-999 rejected" },
    );

    const error = new Redactor().error(original, "stub");
    const text = `${error.message} ${error.hint} ${causeText(error)}`;

    for (const secret of ["sk-live-1", "k-123", "hunter2", "t-999"])
      expect(text).not.toContain(secret);
    expect(error.message).toBe("upload failed: Authorization: [REDACTED]");
  });

  test("registered secrets are still redacted, and multi-line messages keep their lines", () => {
    const redactor = new Redactor();
    redactor.add(["s3cr3t-value"]);

    const error = redactor.error(
      new SandboxError(
        "Process exited before readiness. Check the last logs: line one\nusing s3cr3t-value\nline three",
        { code: "process_exited", cause: new Error("s3cr3t-value") },
      ),
      "stub",
      "box-1",
    );

    expect(error.message).toBe(
      "Process exited before readiness. Check the last logs: line one\nusing [REDACTED]\nline three",
    );
    expect(causeText(error)).toBe("[REDACTED]");
    expect(error).toMatchObject({ code: "process_exited", provider: "stub", sandboxId: "box-1" });
  });
});

test("redacts secrets spanning stdout and stderr in output and subscriptions", async () => {
  const provider = memory({
    handlers: {
      split({ stdout, stderr }) {
        stdout("ab");
        stderr("cd");

        return 0;
      },
    },
  });

  const box = await createSandbox(provider, { secrets: { TOKEN: "abcd" } });

  try {
    expect((await box.run("split")).output).toBe("[REDACTED]");
    const chunks = [];

    for await (const chunk of box.run("split")) chunks.push(chunk.text);
    expect(chunks.join("")).toBe("[REDACTED]");
  } finally {
    await box.destroy();
  }
});

describe("Redactor.error keeps adapter evidence valid, bounded JSON", () => {
  test("credential patterns inside a field are scrubbed without breaking the JSON around them", () => {
    const original = new SandboxError("boxd request failed", {
      code: "invalid_argument",
      provider: "boxd",
      cause: evidenceCause({
        operation: "machines.resume",
        providerCode: 9,
        providerMessage: "rejected token=abc123 authorization: Bearer zzz9",
        native: "x".repeat(2000),
      }),
    });

    const cause = String(new Redactor().error(original, "boxd").cause);
    const fields: unknown = JSON.parse(cause);

    expect(cause.length).toBeLessThanOrEqual(1000);
    expect(fields).toMatchObject({ operation: "machines.resume", providerCode: 9 });
    expect(cause).not.toMatch(/abc123|zzz9/);
  });

  test("a registered secret is found even when JSON escaping changed it, and no cut leaves part of one", () => {
    const redactor = new Redactor();
    redactor.add(['quo"te\\secret', "LONGSECRET0123456789"]);

    const original = new SandboxError("boxd request failed", {
      code: "provider",
      provider: "boxd",
      cause: evidenceCause({
        providerMessage: `echo quo"te\\secret and ${"x".repeat(290)}LONGSECRET0123456789`,
      }),
    });

    const cause = String(redactor.error(original, "boxd").cause);
    const fields: unknown = JSON.parse(cause);
    const message = isObjectWith(fields) ? fields.providerMessage : undefined;

    expect(message).toBeTypeOf("string");
    expect(message).not.toContain("quo");
    expect(message).not.toContain("LONGSEC");
  });

  test("a field named like a credential is redacted, as the whole-text scrub did", () => {
    const original = new SandboxError("failed", {
      code: "provider",
      cause: evidenceCause({ operation: "create", requestId: "req-1" }),
    });

    for (const key of ["token", "api_key", "password", "accessToken"]) {
      const cause = new Redactor().error(
        new SandboxError("failed", {
          code: "provider",
          cause: new Error(JSON.stringify({ [key]: "fixture-value-1" })),
        }),
        "stub",
      ).cause;

      expect(String(cause)).not.toContain("fixture-value-1");
    }

    expect(JSON.parse(String(new Redactor().error(original, "stub").cause))).toEqual({
      operation: "create",
      requestId: "req-1",
    });
  });

  test("evidence with too many fields stays valid JSON within 1,000 characters", () => {
    const fields = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`field${i}`, `value ${i} `.repeat(10)]),
    );

    const original = new SandboxError("failed", {
      code: "provider",
      cause: new Error(JSON.stringify(fields)),
    });

    const cause = String(new Redactor().error(original, "stub").cause);

    expect(cause.length).toBeLessThanOrEqual(1000);
    expect(() => JSON.parse(cause)).not.toThrow();
  });

  test("a numeric secret is redacted, under a credential key or as a registered secret", () => {
    const redactor = new Redactor();
    redactor.add(["987654"]);

    const original = new SandboxError("failed", {
      code: "provider",
      cause: evidenceCause({ providerCode: 987654, operation: "create", stage: "boot" }),
    });

    const fromKey = new Redactor().error(
      new SandboxError("failed", {
        code: "provider",
        cause: new Error('{"token":123456,"providerCode":5}'),
      }),
      "stub",
    ).cause;

    expect(JSON.parse(String(fromKey))).toEqual({ token: "[REDACTED]", providerCode: 5 });
    expect(JSON.parse(String(redactor.error(original, "stub").cause))).toEqual({
      providerCode: "[REDACTED]",
      operation: "create",
      stage: "boot",
    });
  });

  test("a cause that is not flat evidence is scrubbed as text, as before", () => {
    const original = new SandboxError("failed", {
      code: "provider",
      cause: new Error('{"body":{"token":"abc123"}}'),
    });

    const cause = String(new Redactor().error(original, "stub").cause);

    expect(cause).not.toContain("abc123");
  });
});

function isObjectWith(value: unknown): value is { providerMessage?: unknown } {
  return typeof value === "object" && value !== null;
}

describe("Redactor.text redacts to a fixed point", () => {
  const redact = (secrets: string[], text: string) => {
    const redactor = new Redactor();
    redactor.add(secrets);

    return redactor.text(text);
  };

  test("a secret inside the marker does not mangle an earlier replacement", () => {
    expect(redact(["supersecret", "RED"], "token=supersecret")).toBe("token=[REDACTED]");
  });

  test("a one-letter secret that the marker contains is replaced only where it appears", () => {
    expect(redact(["abc", "E"], "abc")).toBe("[REDACTED]");
    expect(redact(["abc", "E"], "xEx abc")).toBe("x[REDACTED]x [REDACTED]");
  });

  test("the longest secret wins where secrets overlap, and regex characters are literal", () => {
    expect(redact(["ab", "abcd"], "abcd ab")).toBe("[REDACTED] [REDACTED]");
    expect(redact(["a.b(+)"], "a.b(+) axb(+)")).toBe("[REDACTED] axb(+)");
  });

  test("redaction is idempotent even across replacement-created marker boundaries", () => {
    for (const [secrets, input, expected] of [
      [["supersecret", "RED"], "supersecret RED", "[REDACTED] [REDACTED]"],
      [["TED]XYZ"], "TED]XYZXYZ", "[REDACTED]"],
      [["TED]XYZ"], `TED]XYZ${"XYZ".repeat(40)}`, "[REDACTED]"],
      [["Q", "D]Z"], `Q${"Z".repeat(100)}`, "[REDACTED]"],
      [["RED", "D]Z"], "REDZ", "[REDACTED]"],
      [["T[", "E"], "TE[", "[REDACTED]["],
      [["]C", "A"], "[REDACTED]C", "[REDACTED]"],
      [["][", "R"], "R][", "[REDACTED]"],
      [["D", "]["], "DD", "[REDACTED]"],
      [["D", "R", "]["], "DD", "[REDACTED]"],
    ] as const) {
      const once = redact([...secrets], input);

      expect(once).toBe(expected);

      for (const secret of secrets)
        if (!"[REDACTED]".includes(secret)) expect(once).not.toContain(secret);
      expect(redact([...secrets], once)).toBe(once);
    }
  });

  test("redacts JSON-escaped quoted Bearer tokens", () => {
    const out = scrubCredentials('failed: Bearer \\"LEAK_123\\"');
    const jsonOut = scrubCredentials('{"headers":{"Authorization":"Bearer \\"LEAK_123\\""}}');

    expect(out).toBe("failed: Bearer [REDACTED]");
    expect(jsonOut).not.toContain("LEAK_123");
    expect(jsonOut).toContain("[REDACTED]");
  });

  test("streams stay linear on 1-byte stalled runs and set truncated when >1 MiB is dropped", async () => {
    const provider = memory({
      handlers: {
        oneByteSame({ stdout }) {
          for (let i = 0; i < 39_960; i += 1) stdout("T");

          return 0;
        },
        oneByteAlt({ stdout, stderr }) {
          for (let i = 0; i < 20_040; i += 1) {
            stdout("T");
            stderr("T");
          }

          return 0;
        },
        hugeStalled({ stdout, stderr }) {
          stdout("A");

          for (let i = 0; i < 1_100; i += 1) stderr("x".repeat(1_024));

          return 0;
        },
      },
    });

    await using box = await createSandbox(provider, { secrets: { TOK: "T".repeat(120) } });

    const t0 = Date.now();
    const same = await box.run("oneByteSame");
    const alt = await box.run("oneByteAlt");

    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(same.output).toBe("[REDACTED]".repeat(333));
    expect(alt.output).toBe("[REDACTED]".repeat(334));

    await using stallBox = await createSandbox(provider, { secrets: { S: "AB" } });
    const huge = await stallBox.run("hugeStalled", { maxOutputBytes: 2_000_000 });

    expect(huge.truncated).toBe(true);
    expect(huge.stdout).toBe("[REDACTED]");
  });

  test("handles huge secrets, linear escaped Bearer scrubbing, alternating T[REDACTED] stalls, and benign XY[REDACTED] streams", async () => {
    const bigSecret = "a".repeat(100_000);
    const bigRedactor = new Redactor();
    bigRedactor.add([bigSecret]);

    expect(bigRedactor.text(`pre ${bigSecret} post`)).toBe("pre [REDACTED] post");

    const tBearer = Date.now();
    const evilBearer = `Bearer \\"${"a".repeat(50_000)}`;

    expect(scrubCredentials(evilBearer)).toBe("Bearer [REDACTED]");
    expect(Date.now() - tBearer).toBeLessThan(1_000);
    expect(scrubCredentials('Bearer \\"LEAK_123')).toBe("Bearer [REDACTED]");

    const provider = memory({
      handlers: {
        altFlush({ stdout, stderr }) {
          for (let i = 0; i < 4_000; i++) {
            stdout("T");
            stderr("T");
          }

          return 0;
        },
        altUnblock({ stdout, stderr }) {
          for (let i = 0; i < 4_000; i++) {
            stdout("T");
            stderr("T");
          }

          stdout("Z");
          stderr("Z");

          return 0;
        },
        benignX({ stdout }) {
          for (let i = 0; i < 1_100; i++) {
            stdout("X".repeat(1_024));
          }

          return 0;
        },
      },
    });

    await using tBox = await createSandbox(provider, { secrets: { S: "T[REDACTED]" } });
    const t0 = Date.now();
    const flushed = await tBox.run("altFlush");
    const unblocked = await tBox.run("altUnblock");

    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(flushed.stdout).toBe("T".repeat(4_000));
    expect(flushed.stderr).toBe("T".repeat(4_000));
    expect(unblocked.stdout).toBe(`${"T".repeat(4_000)}Z`);
    expect(unblocked.stderr).toBe(`${"T".repeat(4_000)}Z`);

    await using xyBox = await createSandbox(provider, { secrets: { S: "XY[REDACTED]" } });
    const benign = await xyBox.run("benignX", { maxOutputBytes: 2_000_000 });

    expect(benign.truncated).toBe(false);
    expect(benign.stdout.length).toBe(1_100 * 1_024);
  });
});
