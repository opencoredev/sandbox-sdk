import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxError } from "../src/index.js";
import { daytona } from "../src/providers/daytona/index.js";
import { daytonaError } from "../src/providers/daytona/errors.js";
import { cleanupMock, failure, guest, MockDaytona, MockSandbox, requests } from "./daytona-mock.js";

const nativeFailure = () =>
  failure(400, "private body", {
    code: "QUOTA_EXCEEDED",
    headers: { "x-request-id": "3e01af1641ce491a" },
  });

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupMock();
});

describe("Daytona error evidence", () => {
  it("preserves bounded native attribution through serialization", () => {
    const native = Object.assign(new Error("private native body"), {
      statusCode: 400,
      code: "QUOTA_EXCEEDED",
      source: "DAYTONA_API",
      headers: {
        "x-request-id": "68ad3a0c-4f9e-4278-b21c-e5a733729ab3",
        authorization: "Bearer secret",
      },
      body: { password: "secret" },
    });

    const error = daytonaError(native, undefined, false, "restore");
    expect(error.cause).toMatchObject({
      status: 400,
      providerCode: "QUOTA_EXCEEDED",
      requestId: "68ad3a0c-4f9e-4278-b21c-e5a733729ab3",
      operation: "restore",
      source: "DAYTONA_API",
    });
    expect(String(error.cause)).not.toMatch(/private|password|Bearer|secret/);
    expect(JSON.parse(error.cause instanceof Error ? error.cause.message : "null")).toMatchObject({
      status: 400,
      operation: "restore",
    });
  });
  it("drops secrets, raw bodies, unsafe IDs and untrusted operation names", () => {
    const native = {
      statusCode: 999,
      code: "SECRETKEY",
      headers: { "x-request-id": "SECRETKEY", "x-daytona-request-id": "https://private" },
      response: { data: "secret" },
    };

    const error = daytonaError(native, undefined, false, "https://private", "SECRETKEY");
    expect(JSON.parse(error.cause instanceof Error ? error.cause.message : "null")).toEqual({
      operation: "request",
    });
  });
  it("attributes native create and restore failures separately", async () => {
    vi.spyOn(MockDaytona.prototype, "create").mockRejectedValue(nativeFailure());
    const provider = daytona({ apiKey: "configured-key" });

    for (const from of [undefined, "snapshot-name"]) {
      const error = await provider.create({ labels: {}, from }).catch((error) => error);
      expect(error.cause).toMatchObject({
        operation: from ? "restore" : "create",
        status: 400,
        requestId: "3e01af1641ce491a",
        providerCode: "QUOTA_EXCEEDED",
        source: "DAYTONA_DAEMON",
      });
      expect(error.code).toBe("quota");
      expect(String(error)).not.toContain("private body");
      expect(JSON.stringify(error.cause)).not.toContain("private body");
    }
  });
  it("retains evidence when snapshot recovery wraps the native failure", async () => {
    const box = await MockSandbox.create({});
    vi.spyOn(guest(box.id), "createSnapshot").mockRejectedValue(nativeFailure());
    const provider = daytona({ apiKey: "configured-key" });
    const error = await provider.snapshot!(box.id).catch((error) => error);
    expect(error.cause).toMatchObject({
      operation: "snapshot",
      status: 400,
      requestId: "3e01af1641ce491a",
    });
  });
  it("drops reflected secrets and arbitrary request IDs and codes", () => {
    for (const requestId of [
      "customer-secret-123",
      "customerSecret123",
      "z".repeat(32),
      "f".repeat(65),
    ]) {
      const error = daytonaError({
        code: "CUSTOMER_SECRET",
        headers: { "x-request-id": requestId },
      });

      expect(error.cause).not.toHaveProperty("requestId");
      expect(error.cause).not.toHaveProperty("providerCode");
    }

    const error = daytonaError(
      { code: "QUOTA_EXCEEDED", headers: { "x-request-id": "0123456789abcdef" } },
      undefined,
      false,
      "request",
      "key",
      ["QUOTA_EXCEEDED", "456789ab"],
    );

    expect(error.cause).not.toHaveProperty("providerCode");
    expect(error.cause).not.toHaveProperty("requestId");
  });
  it("cumulatively excludes create and exec environment values from later errors", async () => {
    vi.spyOn(MockDaytona.prototype, "create").mockRejectedValue(nativeFailure());
    const provider = daytona({ apiKey: "configured-key" });
    await expect(
      provider.create({ labels: {}, env: { SECRET: "QUOTA_EXCEEDED" } }),
    ).rejects.toBeDefined();
    // The sandbox does not exist, so exec fails after registering the override.
    // The subsequent native failure reflects it.
    await expect(
      provider.exec("sandbox-id", {
        command: "true",
        cwd: "/",
        env: { SECRET: "3e01af1641ce491a" },
        timeoutMs: 1000,
        onChunk() {},
      }),
    ).rejects.toBeDefined();
    const error = await provider.create({ labels: {} }).catch((error) => error);
    expect(error.cause).not.toHaveProperty("requestId");
    expect(error.cause).not.toHaveProperty("providerCode");
    expect(String(error)).not.toContain("3e01af1641ce491a");
  });
  it("keeps the API key out of errors, requests to other origins and native messages", async () => {
    const provider = daytona({ apiKey: "configured-key-123456" });
    vi.spyOn(MockDaytona.prototype, "get").mockRejectedValue(
      failure(403, "key configured-key-123456 is not allowed"),
    );

    const error = await provider.api
      .request("GET", "/sandbox/{sandboxId}", { params: { sandboxId: "x" } })
      .catch((error: unknown) => error);

    if (!(error instanceof SandboxError)) throw new Error("expected a SandboxError");
    expect(error).toMatchObject({ code: "auth", provider: "daytona" });
    // Native calls keep the provider's message, scrubbed of the credential.
    expect(error.message).toContain("is not allowed");
    expect(
      JSON.stringify({ message: error.message, cause: error.cause, hint: error.hint }),
    ).not.toContain("configured-key-123456");
    expect(requests.at(-1)?.headers.authorization).toBe("Bearer configured-key-123456");
  });
});
