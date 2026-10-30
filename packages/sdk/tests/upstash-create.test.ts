import { afterEach, expect, test, vi } from "vitest";
import { createSandbox } from "../src/index.js";
import { cleanup, state, upstash } from "./upstash-mock.js";

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await cleanup();
});

test("a durable box is usable as soon as its status leaves creating, not on a 2 s poll", async () => {
  state.boot = { polls: 3, outcome: "running" };
  const started = Date.now();
  const box = await createSandbox(upstash({ apiKey: "mock-key" }));

  try {
    // Three "creating" reads, then "running": four reads at 200 ms, well under the native SDK's first 2 s poll.
    expect(state.statusReads).toBe(4);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await box.run("pwd")).stdout).toBe("/workspace\n");
  } finally {
    await box.destroy();
  }
});

test("a box that fails to boot is deleted, and creation fails as the native SDK reports it", async () => {
  state.boot = { polls: 1, outcome: "error" };
  await expect(createSandbox(upstash({ apiKey: "mock-key" }))).rejects.toMatchObject({
    code: "provider",
    provider: "upstash",
    message: expect.stringContaining("Box creation failed"),
  });
  expect(state.deletes).toHaveLength(1);
  expect(state.boxes.size).toBe(0);
});

test("cancelling while the box boots deletes it", async () => {
  state.boot = { polls: 50, outcome: "running" };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  await expect(
    createSandbox(upstash({ apiKey: "mock-key" }), { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "aborted" });
  await vi.waitFor(() => expect(state.boxes.size).toBe(0));
  expect(state.deletes).toHaveLength(1);
});

test("a failed create request maps its HTTP status and allocates nothing", async () => {
  await expect(
    createSandbox(upstash({ apiKey: "mock-key" }), { from: "missing-snapshot", size: "small" }),
  ).rejects.toMatchObject({ code: "not_found", provider: "upstash" });
  expect(state.boxes.size).toBe(0);
});

test("the create request is bound by requestTimeoutMs, and a lost answer is outcome_unknown", async () => {
  state.hangCreate = true;
  const started = Date.now();

  await expect(
    createSandbox(upstash({ apiKey: "mock-key", requestTimeoutMs: 300 })),
  ).rejects.toMatchObject({ code: "outcome_unknown", provider: "upstash" });
  expect(Date.now() - started).toBeLessThan(5000);
}, 10_000);

test("a cleanup DELETE that fails transiently is retried", async () => {
  state.boot = { polls: 1, outcome: "error" };
  state.deleteFailures = 1;
  await expect(createSandbox(upstash({ apiKey: "mock-key" }))).rejects.toMatchObject({
    code: "provider",
    message: expect.stringContaining("Box creation failed"),
  });
  expect(state.deletes).toHaveLength(2);
  expect(state.boxes.size).toBe(0);
});

test("a cleanup DELETE that never succeeds is outcome_unknown with the box ID", async () => {
  state.boot = { polls: 1, outcome: "error" };
  state.deleteFailures = 100;

  const error: unknown = await createSandbox(upstash({ apiKey: "mock-key" })).catch(
    (cause: Error) => cause,
  );

  const [id] = state.boxes.keys();
  expect(id).toBeDefined();
  expect(error).toMatchObject({
    code: "outcome_unknown",
    provider: "upstash",
    sandboxId: id,
    message: expect.stringContaining("Box creation failed"),
  });
  expect(state.deletes.length).toBeGreaterThan(1);
});

test("a connection lost after the create request is sent is outcome_unknown, and nothing is deleted", async () => {
  state.createReply = "reset";
  await expect(createSandbox(upstash({ apiKey: "mock-key" }))).rejects.toMatchObject({
    code: "outcome_unknown",
    provider: "upstash",
    message: expect.stringContaining("List sandboxes and destroy any you do not expect"),
  });
  // The box exists, but no answer named it.
  expect(state.boxes.size).toBe(1);
  expect(state.deletes).toHaveLength(0);
});

test("a create request refused before it is sent fails without outcome_unknown", async () => {
  state.createReply = "refused";

  const error: unknown = await createSandbox(upstash({ apiKey: "mock-key" })).catch(
    (cause: Error) => cause,
  );

  expect(error).toMatchObject({ provider: "upstash" });
  expect(error).not.toMatchObject({ code: "outcome_unknown" });
  expect(state.boxes.size).toBe(0);
});

test("a malformed create answer is outcome_unknown, with no ID claimed or deleted", async () => {
  state.createReply = "malformed";

  const error: unknown = await createSandbox(upstash({ apiKey: "mock-key" })).catch(
    (cause: Error) => cause,
  );

  expect(error).toMatchObject({
    code: "outcome_unknown",
    provider: "upstash",
    message: expect.stringContaining("List sandboxes and destroy any you do not expect"),
  });
  expect(error).not.toHaveProperty("sandboxId", expect.any(String));
  expect(state.boxes.size).toBe(1);
  expect(state.deletes).toHaveLength(0);
});

test("a create answer whose body stalls is outcome_unknown within requestTimeoutMs", async () => {
  state.createReply = "stall";
  const started = Date.now();

  await expect(
    createSandbox(upstash({ apiKey: "mock-key", requestTimeoutMs: 300 })),
  ).rejects.toMatchObject({ code: "outcome_unknown", provider: "upstash" });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(state.deletes).toHaveLength(0);
}, 10_000);

test("transient failures of the first Box.get are retried, so a booting box survives", async () => {
  state.boot = { polls: 2, outcome: "running" };
  state.getFailures = { count: 3, status: 503 };
  const box = await createSandbox(upstash({ apiKey: "mock-key" }));

  try {
    expect(state.getFailures.count).toBe(0);
    expect(state.deletes).toHaveLength(0);
    expect((await box.run("pwd")).stdout).toBe("/workspace\n");
  } finally {
    await box.destroy();
  }

  state.getFailures = { count: 2, status: 429 };
  const again = await createSandbox(upstash({ apiKey: "mock-key" }));
  await again.destroy();
  expect(state.deletes).toHaveLength(0);
});

test("an auth failure of the first Box.get fails at once and deletes the box", async () => {
  state.getFailures = { count: 100, status: 401 };
  const started = Date.now();
  await expect(createSandbox(upstash({ apiKey: "mock-key" }))).rejects.toMatchObject({
    code: "auth",
  });
  expect(state.getFailures.count).toBe(99);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(state.deletes).toHaveLength(1);
  expect(state.boxes.size).toBe(0);
});

test("a Box.get that fails just before the create deadline is not retried past it", async () => {
  state.getFailures = { count: 100, status: 503 };
  const now = Date.now.bind(Date);
  let skew = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + skew);

  // The first read fails with 100 ms of the 300 s create budget left: a 200 ms sleep would pass the deadline.
  state.onGet = () => {
    if (skew === 0) skew = 300_000 - 100;
  };

  try {
    await expect(createSandbox(upstash({ apiKey: "mock-key" }))).rejects.toMatchObject({
      code: "timeout",
      provider: "upstash",
    });
  } finally {
    clock.mockRestore();
  }

  expect(state.getTimeouts).toHaveLength(1);
  // The attempt's timeout is the remaining budget, not the 600 s native default.
  expect(state.getTimeouts[0]).toBeLessThanOrEqual(300_000);
  expect(state.deletes).toHaveLength(1);
  expect(state.boxes.size).toBe(0);
});

test("each Box.get attempt is bound by the time left, and by requestTimeoutMs", async () => {
  state.getFailures = { count: 2, status: 503 };
  const box = await createSandbox(upstash({ apiKey: "mock-key" }));
  await box.destroy();
  expect(state.getTimeouts).toHaveLength(3);

  for (const timeout of state.getTimeouts) {
    expect(timeout).toBeGreaterThan(290_000);
    expect(timeout).toBeLessThanOrEqual(300_000);
  }

  state.getTimeouts.length = 0;
  const bound = await createSandbox(upstash({ apiKey: "mock-key", requestTimeoutMs: 5_000 }));
  await bound.destroy();
  expect(state.getTimeouts).toEqual([5_000]);
});

test("a Box.get that never answers fails within requestTimeoutMs and deletes the box", async () => {
  state.hangGet = true;
  const started = Date.now();

  await expect(
    createSandbox(upstash({ apiKey: "mock-key", requestTimeoutMs: 300 })),
  ).rejects.toMatchObject({ code: "timeout", provider: "upstash" });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(state.deletes).toHaveLength(1);
  expect(state.boxes.size).toBe(0);
}, 10_000);

test("a Box.get that never answers and whose cleanup fails is outcome_unknown", async () => {
  state.hangGet = true;
  state.deleteFailures = 100;

  await expect(
    createSandbox(upstash({ apiKey: "mock-key", requestTimeoutMs: 300 })),
  ).rejects.toMatchObject({ code: "outcome_unknown", provider: "upstash" });
  expect(state.boxes.size).toBe(1);
}, 20_000);

test("cancelling while Box.get stalls deletes the box and reports aborted", async () => {
  state.hangGet = true;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const started = Date.now();

  await expect(
    createSandbox(upstash({ apiKey: "mock-key" }), { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(Date.now() - started).toBeLessThan(2_000);
  await vi.waitFor(() => expect(state.boxes.size).toBe(0));
  expect(state.deletes).toHaveLength(1);
}, 10_000);
