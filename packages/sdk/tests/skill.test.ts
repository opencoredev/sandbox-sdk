import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("installable skill teaches Sandbox 2 and invents no hosted endpoints", async () => {
  const skill = await readFile("../../skills/sandbox-sdk/SKILL.md", "utf8");
  expect(skill).toContain("e2b().create()");
  expect(skill).toContain("memory()");
  expect(skill.toLowerCase()).not.toContain("mcp endpoint");
  expect(skill).not.toContain("createSandbox({ provider: local() })");
});
