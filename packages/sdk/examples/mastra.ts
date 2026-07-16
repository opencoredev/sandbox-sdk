import { Agent } from "@mastra/core/agent";
import { createMastraWorkspace } from "../src/mastra";
import { local } from "../src/providers/local";

const workspace = createMastraWorkspace({ provider: local() });

const agent = new Agent({
  id: "sandbox-agent",
  name: "Sandbox agent",
  model: "openai/gpt-5-mini",
  instructions: "Work only in the attached workspace and verify your changes.",
  workspace,
});

try {
  const result = await agent.generate("Create hello.js, run it, and report the output.");
  console.log(result.text);
} finally {
  await workspace.destroy();
}
