import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { providers } from "../../src/metadata";

test("every metadata adapter has source, docs, example, and unit test", () => {
  for (const provider of providers) {
    const id = provider.id;
    expect(existsSync(`src/providers/${id}/index.ts`)).toBe(true);
    expect(existsSync(`../../apps/fumadocs/content/docs/providers/${id}.mdx`)).toBe(true);
    expect(existsSync(`examples/${id}.ts`) || existsSync(`examples/${id}-command.ts`)).toBe(true);
    expect(
      existsSync(`tests/providers/${id}.test.ts`) || existsSync(`tests/providers/${id}-conformance.test.ts`),
    ).toBe(true);
    expect(provider.liveTest).toBeNull();
  }
});

test("authoring kit files exist", () => {
  expect(existsSync("src/providers/_template/README.md")).toBe(true);
  expect(existsSync("src/providers/_template/index.ts")).toBe(true);
  expect(existsSync("src/providers/_template/docs.mdx")).toBe(true);
});
