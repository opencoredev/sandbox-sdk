import { describe, expect, test, vi } from "vitest";
import { createSandbox } from "../src/index.js";
import { daytona } from "../src/providers/daytona/index.js";
import { daytonaHttp } from "../src/providers/daytona/api.js";
import { execute } from "../src/providers/daytona/exec.js";
import { runConformance } from "../src/testing.js";
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const toolbox = (id: string) => daytonaHttp({
  baseUrl: () => process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api", credentials: () => ({ apiKey: process.env.DAYTONA_API_KEY }), requestTimeoutMs: 30_000, secrets: () => [],
}).toolbox(id);
// The whole suite, including Git and HTTP, runs only with explicit credentials.
describe.skipIf(!process.env.DAYTONA_API_KEY)("Daytona live", () => {
  runConformance(() => {
    const provider = daytona();
    const create = provider.create;
    provider.create = input => create({ ...input, labels: { ...input.labels, "sbx57-create-a-live": "1", "daytona-live-suite": process.env.DAYTONA_BUFFERED_TEST === "1" ? "buffered" : "session" } });
    if (process.env.DAYTONA_BUFFERED_TEST === "1") provider.exec = (id, input) => execute(toolbox(id), { ...input, streaming: false });
    return provider;
  }, { live: true });

  test("native request, fetch, provider.api and sdk(load) against the real service", async () => {
    const provider = daytona();
    await using box = await createSandbox(provider, { labels: { "daytona-live-suite": "native" } });
    expect(await box.native.request<{ id: string; state: string }>("GET", "/sandbox/{sandboxId}")).toMatchObject({ id: box.id, state: "started" });
    await box.files.write("native.bin", new Uint8Array([0, 1, 2, 255]));
    const files = await box.native.request<{ name: string }[]>("GET", "/files", { plane: "toolbox", query: { path: "/workspace" } });
    expect(files.map(file => file.name)).toContain("native.bin");
    const response = await box.native.fetch("POST", "/files/bulk-download", { plane: "toolbox", body: { paths: ["/workspace/native.bin"] } });
    expect(response.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(new Uint8Array(await response.arrayBuffer()).length).toBeGreaterThan(4);
    const listed = await provider.api.request<{ items: { id: string }[] }>("GET", "/sandbox", { query: { labels: JSON.stringify({ "daytona-live-suite": "native" }) } });
    expect(listed.items.map(item => item.id)).toContain(box.id);
    const sandbox = await box.native.sdk(() => import("@daytonaio/sdk"));
    expect(sandbox.id).toBe(box.id);
    expect((await sandbox.process.executeCommand("echo from-sdk")).result.trim()).toBe("from-sdk");
    const client = await provider.api.sdk(() => import("@daytonaio/sdk"));
    expect((await client.get(box.id)).id).toBe(box.id);
  });
});
