import { stat } from "node:fs/promises";
import { afterAll, expect, test, vi } from "vitest";
const mock = await vi.hoisted(async () => import("./railway-mock.js"));
vi.mock("railway", async importOriginal => ({ ...await importOriginal<typeof import("railway")>(), Sandbox: mock.MockSandbox }));
import { railway } from "../src/providers/railway/index.js";
import { createSandbox } from "../src/index.js";
const options = { token: "mock", environmentId: "mock-env" };
vi.stubGlobal("fetch", mock.mockFetch(globalThis.fetch));
afterAll(async () => { await mock.cleanup(); vi.unstubAllGlobals(); });

test("resources reach Sandbox.create in Railway's units", async () => {
  const box = await createSandbox(railway({ ...options, resources: { cpu: 0.5, memoryGB: 2 } }));
  try { expect(mock.state.creates.at(-1)).toMatchObject({ resources: { cpu: 0.5, memoryGB: 2 } }); }
  finally { await box.destroy(); }
  const plain = await createSandbox(railway(options));
  try { expect(mock.state.creates.at(-1)).not.toHaveProperty("resources"); }
  finally { await plain.destroy(); }
});
test("write mode goes to the native file write", async () => {
  const box = await createSandbox(railway(options));
  try {
    if (!(box.native instanceof mock.MockSandbox)) throw new Error("Expected the Railway mock");
    await box.files.write("secret.txt", "a", { mode: 0o600 });
    expect(mock.state.writes.at(-1)).toEqual({ path: "/workspace/secret.txt", options: { mode: 0o600 } });
    expect((await stat(box.native.map("/workspace/secret.txt"))).mode & 0o7777).toBe(0o600);
    await box.files.write("plain.txt", "b");
    expect(mock.state.writes.at(-1)).toEqual({ path: "/workspace/plain.txt", options: undefined });
  } finally { await box.destroy(); }
});
test("checkpoint expiry is unsupported, 0 keeps the checkpoint", async () => {
  const box = await createSandbox(railway(options));
  try {
    const before = mock.state.snapshots.size;
    await expect(box.snapshot({ expiresInMs: 60_000 })).rejects.toMatchObject({ code: "unsupported", provider: "railway" });
    expect(mock.state.snapshots.size).toBe(before);
    expect((await box.snapshot({ expiresInMs: 0 })).id).toMatch(/^sandbox-sdk-/);
  } finally { await box.destroy(); }
});
