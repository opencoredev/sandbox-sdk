import { describe, expect, test } from "vitest";
import { createSandbox, SandboxError } from "../src/index.js";
import { Redactor, evidenceCause } from "../src/errors.js";
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
