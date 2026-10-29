import type { ToolSet } from "ai";
import { Agent as MastraAgent } from "@mastra/core/agent";
import { Agent as OpenAIAgent } from "@openai/agents";
import type { Sandbox } from "../src/types.js";
import { sandboxTools as ai } from "../src/ai.js";
import { sandboxTools as mastra } from "../src/mastra.js";
import { sandboxTools as openai } from "../src/openai.js";

// Compiled, never executed: framework constructors must accept the native return values.
export function checkFrameworkTypes(box: Sandbox) {
  const tools: ToolSet = ai(box);

  const m = new MastraAgent({
    id: "sandbox",
    name: "sandbox",
    instructions: "Use the sandbox",
    model: "openai/gpt-4.1",
    tools: mastra(box),
  });

  const o = new OpenAIAgent({ name: "sandbox", tools: openai(box) });

  return { tools, m, o };
}
