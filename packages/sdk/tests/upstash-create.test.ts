import { afterEach, expect, test, vi } from "vitest";
import { upstash } from "../src/providers/upstash/index.js";
import { createSandbox } from "../src/index.js";
import { cleanup, state } from "./upstash-mock.js";
vi.mock("@upstash/box", async () => {
  const mock = await import("./upstash-mock.js");
  return { Box: mock.MockBox, EphemeralBox: mock.MockEphemeralBox };
});
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => { await cleanup(); });

test("a durable box is usable as soon as its status leaves creating, not on a 2 s poll", async () => {
  state.boot = { polls: 3, outcome: "running" };
  const started = Date.now();
  const box = await createSandbox(upstash({ apiKey: "mock-key" }));
  try {
    // Three "creating" reads, then "running": four reads at 200 ms, well under the native SDK's first 2 s poll.
    expect(state.statusReads).toBe(4);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await box.run("pwd")).stdout).toBe("/workspace\n");
  } finally { await box.destroy(); }
});

test("a box that fails to boot is deleted, and creation fails as the native SDK reports it", async () => {
  state.boot = { polls: 1, outcome: "error" };
  await expect(createSandbox(upstash({ apiKey: "mock-key" }))).rejects.toMatchObject({ code: "provider", provider: "upstash", message: expect.stringContaining("Box creation failed") });
  expect(state.deletes).toHaveLength(1);
  expect(state.boxes.size).toBe(0);
});

test("cancelling while the box boots deletes it", async () => {
  state.boot = { polls: 50, outcome: "running" };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  await expect(createSandbox(upstash({ apiKey: "mock-key" }), { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  await vi.waitFor(() => expect(state.boxes.size).toBe(0));
  expect(state.deletes).toHaveLength(1);
});

test("a failed create request maps its HTTP status and allocates nothing", async () => {
  await expect(createSandbox(upstash({ apiKey: "mock-key" }), { from: "missing-snapshot", size: "small" })).rejects.toMatchObject({ code: "not_found", provider: "upstash" });
  expect(state.boxes.size).toBe(0);
});
