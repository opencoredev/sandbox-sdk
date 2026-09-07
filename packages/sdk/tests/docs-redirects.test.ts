import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("docs redirects cover the Sandbox 2 ramp aliases", async () => {
  const raw = await readFile("../../apps/fumadocs/vercel.json", "utf8");
  const config = JSON.parse(raw) as {
    redirects: { source: string; destination: string; permanent: boolean }[];
  };
  const map = Object.fromEntries(config.redirects.map((row) => [row.source, row.destination]));
  expect(map["/"]).toBe("/docs");
  expect(map["/docs/quickstart"]).toBe("/docs/get-started/first-sandbox");
  expect(map["/docs/install"]).toBe("/docs/get-started/install");
  expect(map["/docs/compare"]).toBe("/docs/get-started/compare");
  expect(map["/docs/cli"]).toBe("/docs/guides/cli");
  expect(map["/docs/hooks"]).toBe("/docs/api/hooks");
  expect(map["/docs/providers/agentos"]).toBe("/docs/guides/migrate-agentos");
  expect(map["/docs/agent-skill"]).toBe("/docs/integrations/skill");
  expect(map["/docs/agents"]).toBe("/docs/integrations");
  expect(map["/docs/agents/ai-sdk"]).toBe("/docs/integrations/ai-sdk");
  expect(map["/docs/agents/harness"]).toBe("/docs/integrations/ai-sdk-harness");
  expect(map["/docs/agents/skill"]).toBe("/docs/integrations/skill");
  expect(map["/docs/agents/eve"]).toBe("/docs/integrations/eve");
  expect(map["/docs/agents/mastra"]).toBe("/docs/integrations/mastra");
  expect(config.redirects.every((row) => row.permanent)).toBe(true);
});
