import { vi, test, expect, afterAll } from "vitest";
import { fakeE2B } from "./e2b-fake.js";
import { e2b } from "../src/providers/e2b/index.js";
import { createSandbox } from "../src/index.js";

const fake = await fakeE2B();
const { calls } = fake;

vi.stubGlobal("fetch", fake.fetch(globalThis.fetch));

afterAll(async () => {
  await fake.close();
  vi.unstubAllGlobals();
});

test("volumes reach the create request and requestTimeoutMs bounds it", async () => {
  const box = await createSandbox(
    e2b({ apiKey: "mock", requestTimeoutMs: 12_345, volumes: { "/data": "my-volume" } }),
  );

  try {
    expect(calls.at(-1)?.body).toMatchObject({
      volumeMounts: [{ name: "my-volume", path: "/data" }],
    });
  } finally {
    await box.destroy();
  }

  // A create slower than requestTimeoutMs fails; it may have happened remotely, so it is outcome_unknown.
  fake.createDelayMs = 300;

  try {
    await expect(
      createSandbox(e2b({ apiKey: "mock", requestTimeoutMs: 50 })),
    ).rejects.toMatchObject({ code: "outcome_unknown", provider: "e2b" });
  } finally {
    fake.createDelayMs = 0;
  }
});

test("autoPause pauses on timeout and records no hard deadline", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock", autoPause: true, autoResume: true }), {
    timeoutMs: 600_000,
  });

  try {
    const body = calls.at(-1)?.body;
    expect(body).toMatchObject({ timeout: 600, autoPause: true, autoResume: { enabled: true } });
    expect(body?.metadata).not.toHaveProperty("sandbox-sdk-deadline");
  } finally {
    await box.destroy();
  }

  const plain = await createSandbox(e2b({ apiKey: "mock" }), { timeoutMs: 600_000 });

  try {
    expect(calls.at(-1)?.body).toMatchObject({
      autoPause: false,
      autoResume: { enabled: false },
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
    expect(calls.at(-1)?.body.network).toEqual({
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
    expect(calls.at(-1)?.body).not.toHaveProperty("network");
    expect(await open.preview(3000)).toEqual({ url: `https://3000-${open.id}.e2b.test` });
  } finally {
    await open.destroy();
  }
});

test("snapshot expiry is unsupported, 0 keeps the snapshot", async () => {
  const box = await createSandbox(e2b({ apiKey: "mock" }));

  try {
    const before = fake.count("POST /sandboxes/{id}/snapshots");
    await expect(box.snapshot({ expiresInMs: 60_000 })).rejects.toMatchObject({
      code: "unsupported",
      provider: "e2b",
    });
    expect(fake.count("POST /sandboxes/{id}/snapshots")).toBe(before);
    expect((await box.snapshot({ expiresInMs: 0 })).id).toEqual(expect.any(String));
  } finally {
    await box.destroy();
  }
});

test("E2B domains route envd through the shared host with routing headers; others use the sandbox's own host", async () => {
  fake.sandboxDomain = "e2b.app";

  try {
    const box = await createSandbox(e2b({ apiKey: "mock" }));

    try {
      await box.files.write("routed", "yes");
      const write = fake.server.calls("POST /files").at(-1);
      expect(write?.headers).toMatchObject({
        "x-fake-host": "sandbox.e2b.app",
        "e2b-sandbox-id": box.id,
        "e2b-sandbox-port": "49983",
        "x-access-token": expect.stringMatching(/^envd-/),
      });
      expect(write?.headers).not.toHaveProperty("x-api-key");
      expect(await box.preview(3000)).toEqual({ url: `https://3000-${box.id}.e2b.app` });
    } finally {
      await box.destroy();
    }
  } finally {
    fake.sandboxDomain = "e2b.test";
  }

  const direct = await createSandbox(e2b({ apiKey: "mock" }));

  try {
    await direct.files.write("routed", "yes");
    expect(fake.server.calls("POST /files").at(-1)?.headers).toMatchObject({
      "x-fake-host": `49983-${direct.id}.e2b.test`,
      "e2b-sandbox-id": direct.id,
    });
  } finally {
    await direct.destroy();
  }
});

test("an envd older than the gates fails the way the SDK does", async () => {
  fake.envdVersion = "0.0.9";

  try {
    // Below 0.1.0 the sandbox is killed and creation fails.
    await expect(
      createSandbox(e2b({ apiKey: "mock" }), { labels: { old: "envd" } }),
    ).rejects.toMatchObject({ code: "provider" });
    expect(await e2b({ apiKey: "mock" }).list({ old: "envd" })).toEqual([]);
  } finally {
    fake.envdVersion = "0.10.0";
  }

  fake.envdVersion = "0.5.0";

  try {
    // stdin close needs 0.5.2: a command that reads stdin cannot get EOF, so the run fails and the sandbox goes.
    const box = await createSandbox(e2b({ apiKey: "mock" }));
    expect((await box.run("echo ok")).stdout).toBe("ok\n");
    await expect(box.run("cat", { stdin: "x" })).rejects.toMatchObject({ code: "unsupported" });
  } finally {
    fake.envdVersion = "0.10.0";
  }
});
