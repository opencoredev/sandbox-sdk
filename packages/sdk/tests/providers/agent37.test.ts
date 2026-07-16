import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { agent37 } from "../../src/providers/agent37";

const WORKSPACE = "/home/user/.agent37-gateway/workspace";
const files = new Map<string, Uint8Array<ArrayBuffer>>();
const requests: string[] = [];
const commands: string[] = [];
let sleeping = false;

const instance = {
  id: "agent37-test",
  status: "running",
  template: "agent37-hermes",
  resources: { cpu: 2, memory: 4, disk: 6 },
  url: "https://agent37-test.agent37.app",
  public_ports: [],
  name: null,
  user: null,
  metadata: null,
  auto_sleep: false,
  idle_timeout_seconds: 300,
  created: 1781222400,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runCommand(command: string) {
  commands.push(command);
  if (command.includes("sleep 2") && command.includes("timeout 1s "))
    return { exit_code: 124, stdout: "", stderr: "", truncated: false };
  if (command.includes("exit 7"))
    return { exit_code: 7, stdout: "out", stderr: "err", truncated: false };
  if (command.includes("node") && command.includes("--version"))
    return { exit_code: 0, stdout: "v24.0.0", stderr: "", truncated: false };
  return { exit_code: 0, stdout: "", stderr: "", truncated: false };
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  requests.push(`${method} ${url.host}${url.pathname}`);
  if (url.host === "api.agent37.com") {
    if (headers.get("authorization") !== "Bearer sk_live_test")
      return json({ error: { code: "invalid_api_key", message: "Missing key" } }, 401);
    if (method === "POST" && url.pathname === "/v1/instances") return json(instance);
    if (method === "POST" && url.pathname === `/v1/instances/${instance.id}/exec`) {
      if (sleeping)
        return json({ error: { code: "invalid_request", message: "Instance is sleeping" } }, 400);
      return json(runCommand((JSON.parse(init?.body as string) as { command: string }).command));
    }
    if (method === "DELETE" && url.pathname === `/v1/instances/${instance.id}`)
      return json({ ok: true });
  }
  if (url.host === "agent37-test.agent37.app") {
    if (!headers.has("x-agent37-key")) return json({ error: "invalid_api_key" }, 401);
    const path = url.searchParams.get("path");
    if (url.pathname === "/v1/health") {
      sleeping = false;
      return json({ ok: true });
    }
    if (url.pathname === "/v1/files" && method === "GET" && !path)
      return json({ path: WORKSPACE, parentPath: null, entries: [], truncated: false });
    if (url.pathname === "/v1/files/content" && method === "PUT") {
      files.set(path!, new Uint8Array(init?.body as Uint8Array));
      return json({ name: path!.split("/").at(-1), path, type: "file" });
    }
    if (url.pathname === "/v1/files/content" && method === "GET") {
      const content = files.get(path!);
      return content ? new Response(content) : json({ error: "file_not_found" }, 404);
    }
  }
  if (url.host === "agent37-test-8080.agent37.app")
    return json({ authenticated: new Headers(init?.headers).has("x-agent37-key") });
  return json({ error: "not_found" }, 404);
}

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = fakeFetch as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("Agent37 adapter", () => {
  test("maps REST operations onto the instance workspace", async () => {
    const sandbox = await createSandbox({ provider: agent37({ apiKey: "sk_live_test" }) });
    await sandbox.files.write("file.txt", "value");
    expect(await sandbox.files.text("file.txt")).toBe("value");
    expect(files.has(`${WORKSPACE}/file.txt`)).toBe(true);
    expect(await sandbox.run({ command: "node", args: ["--version"] })).toMatchObject({
      stdout: "v24.0.0",
      success: true,
    });
    expect(await sandbox.run("printf out; printf err >&2; exit 7")).toMatchObject({
      stdout: "out",
      stderr: "err",
      exitCode: 7,
      success: false,
    });
    await sandbox.run("true", { env: { FOO: "bar" }, cwd: "sub" });
    expect(commands.at(-1)).toBe(`cd '${WORKSPACE}/sub' && env 'FOO=bar' sh -c 'true'`);
    const port = await sandbox.ports.expose(8080);
    expect(port).toMatchObject({
      port: 8080,
      url: "https://agent37-test-8080.agent37.app",
      public: false,
      authenticated: true,
    });
    expect(await (await port.request!("/")).json()).toEqual({ authenticated: true });
    await sandbox.stop();
    expect(sandbox.raw.instance.id).toBe("agent37-test");
    expect(requests).toContain(`DELETE api.agent37.com/v1/instances/${instance.id}`);
  });

  test("normalizes shell timeout exit 124", async () => {
    const sandbox = await createSandbox({ provider: agent37({ apiKey: "sk_live_test" }) });
    await expect(sandbox.run("sleep 2", { timeout: 20 })).rejects.toMatchObject({
      code: "timeout",
      provider: "agent37",
      operation: "process.run",
    });
    expect(commands.at(-1)).toContain("timeout 1s sh -c 'sleep 2'");
    await sandbox.stop();
  });

  test("wakes a sleeping instance before running commands", async () => {
    const sandbox = await createSandbox({ provider: agent37({ apiKey: "sk_live_test" }) });
    sleeping = true;
    expect(await sandbox.run({ command: "node", args: ["--version"] })).toMatchObject({
      stdout: "v24.0.0",
      success: true,
    });
    expect(sleeping).toBe(false);
    expect(requests.at(-2)).toBe("GET agent37-test.agent37.app/v1/health");
    await sandbox.stop();
  });

  test("requires an API key", async () => {
    const saved = process.env.AGENT37_API_KEY;
    delete process.env.AGENT37_API_KEY;
    try {
      await expect(createSandbox({ provider: agent37() })).rejects.toMatchObject({
        code: "authentication",
        provider: "agent37",
        operation: "sandbox.create",
      });
    } finally {
      if (saved !== undefined) process.env.AGENT37_API_KEY = saved;
    }
  });

  test("reports unsupported snapshots", async () => {
    const sandbox = await createSandbox({ provider: agent37({ apiKey: "sk_live_test" }) });
    await expect(sandbox.snapshots.create()).rejects.toMatchObject({
      code: "unsupported",
      provider: "agent37",
    });
    expect(sandbox.capabilities["snapshot.create"]).toBe(false);
    await sandbox.stop();
  });
});
