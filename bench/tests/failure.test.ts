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
