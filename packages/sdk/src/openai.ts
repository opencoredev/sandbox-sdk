import { tool } from "@openai/agents";
import type { Sandbox } from "./types.js";
import { createSandboxTools, type SandboxToolsOptions } from "./tools.js";

export type { SandboxToolsOptions } from "./tools.js";

export function sandboxTools(box: Sandbox, options?: SandboxToolsOptions) {
  return createSandboxTools(box, options).map((definition) =>
    tool({
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
      strict: true,
      execute: async (input, _context, details) =>
        (await definition.execute(input, undefined, details?.signal)).text,
    }),
  );
}
