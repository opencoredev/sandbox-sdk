import { describe, expect, it, vi } from "vitest";
import { daytona } from "../src/providers/daytona/index.js";

const nativeFailure = vi.hoisted(() =>
  Object.assign(new Error("private body"), {
    statusCode: 400,
    code: "QUOTA_EXCEEDED",
    headers: { "x-request-id": "3e01af1641ce491a" },
  }),
);

vi.mock("@daytonaio/sdk", () => ({
  Daytona: class {
    async create() {
      throw nativeFailure;
    }
    async get() {
      return {
        async createSnapshot() {
          throw nativeFailure;
        },
      };
    }
  },
}));

import { daytonaError } from "../src/providers/daytona/errors.js";

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
    const provider = daytona({ apiKey: "configured-key" });

    for (const from of [undefined, "snapshot-name"]) {
      const error = await provider.create({ labels: {}, from }).catch((error) => error);
      expect(error.cause).toMatchObject({
        operation: from ? "restore" : "create",
        status: 400,
        requestId: "3e01af1641ce491a",
      });
    }
  });
  it("retains evidence when snapshot recovery wraps the native failure", async () => {
    const provider = daytona({ apiKey: "configured-key" });
    const error = await provider.snapshot!("sandbox-id").catch((error) => error);
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
    const provider = daytona({ apiKey: "configured-key" });
    await expect(
      provider.create({ labels: {}, env: { SECRET: "QUOTA_EXCEEDED" } }),
    ).rejects.toBeDefined();
    // get returns a box without a process transport, so exec fails locally after
    // registering the override. The subsequent native failure reflects it.
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
  });
});
