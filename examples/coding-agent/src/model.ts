import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export const defaultModel = "anthropic:claude-opus-5-5";

/**
 * Parses AI_MODEL as `<provider>:<model id>`.
 * anthropic and openai read ANTHROPIC_API_KEY / OPENAI_API_KEY.
 * gateway passes the id to the Vercel AI Gateway (AI_GATEWAY_API_KEY), e.g. `gateway:anthropic/claude-opus-5-5`.
 */
export function resolveModel(spec: string = process.env.AI_MODEL ?? defaultModel): LanguageModel {
  const separator = spec.indexOf(":");
  const provider = separator === -1 ? "" : spec.slice(0, separator);
  const id = spec.slice(separator + 1);
  if (!id) throw new Error(`AI_MODEL "${spec}" has no model id. Use <provider>:<model id>.`);
  switch (provider) {
    case "anthropic":
      return anthropic(id);
    case "openai":
      return openai(id);
    case "gateway":
      return id;
    default:
      throw new Error(
        `AI_MODEL provider "${provider}" is not supported. Use anthropic, openai, or gateway.`,
      );
  }
}
