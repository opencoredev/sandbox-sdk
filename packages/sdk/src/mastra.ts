import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Sandbox } from "./types.js";
import { createSandboxTools, type SandboxToolsOptions } from "./tools.js";
export type { SandboxToolsOptions } from "./tools.js";
export function sandboxTools(box: Sandbox, options?: SandboxToolsOptions) {
  return Object.fromEntries(
    createSandboxTools(box, options).map((definition) => [
      definition.name,
      createTool({
        id: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: z.object({ text: z.string() }),
        execute: (input, context) => definition.execute(input, undefined, context?.abortSignal),
        toModelOutput: (output) => ({ type: "text", value: output.text }),
      }),
    ]),
  );
}
