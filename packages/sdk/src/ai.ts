import type { z } from "zod";
import { tool, type Tool } from "ai";
import type { Sandbox } from "./types.js";
import {
  createSandboxTools,
  type SandboxToolsOptions,
  type ToolResult,
  type ToolParameters,
} from "./tools.js";
import { OutputBus } from "./run.js";
export type { SandboxToolsOptions } from "./tools.js";

export function sandboxTools(
  box: Sandbox,
  options?: SandboxToolsOptions,
): Record<string, Tool<ToolParameters, ToolResult, Record<string, never>>> {
  return Object.fromEntries(
    createSandboxTools(box, options).map((definition) => [
      definition.name,
      tool<z.infer<typeof definition.inputSchema>, ToolResult, Record<string, never>>({
        description: definition.description,
        inputSchema: definition.inputSchema,
        async *execute(input, execution): AsyncGenerator<ToolResult> {
          const controller = new AbortController();
          const signal = execution.abortSignal
            ? AbortSignal.any([controller.signal, execution.abortSignal])
            : controller.signal;
          const bus = new OutputBus();
          const stream = bus.stream();
          // Subscribe before starting execution so synchronous producers cannot lose events.
          let next = stream.next();
          const final = definition
            .execute(input, (event) => bus.emit({ stream: event.stream, text: event.text }), signal)
            .finally(() => bus.end());
          try {
            while (true) {
              const event = await next;
              if (event.done) break;
              yield { text: event.value.text };
              next = stream.next();
            }
            yield await final;
          } finally {
            controller.abort();
            await final;
            await stream.return(undefined);
          }
        },
        toModelOutput: ({ output }) => ({ type: "text", value: output.text }),
      }),
    ]),
  );
}
