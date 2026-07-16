import { expect, test } from "bun:test";
import { isSandboxError, redactSensitive, SandboxError } from "../../src";

test("redacts sensitive query values", () => {
  expect(redactSensitive("https://example.com/path?token=secret&x=1")).not.toContain("secret");
});

test("identifies normalized errors", () => {
  expect(
    isSandboxError(new SandboxError({ code: "internal", provider: "test", message: "failure" })),
  ).toBe(true);
  expect(isSandboxError(new Error("failure"))).toBe(false);
});
