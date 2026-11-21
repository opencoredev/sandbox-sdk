import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Redactor } from "../src/errors.js";
import { createHttpClient } from "../src/http.js";
import { SandboxError, withRetry, type ErrorCode } from "../src/index.js";
import { fakeServer, type FakeServer } from "./http-fake.js";

const failure = (code: ErrorCode, retryable: boolean, retryAfterMs?: number) =>
  new SandboxError(`failed with ${code}`, { code, retryable, retryAfterMs });

/** An action that throws each error in turn, then returns "done". */
function failing(...errors: Error[]) {
  const calls: number[] = [];

  const action = async (attempt: number) => {
    calls.push(attempt);
    const next = errors.shift();

    if (next) throw next;

    return "done";
  };

  return { action, calls };
}

describe("withRetry", () => {
  test("retries retryable SandboxErrors and passes the attempt number", async () => {
    const { action, calls } = failing(failure("unavailable", true), failure("quota", true));

    expect(await withRetry(action, { baseDelayMs: 1 })).toBe("done");
    expect(calls).toEqual([1, 2, 3]);
  });

  test("rethrows at once for a non-retryable error, outcome_unknown, or a non-SandboxError", async () => {
    for (const error of [
      failure("invalid_argument", false),
      failure("outcome_unknown", false),
      new TypeError("bug"),
    ]) {
      const { action, calls } = failing(error);

      await expect(withRetry(action, { baseDelayMs: 1 })).rejects.toBe(error);
      expect(calls).toEqual([1]);
    }
  });

  test("stops after attempts and throws the last error", async () => {
    const last = failure("unavailable", true);

    const { action, calls } = failing(
      failure("unavailable", true),
      last,
      failure("unavailable", true),
    );

    await expect(withRetry(action, { attempts: 2, baseDelayMs: 1 })).rejects.toBe(last);
    expect(calls).toEqual([1, 2]);
  });

  test("waits at least retryAfterMs, capped at maxDelayMs", async () => {
    const slow = failing(failure("quota", true, 150));
    let started = Date.now();
    await withRetry(slow.action, { baseDelayMs: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);

    const capped = failing(failure("quota", true, 60_000));
    started = Date.now();
    await withRetry(capped.action, { baseDelayMs: 0, maxDelayMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("retryIf overrides the default", async () => {
    const { action, calls } = failing(failure("not_found", false));

    expect(
      await withRetry(action, { baseDelayMs: 1, retryIf: (error) => error.code === "not_found" }),
    ).toBe("done");
    expect(calls).toEqual([1, 2]);
  });

  test("an abort ends the wait and throws aborted", async () => {
    const controller = new AbortController();
    const { action, calls } = failing(failure("unavailable", true, 60_000));
    setTimeout(() => controller.abort(), 50);

    await expect(withRetry(action, { signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(calls).toEqual([1]);
  });

  test("invalid options are invalid_argument", async () => {
    for (const options of [{ attempts: 0 }, { attempts: 1.5 }, { baseDelayMs: -1 }]) {
      await expect(withRetry(async () => "done", options)).rejects.toMatchObject({
        code: "invalid_argument",
      });
    }
  });

  test("ignores NaN retryAfterMs and handles zero-delay retries past attempt 1025 without hanging", async () => {
    let nanCalls = 0;

    const nanResult = await withRetry(
      async () => {
        nanCalls += 1;

        if (nanCalls === 1) throw failure("unavailable", true, Number.NaN);

        return "ok";
      },
      { attempts: 2, baseDelayMs: 0, maxDelayMs: 10 },
    );

    expect(nanResult).toBe("ok");
    expect(nanCalls).toBe(2);

    let zeroCalls = 0;

    const zeroResult = await withRetry(
      async () => {
        zeroCalls += 1;

        if (zeroCalls < 1026) throw failure("unavailable", true);

        return "done";
      },
      { attempts: 1026, baseDelayMs: 0, maxDelayMs: 0 },
    );

    expect(zeroResult).toBe("done");
    expect(zeroCalls).toBe(1026);
  });
});

describe("retryAfterMs comes from the provider's Retry-After", () => {
  let server: FakeServer;

  beforeEach(async () => {
    server = await fakeServer();
  });

  afterEach(async () => {
    await server.close();
  });

  test("a 429 on a request the client cannot retry itself carries Retry-After to the caller", async () => {
    server.on("POST /boxes", { status: 429, headers: { "retry-after": "3" }, json: {} });

    const http = createHttpClient({
      provider: "acme",
      label: "Acme",
      defaultPlane: "data",
      backoffMs: 1,
      timeoutMs: 2_000,
      planes: { data: { baseUrl: server.url, auth: () => ({ "x-api-key": "key-123456" }) } },
    });

    const error = await http
      .json({ method: "POST", path: "/boxes", body: {} })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "quota", retryable: true, retryAfterMs: 3_000 });
    // The core re-wraps adapter errors to redact them; the hint to wait survives.
    expect(new Redactor().error(error, "acme")).toMatchObject({ retryAfterMs: 3_000 });
  });
});
