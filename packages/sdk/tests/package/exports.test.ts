import { expect, test } from "bun:test";
import { exists, readFile } from "node:fs/promises";
import packageJson from "../../package.json";

test("every public export points to built JavaScript and declarations", async () => {
  for (const value of Object.values(packageJson.exports)) {
    expect(await exists(new URL(`../../${value.import}`, import.meta.url))).toBe(true);
    expect(await exists(new URL(`../../${value.types}`, import.meta.url))).toBe(true);
  }
});

test("packed README names the shipped Memory and Cloudflare adapters", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  expect(readme).toContain("docs/providers/memory");
  expect(readme).toContain("docs/providers/cloudflare");
});

test("core and self-hosted built entries import independently", async () => {
  const coreEntry = "../../dist/index.mjs";
  const localEntry = "../../dist/providers/local/index.mjs";
  const agentosEntry = "../../dist/providers/agentos/index.mjs";
  expect(await import(coreEntry)).toHaveProperty("createSandbox");
  expect(await import(localEntry)).toHaveProperty("local");
  expect(await import(agentosEntry)).toHaveProperty("agentos");
});

test("provider built entries import independently", async () => {
  const boxEntry = "../../dist/providers/box/index.mjs";
  const cloudflareEntry = "../../dist/providers/cloudflare/index.mjs";
  const memoryEntry = "../../dist/providers/memory/index.mjs";
  expect(await import(boxEntry)).toHaveProperty("box");
  expect(await import(cloudflareEntry)).toHaveProperty("cloudflare");
  expect(await import(memoryEntry)).toHaveProperty("memory");
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
