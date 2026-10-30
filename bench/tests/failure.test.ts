import { expect, it } from "vitest";
import { failureOutcome } from "../src/failure.js";

it("retains allowlisted structured cause metadata without native bodies or headers", () => {
  const error = Object.assign(
    new Error("safe provider error", {
      cause: {
        statusCode: 503,
        code: "NO_CAPACITY",
        requestId: "req-456",
        operation: "sandbox.create",
        body: "private-body",
        headers: { authorization: "private-auth" },
      },
    }),
    { code: "unavailable" },
  );

  const outcome = failureOutcome(error, (text) => text);
  expect(outcome).toEqual({
    kind: "failure",
    note: "safe provider error",
    code: "unavailable",
    cause: {
      httpStatus: 503,
      providerCode: "NO_CAPACITY",
      requestId: "req-456",
      operation: "sandbox.create",
    },
  });
  expect(JSON.stringify(outcome)).not.toContain("private");
});

it.each([
  JSON.stringify({
    status: 502,
    code: "READ_FAILED",
    operation: "POST /v5/vms/:id/fs/read",
    requestId: "safe-request-123",
    stage: "download",
    elapsedMs: 12.5,
    body: "secret-body",
    headers: { authorization: "secret-header" },
  }),
  '"status": "502", "code": "READ_FAILED", "operation": "POST /v5/vms/:id/fs/read", "requestId": "safe-request-123", "stage": "download", "elapsedMs": 12.5 body=secret-body',
  "status='502' code='READ_FAILED' operation='POST /v5/vms/:id/fs/read' requestId='safe-request-123' stage='download' elapsedMs=12.5 headers=secret-header",
])("keeps quoted and JSON attribution without copying bodies or secrets", (cause) => {
  const outcome = failureOutcome(new Error("safe adapter error", { cause }), (text) =>
    text.replaceAll("safe-request-123", "[REDACTED]"),
  );

  expect(outcome.cause).toEqual({
    httpStatus: 502,
    providerCode: "READ_FAILED",
    operation: "POST /v5/vms/:id/fs/read",
    requestId: "[REDACTED]",
    stage: "download",
    elapsedMs: 12.5,
  });
  expect(JSON.stringify(outcome)).not.toMatch(/secret-body|secret-header|safe-request-123/);
});

it("does not mine metadata from JSON bodies or serialize unknown native cause fields", () => {
  expect(
    failureOutcome(
      new Error("safe", {
        cause: JSON.stringify({
          body: { status: 502, code: "private-body" },
          headers: { requestId: "private-header" },
        }),
      }),
      (text) => text,
    ).cause,
  ).toBeUndefined();
});

it.each(["code", "providerCode", "provider_code"])(
  "normalizes numeric gRPC %s without losing the rest of native evidence",
  (key) => {
    const outcome = failureOutcome(
      new Error("native failed", {
        cause: { [key]: 14, operation: "create", stage: "waitReady", requestId: "req-14" },
      }),
      (text) => text,
    );

    expect(outcome.cause).toEqual({
      providerCode: "14",
      operation: "create",
      stage: "waitReady",
      requestId: "req-14",
    });
  },
);

it("omits only malformed allowlisted fields, retaining valid siblings and aliases", () => {
  const outcome = failureOutcome(
    new Error("failed", {
      cause: {
        providerCode: {},
        code: 0,
        httpStatus: 999,
        status: 503,
        requestId: ["secret"],
        operation: "create",
        stage: "waitReady",
        elapsedMs: -2,
        body: "secret-body",
      },
    }),
    (text) => text,
  );

  expect(outcome.cause).toEqual({
    providerCode: "0",
    httpStatus: 503,
    operation: "create",
    stage: "waitReady",
  });
  expect(JSON.stringify(outcome)).not.toContain("secret");
});

it("allowlists admitted IDs, native state and cleanup evidence with sanitized short values", () => {
  const error = Object.assign(
    new Error("create failed", {
      cause: new Error(
        JSON.stringify({
          sandboxId: "native-id",
          state: "CREATING",
          stage: "waitReady",
          cleanupCode: "unavailable",
          cleanupOutcome: "failed",
          providerCode: 14,
          body: "secret-body",
        }),
      ),
    }),
    { sandboxId: "native-id" },
  );

  expect(failureOutcome(error, (s) => s)).toMatchObject({
    sandboxId: "native-id",
    cause: {
      sandboxId: "native-id",
      nativeState: "CREATING",
      stage: "waitReady",
      cleanupCode: "unavailable",
      cleanupOutcome: "failed",
      providerCode: "14",
    },
  });
  expect(
    failureOutcome(
      new Error("safe", {
        cause: {
          nativeState: { body: "secret" },
          cleanupCode: "arbitrary error body with spaces",
          operation: "create",
        },
      }),
      (s) => s,
    ).cause,
  ).toEqual({ operation: "create" });
  expect(
    failureOutcome(error, (s) => s.replaceAll("native-id", "[REDACTED]")).sandboxId,
  ).toBeUndefined();
});
