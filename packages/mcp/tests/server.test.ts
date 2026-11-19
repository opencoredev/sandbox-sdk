import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { listSandboxes } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { JsonObject, Provider } from "@opencoredev/sandbox-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  createSandboxMcpServer,
  providerName,
  providersFromEnv,
  type SandboxMcpServerOptions,
} from "../src/index.js";

async function connect(shared: Provider = memory(), tools?: SandboxMcpServerOptions["tools"]) {
  const server = createSandboxMcpServer({ providers: new Map([["memory", () => shared]]), tools });
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
    expect(providerName(" Docker ")).toBe("local");
  });

  it("offers a provider only when a whole credential group is set", () => {
    expect([...providersFromEnv({ VERCEL_TOKEN: "t", RAILWAY_API_TOKEN: "t" }).keys()]).toEqual([
      "local",
    ]);
    expect([
      ...providersFromEnv({
        VERCEL_OIDC_TOKEN: "t",
        DAYTONA_JWT_TOKEN: "t",
        DAYTONA_ORGANIZATION_ID: "o",
      }).keys(),
    ]).toEqual(["vercel", "daytona", "local"]);
  });

  it("refuses provider names its own references could not carry", () => {
    expect(() =>
      createSandboxMcpServer({ providers: new Map([["team_e2b", () => memory()]]) }),
    ).toThrow(/Rename: team_e2b/);
  });

  it("destroys a sandbox that arrives after its creation was cancelled", async () => {
    const inner = memory();
    let release = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow: Provider = {
      ...inner,
      create: async (options) => {
        await gate;

        return inner.create(options);
      },
    };

    const { client } = await connect(slow);
    const cancel = new AbortController();

    const pending = client.callTool({ name: "create_sandbox", arguments: {} }, undefined, {
      signal: cancel.signal,
    });

    cancel.abort();
    await expect(pending).rejects.toThrow();
    release();
    await expect.poll(() => listSandboxes(inner)).toEqual([]);
    await client.close();
  });

  it("keeps saved output when the same key is created again", async () => {
    const { client, call } = await connect(memory(), { limits: { run: { maxOutputBytes: 256 } } });
    const ref = /sandbox=(\S+)/.exec((await call("create_sandbox", { key: "demo" })).text)?.[1];
    const long = await call("run", { sandbox: ref, command: `echo ${"x".repeat(900)}` });
    const name = /name=(run_\w+)/.exec(long.text)?.[1];
    expect(name).toBeDefined();

    expect((await call("create_sandbox", { key: "demo" })).text).toContain(`sandbox=${ref}`);
    const replayed = await call("process_logs", { sandbox: ref, name, cursor: "0" });
    expect(replayed.text).toMatch(/^OK/);
    expect(replayed.text).toContain("xxxx");
    await client.close();
  });

  it("shares one tool set between parallel first calls", async () => {
    const shared = memory();
    const first = await connect(shared, { limits: { run: { maxOutputBytes: 256 } } });
    const ref = /sandbox=(\S+)/.exec((await first.call("create_sandbox")).text)?.[1];
    await first.client.close();

    // A fresh server has no cached handle, so both calls race to open the sandbox.
    const { client, call } = await connect(shared, { limits: { run: { maxOutputBytes: 256 } } });

    const [long] = await Promise.all([
      call("run", { sandbox: ref, command: `echo ${"y".repeat(900)}` }),
      call("run", { sandbox: ref, command: "pwd" }),
    ]);

    const name = /name=(run_\w+)/.exec(long.text)?.[1];
    expect(name).toBeDefined();
    expect((await call("process_logs", { sandbox: ref, name, cursor: "0" })).text).toMatch(/^OK/);
    await client.close();
  });

  it("streams command output as progress when the call asks for it", async () => {
    const { client, call } = await connect();
    const ref = /sandbox=(\S+)/.exec((await call("create_sandbox")).text)?.[1];
    const seen: string[] = [];

    await client.callTool(
      { name: "run", arguments: { sandbox: ref, command: "echo streamed" } },
      undefined,
      { onprogress: (progress) => seen.push(progress.message ?? "") },
    );

    expect(seen.join("")).toContain("streamed");
    await client.close();
  });
});
