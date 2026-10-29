import { afterAll, describe, expect, test, vi } from "vitest";
import { createSandbox, connectSandbox, listSandboxes } from "../src/index.js";
import { sandboxer } from "../src/providers/sandboxer/index.js";
import { runConformance } from "../src/testing.js";
import { boatMock } from "./boat-mock.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const mock = await boatMock("sandboxer");
const factory = () => sandboxer({ apiKey: "test-key", baseUrl: mock.apiUrl });

afterAll(() => mock.dispose());

runConformance(factory, { live: true });

describe("Sandboxer API v1", () => {
  test("10 MiB files use private artifacts, never signed URLs", async () => {
    const box = await createSandbox(factory());

    try {
      const bytes = Uint8Array.from({ length: 10 * 1024 * 1024 }, (_, i) => i % 251);
      await box.files.write("large.bin", bytes);
      expect(
        Buffer.from(await box.files.read("large.bin", { as: "bytes" })).equals(Buffer.from(bytes)),
      ).toBe(true);
      expect(mock.calls).toContain(`GET /sandboxes/${box.id}/artifacts`);
      expect(mock.calls.some((call) => call.includes("download-url"))).toBe(false);
    } finally {
      await box.destroy();
    }

    expect(mock.calls).toContain(`GET /deletion-operations/delete-${box.id}`);
    expect(mock.boxes.has(box.id)).toBe(false); // Mock requires the Sandboxer confirmation header.
  });
  test("private preview sends the token as the proxy cookie without a request", async () => {
    const box = await createSandbox(factory());

    try {
      const before = mock.calls.length;
      const p = await box.preview(3000);
      expect(new URL(p.url).searchParams.has("_token")).toBe(false);
      expect(p.headers).toEqual({ Cookie: "__sbx_auth=test-token" });
      const path = await box.preview(3000, { path: "/health?check=1" });
      expect(new URL(path.url).pathname).toBe("/health");
      expect(path.headers).toEqual({ Cookie: "__sbx_auth=test-token" });
      expect(mock.calls.slice(before).some((call) => call.includes("/preview"))).toBe(false);
    } finally {
      await box.destroy();
    }
  });
  test("pause/resume waits and a fresh handle reconnects with metadata", async () => {
    const provider = factory(),
      box = await createSandbox(provider, { labels: { test: "pause" } });

    try {
      await box.files.write("marker", "saved");
      await box.pause();
      expect(await provider.connect(box.id)).toMatchObject({ state: "paused" });
      await box.resume();
      expect((await box.run("cat marker")).stdout).toBe("saved");
      const fresh = await connectSandbox(factory(), box.id);
      expect((await fresh.run("true")).exitCode).toBe(0);
      expect(
        (await listSandboxes(factory(), { labels: { test: "pause" } })).map((b) => b.id),
      ).toContain(box.id);
      await fresh.close();
    } finally {
      await box.destroy();
    }
  });
  test("named snapshots deploy through the create from field", async () => {
    const provider = factory(),
      box = await createSandbox(provider);

    let restored;

    try {
      const snapshot = await box.snapshot();
      expect(snapshot.id).toMatch(/^sdk-/);
      restored = await createSandbox(provider, { from: snapshot.id });
      expect(mock.creates.at(-1)).toMatchObject({ from: snapshot.id, noEnv: true });
    } finally {
      await restored?.destroy();
      await box.destroy();
    }
  });
  test("region reaches the create body and native exposes the placement", async () => {
    const pinned = await createSandbox(
      sandboxer({ apiKey: "test-key", baseUrl: mock.apiUrl, region: "eu-central" }),
    );

    try {
      expect(mock.creates.at(-1)).toMatchObject({ region: "eu-central", noEnv: true });
      expect(pinned.native).toMatchObject({ region: "eu-central", regionSource: "requested" });
    } finally {
      await pinned.destroy();
    }

    const nearest = await createSandbox(factory());

    try {
      expect(mock.creates.at(-1)).not.toHaveProperty("region");
      expect(nearest.native).toMatchObject({ region: "us-east", regionSource: "nearest" });
      const fresh = await connectSandbox(factory(), nearest.id);
      expect(fresh.native).toMatchObject({ region: "us-east", regionSource: "nearest" });
      await fresh.close();
    } finally {
      await nearest.destroy();
    }

    expect(() => sandboxer({ apiKey: "test-key", region: "US East" })).toThrow(
      expect.objectContaining({ code: "invalid_argument" }),
    );
  });
  test.each([
    [401, "auth"],
    [404, "not_found"],
    [429, "quota"],
    [503, "unavailable"],
  ])("HTTP %s errors name Sandboxer", async (status, code) => {
    mock.status = Number(status);

    try {
      await expect(factory().connect("missing")).rejects.toMatchObject({
        provider: "sandboxer",
        code,
      });
      await expect(factory().connect("missing")).rejects.toThrow(/Sandboxer/);
      await expect(factory().connect("missing")).rejects.not.toThrow(/Boat|secret-value/);
    } finally {
      mock.status = 0;
    }
  });
});

test("names the HTTP status and fixed API code in Sandboxer failures, never free text", async () => {
  const { errors } = await import("../src/providers/boat-api/errors.js");
  const { boatError } = errors("sandboxer", "Sandboxer", "SANDBOXER_API_KEY", true);
  const response = new Response(null, { status: 503 });
  expect(boatError({ response, apiCode: "out_of_capacity" }).message).toContain(
    "(HTTP 503 out_of_capacity)",
  );
  expect(boatError({ response, apiCode: "Bearer sbx_live_secret" }).message).not.toContain(
    "secret",
  );
  expect(errors().boatError({ response, apiCode: "out_of_capacity" }).message).toBe(
    "Boat request failed: the service is down or unreachable. Check the sandbox and Boat service before retrying.",
  );
});

test("Sandboxer create sends only create and rename, then the first run is one command", async () => {
  mock.staleRename = true;
  const provider = factory();

  const before = mock.calls.length,
    commandsBefore = mock.commands.length;

  let id: string | undefined;

  try {
    const created = await provider.create({ labels: { verification: "sbx69" } });
    id = created.id;
    expect(created.state).toBe("running");
    expect(mock.calls.slice(before)).toHaveLength(2);
    expect(mock.commands.length).toBe(commandsBefore);
    // Skip the lazy secret recovery so the count covers only the run.
    const box = await connectSandbox(provider, id, { recoverSecrets: false });
    const first = mock.calls.length;
    expect(await box.run("pwd")).toMatchObject({ ok: true, stdout: "/workspace\n" });
    expect(mock.calls.slice(first).filter((call) => /POST .*\/commands$/.test(call))).toHaveLength(
      1,
    );
  } finally {
    mock.staleRename = false;

    if (id) await provider.destroy(id);
  }
});

test("Sandboxer setup failure rejects without running user code", async () => {
  const box = await createSandbox(factory());

  try {
    mock.failSetup = true;
    await expect(box.run("touch /tmp/.sandbox-sdk-user-ran", { cwd: "/" })).rejects.toMatchObject({
      code: "provider",
      provider: "sandboxer",
    });
    mock.failSetup = false;
    expect(await box.files.exists("/tmp/.sandbox-sdk-user-ran")).toBe(false);
  } finally {
    mock.failSetup = false;
    await box.destroy();
  }
});

test("missing Sandboxer key fails with auth guidance on first use, not at construction", async () => {
  vi.stubEnv("SANDBOXER_API_KEY", "");

  try {
    const provider = sandboxer({ baseUrl: mock.apiUrl });
    await expect(provider.list({})).rejects.toMatchObject({ code: "auth", provider: "sandboxer" });
    await expect(provider.list({})).rejects.toThrow(
      "Sandboxer API key is missing. Authentication is required. Set SANDBOXER_API_KEY or pass apiKey.",
    );
    await expect(provider.pause?.("missing")).rejects.toMatchObject({
      code: "auth",
      provider: "sandboxer",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
