import { describe, expect, test } from "bun:test";
import { capabilityMode, requireCapability, SandboxError, supports } from "../../src";
import { localCapabilities } from "../../src/providers/local";

describe("capabilities", () => {
  const sandbox = { provider: "local" as const, capabilities: localCapabilities };
  test("reports support and modes", () => {
    expect(supports(sandbox, "files.read")).toBe(true);
    expect(capabilityMode(sandbox, "files.read")).toBe("full");
    expect(supports(sandbox, "compute.gpu")).toBe(false);
  });
  test("throws a normalized unsupported error", () => {
    expect(() => requireCapability(sandbox, "compute.gpu")).toThrow(SandboxError);
    try {
      requireCapability(sandbox, "compute.gpu");
    } catch (error) {
      expect((error as SandboxError).code).toBe("unsupported");
    }
  });
});
