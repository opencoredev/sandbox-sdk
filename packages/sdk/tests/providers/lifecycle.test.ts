import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { builtInProviderNames, type BuiltInProviderName } from "../../src";
import { adapterLifecycle } from "../../src/providers/lifecycle";

const sources: Record<BuiltInProviderName, string> = {
  e2b: "src/providers/e2b/index.ts",
  daytona: "src/providers/daytona/index.ts",
  vercel: "src/providers/vercel/index.ts",
  upstash: "src/providers/upstash/index.ts",
  box: "src/providers/box/index.ts",
  railway: "src/providers/railway/index.ts",
  cloudflare: "src/providers/cloudflare/index.ts",
  memory: "src/providers/memory/index.ts",
  local: "src/providers/agentos/index.ts",
};

test("every built-in adapter declares stop vs destroy and create abort", async () => {
  expect(Object.keys(adapterLifecycle).sort()).toEqual([...builtInProviderNames].sort());
  for (const id of builtInProviderNames) {
    expect(adapterLifecycle[id].createSignal).toBe(true);
    const source = await readFile(sources[id], "utf8");
    expect(source).toContain("async destroy");
    expect(source).toContain("async stop");
    expect(source.includes("assertNotAborted") || source.includes("createOptions.signal")).toBe(
      true,
    );
  }
});
