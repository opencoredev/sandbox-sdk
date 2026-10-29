import { afterEach, describe, expect, test, vi } from "vitest";
import { RateLimitError } from "e2b";
import { createSandbox, SandboxError } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { Provider } from "../src/provider.js";
import { agentosError } from "../src/providers/agentos/errors.js";
import { errors as boatErrors } from "../src/providers/boat-api/errors.js";
import { boxdError } from "../src/providers/boxd/errors.js";
import { daytonaError } from "../src/providers/daytona/errors.js";
import { e2bError } from "../src/providers/e2b/errors.js";
import { freestyleError } from "../src/providers/freestyle/errors.js";
import { railwayError } from "../src/providers/railway/errors.js";
import { superserveError } from "../src/providers/superserve/errors.js";
import { tenkiError } from "../src/providers/tenki/errors.js";
import { upstashError } from "../src/providers/upstash/errors.js";
import { vercelError } from "../src/providers/vercel/errors.js";
import { rejection } from "./rejection.js";

const causeText = (error: SandboxError) =>
  error.cause instanceof Error ? error.cause.message : String(error.cause);

// Railway's SDK validates input with TypeError, so railway maps it to invalid_argument and keeps the text.
const mappers: [string, (cause: unknown) => SandboxError][] = [
  ["boat", (error) => boatErrors().boatError(error)],
  ["e2b", (error) => e2bError(error)],
  ["railway", (error) => railwayError(error)],
  ["vercel", (error) => vercelError(error)],
  ["superserve", (error) => superserveError(error)],
  ["boxd", (error) => boxdError(error)],
  ["agentos", (error) => agentosError(error)],
  ["daytona", (error) => daytonaError(error)],
  ["freestyle", (error) => freestyleError(error)],
  ["tenki", (error) => tenkiError(error)],
  ["upstash", (error) => upstashError(error)],
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider error mappers keep a redacted cause", () => {
  test.each(mappers)(
    "%s keeps a native TypeError as cause and says what happened",
    (_name, map) => {
      const error = map(new TypeError("m is not a constructor; Authorization: Bearer sk-live-123"));
      expect(error).toBeInstanceOf(SandboxError);
      expect(error.code).toBe(_name === "railway" ? "invalid_argument" : "provider");
      expect(causeText(error)).toContain("TypeError: m is not a constructor");
      expect(error.message).toContain("TypeError: m is not a constructor");
      expect(error.message).not.toMatch(/reported provider|\(provider\)/);
      expect(`${error.message} ${causeText(error)}`).not.toContain("sk-live-123");
    },
  );

  test.each(mappers)("%s never renders the code name as the reason", (_name, map) => {
    const error = map(
      Object.assign(new Error("server body"), {
        status: 418,
        statusCode: 418,
        grpcCode: 2,
        response: new Response(null, { status: 418 }),
      }),
    );

    expect(error.message).not.toMatch(/reported \w+|\((?:provider|auth|quota|unavailable)\)/);
  });

  test("the provider API key is redacted from native text", () => {
    vi.stubEnv("BOAT_API_KEY", "boat-key-123456");
    const error = boatErrors().boatError(new TypeError("cannot read boat-key-123456"));
    expect(error.message).toBe(
      "Boat request failed: TypeError: cannot read [REDACTED]. Check the sandbox and Boat service before retrying.",
    );
    expect(error.cause).toBe("TypeError: cannot read [REDACTED]");
  });

  test("an HTTP failure keeps its status, never the response text", () => {
    const response = Object.assign(
      new Error("Response returned an error code: echoed private body"),
      { response: new Response(null, { status: 503 }) },
    );

    const error = boatErrors().boatError(response);
    expect(error).toMatchObject({ code: "unavailable", cause: "Error HTTP 503", retryable: true });
    expect(error.message).toBe(
      "Boat request failed: the service is down or unreachable. Check the sandbox and Boat service before retrying.",
    );
    expect(error.message).not.toContain("private");
  });

  test("a recognized error keeps its name, not its text", () => {
    const error = e2bError(new RateLimitError("echoed private body"));
    expect(error).toMatchObject({ code: "quota", cause: "RateLimitError" });
    expect(error.message).toBe(
      "E2B request failed: a provider limit or billing stopped the request. Check the sandbox, template and E2B service, then retry.",
    );
  });

  test("railway reports a fetch network failure as unavailable, not invalid input", () => {
    const error = railwayError(
      new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }),
    );

    expect(error).toMatchObject({ code: "unavailable", retryable: true });
  });

  test("nested causes are kept, scrubbed and bounded", () => {
    const native = new TypeError("fetch failed", {
      cause: Object.assign(
        new Error("connect ECONNREFUSED https://user:pass@boat.dev/api?token=abc"),
        { code: "ECONNREFUSED" },
      ),
    });

    expect(boatErrors().boatError(native).cause).toBe(
      "TypeError: fetch failed; caused by Error: connect ECONNREFUSED [URL REDACTED]",
    );
  });
});

describe("the core keeps causes through redaction", () => {
  const failing = (cause: unknown): Provider => {
    const backing = memory();

    return {
      ...backing,
      exec: async () => {
        throw cause;
      },
    };
  };

  test("a raw native TypeError surfaces with cause and message, secrets redacted", async () => {
    const provider = failing(
      new TypeError("m is not a constructor for secret-value; password=hunter2"),
    );

    const box = await createSandbox(provider, { secrets: { TOKEN: "secret-value" } });

    const error = await rejection(box.run("true"));

    expect(error).toMatchObject({ code: "provider", provider: "memory", sandboxId: box.id });
    expect(error.message).toContain("m is not a constructor for [REDACTED]");
    expect(error.cause).toBe(
      "TypeError: m is not a constructor for [REDACTED]; password=[REDACTED]",
    );
    expect(`${error.message} ${String(error.cause)}`).not.toMatch(/secret-value|hunter2/);
    await box.destroy();
  });

  test("an adapter's cause passes through with sandbox secrets redacted", async () => {
    const provider = failing(
      boatErrors().boatError(new TypeError("cannot spawn with secret-value")),
    );

    const box = await createSandbox(provider, { secrets: { TOKEN: "secret-value" } });

    const error = await rejection(box.run("true"));

    expect(error).toMatchObject({
      code: "provider",
      cause: "TypeError: cannot spawn with [REDACTED]",
      message: expect.stringContaining("cannot spawn with [REDACTED]"),
    });
    await box.destroy();
  });
});
