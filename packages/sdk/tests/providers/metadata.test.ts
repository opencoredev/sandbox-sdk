import { expect, test } from "bun:test";
import { capabilityNames, providerNames } from "../../src";
import { providers } from "../../src/metadata";

test("metadata declares every supported provider", () => {
  expect(providers.map((provider) => provider.id)).toEqual([...providerNames]);
  for (const provider of providers) {
    for (const capability of capabilityNames)
      expect(provider.capabilities[capability]).toBeDefined();
    expect(provider.packageVersion).not.toBe("");
  }
});
