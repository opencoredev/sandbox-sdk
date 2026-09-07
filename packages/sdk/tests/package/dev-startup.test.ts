import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("SDK watch does not delete dist while the docs app starts", () => {
  const sdk = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: { dev: string };
  };
  const turbo = JSON.parse(readFileSync(new URL("../../../../turbo.json", import.meta.url), "utf8")) as {
    tasks: { dev: { dependsOn?: string[] } };
  };

  expect(sdk.scripts.dev).toBe("tsdown --no-clean --watch src");
  expect(turbo.tasks.dev.dependsOn).toContain("^build");
});
