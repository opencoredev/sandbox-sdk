import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Sandbox } from "./types.js";
import { createSandboxTools, type SandboxToolsOptions, type ToolEvent } from "./tools.js";
import { version } from "./version.js";
import type { JsonValue } from "./shared/json.js";

export type { SandboxToolsOptions } from "./tools.js";

export interface SandboxMcpOptions extends SandboxToolsOptions {
  /** Server name reported to MCP clients. Default: `"sandbox"`. */
  name?: string;
}

/** Most output text held while the client is still reading the previous notification. */
const maxPendingProgress = 64 * 1024;

/**
 * Stream tool output to an MCP client as progress notifications. Returns `undefined` when the call
 * carries no progress token. One notification is in flight at a time: output that arrives meanwhile
 * is combined into the next one, and a client that falls behind loses the oldest text rather than
 * growing a backlog. The tool result still carries the capped output.
 */
export function progressEmitter(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ((event: ToolEvent) => void) | undefined {
  const progressToken = extra._meta?.progressToken;

  if (progressToken === undefined) return undefined;
  let progress = 0;
  let pending = "";
  let sending = false;

  const flush = () => {
    const message = pending;

    pending = "";
    sending = true;
    progress += 1;
    // A client that stopped listening must not fail the command.
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message },
      })
      .catch(() => {})
      .finally(() => {
        sending = false;

        if (pending) flush();
      });
  };

  return (event) => {
    pending = (pending + event.text).slice(-maxPendingProgress);

    if (!sending) flush();
  };
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
        const result = await definition.execute(input, progressEmitter(extra), extra.signal);

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
