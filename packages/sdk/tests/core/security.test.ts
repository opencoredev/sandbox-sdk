import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { defineCapabilities } from "../../src/core/capabilities";
import type { SandboxProvider } from "../../src/core/provider";
import { portResult, unsupportedSnapshots } from "../../src/internal/provider-utils";
import { memory } from "../../src/providers/memory";

test("sandbox paths reject .. and NUL", async () => {
  await using sandbox = await memory().create();
  await expect(sandbox.files.read("../secret")).rejects.toMatchObject({ code: "invalid_input" });
  await expect(sandbox.files.read("ok\0.txt")).rejects.toMatchObject({ code: "invalid_input" });
});

test("preview toJSON redacts query values", () => {
  const exposed = portResult(
    3000,
    "https://box.example/_/?_token=secret-token",
    true,
    false,
  );
  expect(JSON.stringify(exposed)).not.toContain("secret-token");
  expect(exposed.toJSON().url).toMatch(/REDACTED/);
});

test("await using calls stop, not destroy", async () => {
  let stops = 0;
  let destroys = 0;
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({}),
    async create() {
      return {
        id: "shared",
        raw: {},
        capabilities: defineCapabilities({}),
        files: {
          async write() {},
          async read() {
            return new Uint8Array();
          },
          async list() {
            return [];
          },
          async mkdir() {},
          async remove() {},
          async exists() {
            return false;
          },
        },
        async run() {
          return { stdout: "", stderr: "", exitCode: 0, success: true };
        },
        async start() {
          throw new Error("unused");
        },
        async expose() {
          throw new Error("unused");
        },
        snapshots: unsupportedSnapshots("local"),
        async stop() {
          stops += 1;
        },
        async destroy() {
          destroys += 1;
        },
      };
    },
  };
  {
    await using sandbox = await createSandbox({ provider });
    expect(sandbox.id).toBe("shared");
  }
  expect(stops).toBe(1);
  expect(destroys).toBe(0);
});
