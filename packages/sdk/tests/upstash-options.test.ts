import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { upstash } from "../src/providers/upstash/index.js";
import { createSandbox } from "../src/index.js";
import { cleanup, state } from "./upstash-mock.js";
vi.mock("@upstash/box", async () => {
  const mock = await import("./upstash-mock.js");
  return { Box: mock.MockBox, EphemeralBox: mock.MockEphemeralBox };
});
vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => {
  const fetch = globalThis.fetch;
  // Snapshot sizing reads the account snapshot list over HTTP.
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input) === "https://us-east-1.box.upstash.com/v2/box/snapshots"
      ? Promise.resolve(new Response(JSON.stringify({ snapshots: [...state.snapshotMetadata.values()] })))
      : fetch(input, init));
});
afterEach(async () => { vi.restoreAllMocks(); await cleanup(); });
const attachHeaders = { "api.example.com": { Authorization: "Bearer header-secret-1" } };

test("durable boxes pass keepAlive, browser and attachHeaders to Box.create", async () => {
  const box = await createSandbox(upstash({ apiKey: "mock-key", keepAlive: true, browser: true, attachHeaders }));
  try { expect(state.creates.at(-1)).toMatchObject({ keepAlive: true, browser: true, attachHeaders }); }
  finally { await box.destroy(); }
  const plain = await createSandbox(upstash({ apiKey: "mock-key" }));
  try { for (const field of ["keepAlive", "browser", "attachHeaders"]) expect(state.creates.at(-1)).not.toHaveProperty(field); }
  finally { await plain.destroy(); }
});
test("ephemeral boxes pass attachHeaders and never durable-only fields", async () => {
  const box = await createSandbox(upstash({ apiKey: "mock-key", ephemeral: true, attachHeaders }));
  try {
    const params = state.ephemeralCreates.at(-1);
    expect(params).toMatchObject({ attachHeaders });
    expect(params).not.toHaveProperty("keepAlive");
    expect(params).not.toHaveProperty("browser");
  } finally { await box.destroy(); }
});
test("snapshot expiry is unsupported, 0 keeps the snapshot", async () => {
  const provider = upstash({ apiKey: "mock-key" });
  expect(provider.files.writeSupportsMode).toBeUndefined();
  const box = await createSandbox(provider);
  try {
    await expect(box.snapshot({ expiresInMs: 86_400_000 })).rejects.toMatchObject({ code: "unsupported", provider: "upstash" });
    expect(state.snapshots.size).toBe(0);
    expect((await box.snapshot({ expiresInMs: 0 })).id).toEqual(expect.any(String));
  } finally { await box.destroy(); }
});
