import {expect, it} from "vitest";
import {failureOutcome} from "../src/failure.js";

it("retains allowlisted structured cause metadata without native bodies or headers", () => {
  const error = Object.assign(new Error("safe provider error", {cause: {
    statusCode: 503, code: "NO_CAPACITY", requestId: "req-456", operation: "sandbox.create",
    body: "private-body", headers: {authorization: "private-auth"},
  }}), {code: "unavailable"});
  const outcome = failureOutcome(error, text => text);
  expect(outcome).toEqual({kind: "failure", note: "safe provider error", code: "unavailable", cause: {
    httpStatus: 503, providerCode: "NO_CAPACITY", requestId: "req-456", operation: "sandbox.create",
  }});
  expect(JSON.stringify(outcome)).not.toContain("private");
});


it.each([
  JSON.stringify({status: 502, code: "READ_FAILED", operation: "POST /v5/vms/:id/fs/read", requestId: "safe-request-123", stage: "download", elapsedMs: 12.5, body: "secret-body", headers: {authorization: "secret-header"}}),
  '"status": "502", "code": "READ_FAILED", "operation": "POST /v5/vms/:id/fs/read", "requestId": "safe-request-123", "stage": "download", "elapsedMs": 12.5 body=secret-body',
  "status='502' code='READ_FAILED' operation='POST /v5/vms/:id/fs/read' requestId='safe-request-123' stage='download' elapsedMs=12.5 headers=secret-header",
])("keeps quoted and JSON attribution without copying bodies or secrets", cause => {
  const outcome = failureOutcome(new Error("safe adapter error", {cause}), text => text.replaceAll("safe-request-123", "[REDACTED]"));
  expect(outcome.cause).toEqual({httpStatus: 502, providerCode: "READ_FAILED", operation: "POST /v5/vms/:id/fs/read", requestId: "[REDACTED]", stage: "download", elapsedMs: 12.5});
  expect(JSON.stringify(outcome)).not.toMatch(/secret-body|secret-header|safe-request-123/);
});

it("does not mine metadata from JSON bodies or serialize unknown native cause fields", () => {
  expect(failureOutcome(new Error("safe", {cause: JSON.stringify({body: {status: 502, code: "private-body"}, headers: {requestId: "private-header"}})}), text => text).cause).toBeUndefined();
});
