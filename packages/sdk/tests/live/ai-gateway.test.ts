import { expect, test } from "bun:test";
import { gateway, ToolLoopAgent } from "ai";
import { createSandbox, type Sandbox } from "../../src";
import { createSandboxToolApproval, createSandboxTools, toAISandboxSession } from "../../src/ai";
import { local } from "../../src/providers/local";
import { vercel } from "../../src/providers/vercel";

const liveRequested = process.env.SANDBOX_SDK_LIVE_TESTS === "1";
const gatewayAuthenticated = liveRequested && Boolean(process.env.AI_GATEWAY_API_KEY);
const vercelAuthenticated = Boolean(
  process.env.VERCEL_OIDC_TOKEN ||
  (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID),
);

test.skipIf(!gatewayAuthenticated)(
  "AI Gateway agent executes real tools in a Local sandbox",
  async () => {
    const sandbox = await createSandbox({ provider: local() });
    try {
      await runGatewayAgent(sandbox);
    } finally {
      await sandbox.stop();
    }
  },
  120_000,
);

test.skipIf(!gatewayAuthenticated || !vercelAuthenticated)(
  "AI Gateway agent executes real tools in a Vercel sandbox",
  async () => {
    const sandbox = await createSandbox({
      provider: vercel(),
      timeout: 180_000,
    });
    try {
      await runGatewayAgent(sandbox);
    } finally {
      await sandbox.raw.delete();
    }
  },
  240_000,
);

async function runGatewayAgent(sandbox: Sandbox): Promise<void> {
  const marker = `gateway-agent-${crypto.randomUUID()}`;
  const agent = new ToolLoopAgent({
    model: gateway("anthropic/claude-sonnet-5"),
    instructions:
      "You are a sandbox verification agent. Follow the requested commands and paths exactly.",
    tools: createSandboxTools(),
    toolApproval: createSandboxToolApproval("never"),
    prepareStep: ({ stepNumber }) =>
      stepNumber === 0
        ? { toolChoice: { type: "tool", toolName: "bash" } }
        : stepNumber === 1
          ? { toolChoice: { type: "tool", toolName: "read_file" } }
          : { toolChoice: "none" },
  });

  const result = await agent.generate({
    prompt: `Use bash to execute exactly: printf '${marker}' > gateway-agent.txt
Then use read_file to read gateway-agent.txt. Finish by stating the exact file content.`,
    experimental_sandbox: toAISandboxSession(sandbox),
  });

  const toolNames = result.toolCalls.map((call) => call.toolName);
  expect(toolNames).toContain("bash");
  expect(toolNames).toContain("read_file");
  expect(await sandbox.files.text("gateway-agent.txt")).toBe(marker);
  expect(JSON.stringify(result.toolResults)).toContain(marker);
}
