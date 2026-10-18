import { test, expect } from "vitest";
import { AuthenticationError, FileNotFoundError, SandboxNotFoundError, RateLimitError, TimeoutError, InvalidArgumentError, ServiceBusyError, NotEnoughSpaceError } from "e2b";
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
])("maps native failure %# without exposing messages", (native, code) => {
  const error = e2bError(native, "box");
  expect(error).toMatchObject({ code, provider: "e2b", sandboxId: "box" });
  expect(error.message).not.toContain("private"); expect(error.cause).toBeUndefined();
});
