import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../src/index.js";
import { memory } from "../src/memory.js";
import { sandboxMcpServer } from "../src/mcp.js";

/** The text of a tool result, as a model would read it. */
function textOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = Array.isArray(result.content) ? result.content : [];

  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("sandbox MCP server", () => {
  it("lists the selected tools and runs them over an MCP transport", async () => {
    await using box = await createSandbox(memory());
    const server = sandboxMcpServer(box, { allow: ["write_file", "read_file", "run"] });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["read_file", "run", "write_file"]);
    expect(tools.find((tool) => tool.name === "run")?.inputSchema.required).toEqual(["command"]);

    const written = await client.callTool({
      name: "write_file",
      arguments: { path: "a.txt", content: "hello" },
    });

    expect(textOf(written)).toMatch(/^OK/);
    expect(await box.files.read("a.txt")).toBe("hello");

    const read = await client.callTool({ name: "read_file", arguments: { path: "a.txt" } });
    expect(textOf(read)).toContain("1: hello");
    expect(read.isError).toBe(false);

    const failed = await client.callTool({ name: "run", arguments: { command: "exit 7" } });
    expect(textOf(failed)).toMatch(/^FAILED exit=7/);
    expect(failed.isError).toBe(true);

    await client.close();
  });
});
