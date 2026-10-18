import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { z } from "zod";
import type { ToolName, toolSchemas } from "@opencoredev/sandbox-sdk/tools";

/** One tool call, typed against the SDK's own tool schemas. */
export type ScriptedCall = {
  [K in ToolName]: { tool: K; input: z.input<(typeof toolSchemas)[K]> };
}[ToolName];

/** One model turn: optional narration, then the tool calls the model "decides" to make. */
export interface ScriptedStep {
  say?: string;
  calls: readonly ScriptedCall[];
}

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/**
 * A fake language model that replays a fixed script, one step per model call, then
 * finishes with `summary`. The agent loop, tool validation and sandbox calls are real;
 * only the decisions are canned, so no API key is needed and nothing is billed.
 */
export function scriptedModel(steps: readonly ScriptedStep[], summary: string): LanguageModel {
  let call = 0;
  return new MockLanguageModelV4({
    provider: "scripted",
    modelId: "dry-run",
    doStream: async () => {
      const step = steps[call];
      const id = `step-${call++}`;
      const narration = step?.say ?? (step ? undefined : summary);
      const chunks = [
        { type: "stream-start" as const, warnings: [] },
        ...(narration
          ? [
              { type: "text-start" as const, id },
              { type: "text-delta" as const, id, delta: narration },
              { type: "text-end" as const, id },
            ]
          : []),
        ...(step?.calls ?? []).map((entry, index) => ({
          type: "tool-call" as const,
          toolCallId: `${id}-${index}`,
          toolName: entry.tool,
          input: JSON.stringify(entry.input),
        })),
        {
          type: "finish" as const,
          usage,
          finishReason: step
            ? { unified: "tool-calls" as const, raw: undefined }
            : { unified: "stop" as const, raw: undefined },
        },
      ];
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 20 }) };
    },
  });
}
