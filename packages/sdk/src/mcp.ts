import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Sandbox } from "./types.js";
import { createSandboxTools, type SandboxToolsOptions } from "./tools.js";
import { version } from "./version.js";
import type { JsonValue } from "./shared/json.js";

export type { SandboxToolsOptions } from "./tools.js";

export interface SandboxMcpOptions extends SandboxToolsOptions {
  /** Server name reported to MCP clients. Default: `"sandbox"`. */
  name?: string;
}

/**
 * Register the sandbox tools on an MCP server you already have. Output streams to the client as
 * progress notifications when the call carries a progress token; a `FAILED` result sets `isError`.
 */
export function registerSandboxTools(
  server: McpServer,
  box: Sandbox,
  options?: SandboxToolsOptions,
): void {
  for (const definition of createSandboxTools(box, options)) {
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: definition.inputSchema },
      async (input: JsonValue, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        const progressToken = extra._meta?.progressToken;
        let progress = 0;

        const emit =
          progressToken === undefined
            ? undefined
            : (event: { text: string }) => {
                // A client that stopped listening must not fail the command.
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: ++progress, message: event.text },
                  })
                  .catch(() => {});
              };

        const result = await definition.execute(input, emit, extra.signal);

        return {
          content: [{ type: "text" as const, text: result.text }],
          isError: result.text.startsWith("FAILED"),
        };
      },
    );
  }
}

/** An MCP server exposing one sandbox. Connect it to any MCP transport. */
export function sandboxMcpServer(box: Sandbox, options: SandboxMcpOptions = {}): McpServer {
  const server = new McpServer({ name: options.name ?? "sandbox", version });
  registerSandboxTools(server, box, options);

  return server;
}
