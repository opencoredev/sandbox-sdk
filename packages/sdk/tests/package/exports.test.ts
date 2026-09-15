import { expect, test } from "bun:test";
import { exists } from "node:fs/promises";
import packageJson from "../../package.json";

test("every public export points to built JavaScript and declarations", async () => {
  for (const value of Object.values(packageJson.exports)) {
    expect(await exists(new URL(`../../${value.import}`, import.meta.url))).toBe(true);
    expect(await exists(new URL(`../../${value.types}`, import.meta.url))).toBe(true);
  }
});

test("core and self-hosted built entries import independently", async () => {
  const coreEntry = "../../dist/index.mjs";
  const localEntry = "../../dist/providers/local/index.mjs";
  const agentosEntry = "../../dist/providers/agentos/index.mjs";
  expect(await import(coreEntry)).toHaveProperty("createSandbox");
  expect(await import(localEntry)).toHaveProperty("local");
  expect(await import(agentosEntry)).toHaveProperty("agentos");
});

test("Box built entry imports independently", async () => {
  const boxEntry = "../../dist/providers/box/index.mjs";
  expect(await import(boxEntry)).toHaveProperty("box");
});

test("Tenki built entry imports independently", async () => {
  const tenkiEntry = "../../dist/providers/tenki/index.mjs";
  expect(await import(tenkiEntry)).toHaveProperty("tenki");
});

test("experimental integration entries import independently", async () => {
  const aiEntry = "../../dist/ai/index.mjs";
  const harnessEntry = "../../dist/ai/harness.mjs";
  const eveEntry = "../../dist/eve/index.mjs";
  const mastraEntry = "../../dist/mastra/index.mjs";
  expect(await import(aiEntry)).toHaveProperty("toAISandboxSession");
  expect(await import(aiEntry)).toHaveProperty("createSandboxToolApproval");
  expect(await import(harnessEntry)).toHaveProperty("createSandboxHarnessProvider");
  expect(await import(eveEntry)).toHaveProperty("createEveSandboxBackend");
  expect(await import(mastraEntry)).toHaveProperty("createMastraWorkspace");
  expect(await import(mastraEntry)).toHaveProperty("createMastraSandbox");
});
