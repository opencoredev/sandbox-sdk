import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { JsonObject } from "@opencoredev/sandbox-sdk/provider";
import { describe, expect, it } from "vitest";
import { createSandboxMcpServer, providersFromEnv } from "../src/index.js";

async function connect() {
  const shared = memory();
  const server = createSandboxMcpServer({ providers: new Map([["memory", () => shared]]) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const call = async (name: string, args: JsonObject = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];

    return {
      text: content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      isError: result.isError === true,
    };
  };

  return { client, call };
}

describe("sandbox-mcp server", () => {
  it("creates a sandbox, works in it by reference, and destroys it", async () => {
    const { client, call } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["list_providers", "create_sandbox", "run", "destroy_sandbox"]),
    );
    expect(tools.find((tool) => tool.name === "run")?.inputSchema.required).toEqual(
      expect.arrayContaining(["sandbox", "command"]),
    );
    expect((await call("list_providers")).text).toContain("memory (default)");

    const created = await call("create_sandbox", { key: "demo" });
    const ref = /sandbox=(\S+)/.exec(created.text)?.[1] ?? "";
    expect(ref).toMatch(/^memory:/);
    expect((await call("create_sandbox", { key: "demo" })).text).toContain("created=false");

    expect(
      (await call("write_file", { sandbox: ref, path: "a.txt", content: "hello" })).text,
    ).toMatch(/^OK/);
    expect((await call("read_file", { sandbox: ref, path: "a.txt" })).text).toContain("1: hello");
    expect((await call("list_sandboxes")).text).toContain(`sandbox=${ref} state=running key=demo`);

    const failed = await call("run", { sandbox: ref, command: "exit 7" });
    expect(failed.text).toMatch(/^FAILED exit=7/);
    expect(failed.isError).toBe(true);

    expect((await call("pause_sandbox", { sandbox: ref })).text).toMatch(/^FAILED/);
    expect((await call("destroy_sandbox", { sandbox: ref })).text).toContain("destroyed");
    expect((await call("list_sandboxes")).text).toContain("No sandboxes");
    expect((await call("run", { sandbox: ref, command: "pwd" })).isError).toBe(true);
    await client.close();
  });

  it("reports an unknown provider as a result, not a protocol error", async () => {
    const { client, call } = await connect();
    const result = await call("create_sandbox", { provider: "nope" });
    expect(result.text).toContain('Unknown provider "nope"');
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("picks providers from credentials, then local, unless SANDBOX_PROVIDERS names them", () => {
    expect([...providersFromEnv({}).keys()]).toEqual(["local"]);
    expect([...providersFromEnv({ E2B_API_KEY: "k", TENKI_API_KEY: "k" }).keys()]).toEqual([
      "e2b",
      "luxor",
      "local",
    ]);
    expect([...providersFromEnv({ SANDBOX_PROVIDERS: "tenki, docker" }).keys()]).toEqual([
      "luxor",
      "local",
    ]);
    expect(() => providersFromEnv({ SANDBOX_PROVIDERS: "nope" })).toThrow(/Unknown provider/);
  });
});
