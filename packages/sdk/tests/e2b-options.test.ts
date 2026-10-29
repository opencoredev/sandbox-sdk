import { vi, test, expect, afterAll } from "vitest";

const mock = await vi.hoisted(async () => import("./e2b-sdk-mock.js"));

vi.mock("e2b", async (importOriginal) => {
  const real = await importOriginal<typeof import("e2b")>();

  return { ...real, Sandbox: mock.MockSandbox };
});

import { e2b } from "../src/providers/e2b/index.js";
import { createSandbox } from "../src/index.js";

const { calls, cleanupMock, MockSandbox } = mock;

afterAll(cleanupMock);

test("requestTimeoutMs and volumes reach Sandbox.create", async () => {
  const box = await createSandbox(
    e2b({ apiKey: "mock", requestTimeoutMs: 12_345, volumes: { "/data": "my-volume" } }),
  );

  try {
    expect(calls.at(-1)?.options).toMatchObject({
      requestTimeoutMs: 12_345,
      volumeMounts: { "/data": "my-volume" },
    });
  } finally {
    await box.destroy();
  }
});

test("autoPause pauses on timeout and records no hard deadline", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock", autoPause: true, autoResume: true }), {
    timeoutMs: 600_000,
  });

  try {
    const options = calls.at(-1)?.options;
    expect(options).toMatchObject({
      timeoutMs: 600_000,
      lifecycle: { onTimeout: "pause", autoResume: true },
    });
    expect(options?.metadata).not.toHaveProperty("sandbox-sdk-deadline");
  } finally {
    await box.destroy();
  }

  const plain = await createSandbox(e2b({ apiKey: "mock" }), { timeoutMs: 600_000 });

  try {
    expect(calls.at(-1)?.options).toMatchObject({
      lifecycle: { onTimeout: "kill", autoResume: false },
      metadata: { "sandbox-sdk-deadline": expect.any(String) },
    });
  } finally {
    await plain.destroy();
  }
});

test("autoResume without autoPause is rejected before creation", async () => {
  const before = calls.length;
  await expect(createSandbox(e2b({ apiKey: "mock", autoResume: true }))).rejects.toMatchObject({
    code: "invalid_argument",
    provider: "e2b",
  });
  expect(calls.length).toBe(before);
});

test("private previews send allowPublicTraffic: false and return the traffic token header", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock", public: false }), {
    network: { allow: ["registry.npmjs.org"] },
  });

  try {
    expect(calls.at(-1)?.options.network).toEqual({
      denyOut: ["0.0.0.0/0"],
      allowOut: ["registry.npmjs.org"],
      allowPublicTraffic: false,
    });
    expect(await box.preview(3000)).toEqual({
      url: `https://3000-${box.id}.e2b.test`,
      headers: { "e2b-traffic-access-token": `traffic-${box.id}` },
    });
  } finally {
    await box.destroy();
  }

  const open = await createSandbox(e2b({ apiKey: "mock" }));

  try {
    expect(calls.at(-1)?.options).not.toHaveProperty("network");
    expect(await open.preview(3000)).toEqual({ url: `https://3000-${open.id}.e2b.test` });
  } finally {
    await open.destroy();
  }
});

test("snapshot expiry is unsupported, 0 keeps the snapshot", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));

  try {
    const before = MockSandbox.snapshotCalls.length;
    await expect(box.snapshot({ expiresInMs: 60_000 })).rejects.toMatchObject({
      code: "unsupported",
      provider: "e2b",
    });
    expect(MockSandbox.snapshotCalls.length).toBe(before);
    expect((await box.snapshot({ expiresInMs: 0 })).id).toEqual(expect.any(String));
  } finally {
    await box.destroy();
  }
});
