import { describe, expect, test } from "vitest";
import { createSandbox, SandboxError } from "../src/index.js";
import { Redactor } from "../src/errors.js";
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
