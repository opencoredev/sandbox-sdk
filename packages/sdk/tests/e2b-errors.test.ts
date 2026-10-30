import { test, expect } from "vitest";
import {
  AuthenticationError,
  FileNotFoundError,
  SandboxNotFoundError,
  RateLimitError,
  TimeoutError,
  InvalidArgumentError,
  ServiceBusyError,
  NotEnoughSpaceError,
} from "e2b";
import { e2bError } from "../src/providers/e2b/errors.js";

test.each([
  [new AuthenticationError("private"), "auth"],
  [new FileNotFoundError("private"), "file_not_found"],
  [new SandboxNotFoundError("private"), "not_found"],
  [new RateLimitError("private"), "quota"],
  [new NotEnoughSpaceError("private"), "quota"],
  [new TimeoutError("private"), "timeout"],
  [new InvalidArgumentError("private"), "invalid_argument"],
  [new ServiceBusyError("private"), "unavailable"],
  [new DOMException("private", "AbortError"), "aborted"],
  [{ status: 503 }, "unavailable"],
  [new Error("private"), "provider"],
])(
  "maps native failure %# and keeps a cause without exposing recognized messages",
  (native, code) => {
    const error = e2bError(native, "box");
    expect(error).toMatchObject({ code, provider: "e2b", sandboxId: "box" });
    // Only an unrecognized local failure keeps its text; a recognized one keeps its name, a response its status.
    expect(error.cause).toBe(
      code === "provider" ? "Error: private" : native instanceof Error ? native.name : "HTTP 503",
    );

    if (code !== "provider") expect(error.message).not.toContain("private");
    expect(error.message).not.toMatch(/reported/);
  },
);

test("an HTTP failure keeps its status, never the response text", () => {
  const error = e2bError(
    Object.assign(new Error("Bearer e2b_secret body"), { status: 500 }),
    "box",
  );

  expect(error).toMatchObject({ code: "unavailable", cause: "Error HTTP 500" });
  expect(String(error.message) + String(error.cause)).not.toContain("e2b_secret");
});
