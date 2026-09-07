import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { capabilityNames, providerNames, SandboxError } from "../../src";
import { getProviderMetadata, providers } from "../../src/metadata";

test("metadata declares every supported provider", () => {
  expect(providers.map((provider) => provider.id)).toEqual([...providerNames]);
  for (const provider of providers) {
    for (const capability of capabilityNames)
      expect(provider.capabilities[capability]).toBeDefined();
    expect(provider.packageVersion).not.toBe("");
    expect(provider.liveTest).toBeNull();
  }
  expect(providers.find((provider) => provider.id === "railway")?.technicalStatus).toBe(
    "experimental",
  );
  const cloudflare = providers.find((provider) => provider.id === "cloudflare");
  expect(cloudflare?.technicalStatus).toBe("experimental");
  expect(cloudflare?.packageVersion).toBe("user-supplied");
});

test("unknown provider metadata fails with a normalized error", () => {
  expect(() => getProviderMetadata("unknown-community-adapter")).toThrow(SandboxError);
  try {
    getProviderMetadata("unknown-community-adapter");
  } catch (error) {
    expect(error).toMatchObject({ code: "not_found", operation: "metadata.get" });
  }
});

test("live-test docs repeat every metadata row as null", async () => {
  const page = await readFile("../../apps/fumadocs/content/docs/reference/live-tests.mdx", "utf8");
  for (const provider of providers) {
    expect(page).toContain(`| ${provider.id} | \`null\` |`);
  }
});
