import { isStepCount, streamText, type LanguageModel } from "ai";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { sandboxTools } from "@opencoredev/sandbox-sdk/ai";

export const repoDir = "/workspace/repo";

const instructions = `You are a careful software engineer working in a Linux sandbox.
The repository is cloned at ${repoDir}; every path and command is relative to it.
Read the code before changing it. Make the smallest change that completes the task.
Run the project's tests or type checker when there is one, and fix what you broke.
Do not commit or push. When you are done, reply with a short summary of what you changed.`;

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "call"; tool: string; input: unknown }
  | { kind: "result"; tool: string; text: string }
  | { kind: "error"; tool: string; error: unknown };

/** sandboxTools results are `{ text }`; the stream types them as unknown. */
function resultText(output: unknown): string {
  return typeof output === "object" &&
    output !== null &&
    "text" in output &&
    typeof output.text === "string"
    ? output.text
    : JSON.stringify(output);
}

/** Runs one task to completion. The CLI and its --dry-run mode both go through here. */
export async function runAgent(options: {
  box: Sandbox;
  model: LanguageModel;
  task: string;
  maxSteps?: number;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  const result = streamText({
    model: options.model,
    instructions,
    prompt: options.task,
    tools: sandboxTools(options.box, { root: repoDir }),
    stopWhen: isStepCount(options.maxSteps ?? 40),
  });
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        options.onEvent({ kind: "text", text: part.text });
        break;
      case "tool-call":
        options.onEvent({ kind: "call", tool: part.toolName, input: part.input });
        break;
      case "tool-result":
        // Preliminary results carry live command output; the final one is the compact verdict.
        if (!part.preliminary)
          options.onEvent({ kind: "result", tool: part.toolName, text: resultText(part.output) });
        break;
      case "tool-error":
        options.onEvent({ kind: "error", tool: part.toolName, error: part.error });
        break;
      case "error":
        throw part.error;
    }
  }
}
