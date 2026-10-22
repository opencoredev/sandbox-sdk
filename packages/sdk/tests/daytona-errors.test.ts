import { describe, expect, it, vi } from "vitest";
import { daytona } from "../src/providers/daytona/index.js";
const nativeFailure = vi.hoisted(() => Object.assign(new Error("private body"), {
  statusCode: 400, code: "QUOTA_EXCEEDED", headers: { "x-request-id": "req-456" },
}));
vi.mock("@daytonaio/sdk", () => ({ Daytona: class {
  async create() { throw nativeFailure; }
  async get() { return { async createSnapshot() { throw nativeFailure; } }; }
} }));
import { daytonaError } from "../src/providers/daytona/errors.js";

describe("Daytona error evidence", () => {
  it("preserves bounded native attribution through serialization", () => {
    const native = Object.assign(new Error("private native body"), {
      statusCode: 400, code: "QUOTA_EXCEEDED", source: "DAYTONA_API",
      headers: { "x-request-id": "req-123", authorization: "Bearer secret" },
      body: { password: "secret" },
    });
    const error = daytonaError(native, undefined, false, "restore");
    expect(error.cause).toMatchObject({ status: 400, providerCode: "QUOTA_EXCEEDED", requestId: "req-123", operation: "restore", source: "DAYTONA_API" });
    expect(String(error.cause)).not.toMatch(/private|password|Bearer|secret/);
    expect(JSON.parse(error.cause instanceof Error ? error.cause.message : "null")).toMatchObject({ status: 400, operation: "restore" });
  });
  it("drops secrets, raw bodies, unsafe IDs and untrusted operation names", () => {
    const native = { statusCode: 999, code: "SECRETKEY", headers: { "x-request-id": "SECRETKEY", "x-daytona-request-id": "https://private" }, response: { data: "secret" } };
    const error = daytonaError(native, undefined, false, "https://private", "SECRETKEY");
    expect(JSON.parse(error.cause instanceof Error ? error.cause.message : "null")).toEqual({ operation: "request" });
  });
  it("attributes native create and restore failures separately", async () => {
    const provider = daytona({ apiKey: "configured-key" });
    for (const from of [undefined, "snapshot-name"]) {
      const error = await provider.create({ labels: {}, from }).catch(error => error);
      expect(error.cause).toMatchObject({ operation: from ? "restore" : "create", status: 400, requestId: "req-456" });
    }
  });
  it("retains evidence when snapshot recovery wraps the native failure", async () => {
    const provider = daytona({ apiKey: "configured-key" });
    const error = await provider.snapshot!("sandbox-id").catch(error => error);
    expect(error.cause).toMatchObject({ operation: "snapshot", status: 400, requestId: "req-456" });
  });
});
