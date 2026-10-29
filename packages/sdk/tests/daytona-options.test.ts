import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test, expect, vi } from "vitest";
import { cleanupMock, mockState, MockSandbox } from "./daytona-mock.js";
import { daytona } from "../src/providers/daytona/index.js";
import { createSandbox } from "../src/index.js";
vi.mock("@daytonaio/sdk", async () => ({ Daytona: (await import("./daytona-mock.js")).MockDaytona }));
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => { vi.unstubAllEnvs(); await cleanupMock(); });
const modeOf = async (box: { native: unknown }, path: string) => {
  if (!(box.native instanceof MockSandbox)) throw new Error("Expected the Daytona mock");
  return (await stat(join(box.native.root, path))).mode & 0o7777;
};

test("lifecycle, preview, volume, proxy and create-timeout options reach daytona.create", async () => {
  const volumes = [{ volumeId: "vol-1", mountPath: "/data" }];
  const box = await createSandbox(daytona({ apiKey: "key", public: true, autoArchiveMs: 90_000, autoDeleteMs: 0, volumes, outboundProxyUrl: "http://proxy.test:8080", createTimeoutMs: 150_500 }));
  expect(mockState.creates.at(-1)).toMatchObject({ public: true, autoArchiveInterval: 2, autoDeleteInterval: 0, volumes, outboundProxyUrl: "http://proxy.test:8080" });
  expect(mockState.createOptions.at(-1)).toEqual({ timeout: 151 });
  expect((await box.preview(3000)).headers).toBeUndefined();
  await box.destroy();
  const plain = await createSandbox(daytona({ apiKey: "key" }));
  const params = mockState.creates.at(-1);
  expect(params).toMatchObject({ public: false });
  for (const field of ["autoArchiveInterval", "autoDeleteInterval", "volumes", "outboundProxyUrl"]) expect(params).not.toHaveProperty(field);
  expect(mockState.createOptions.at(-1)).toEqual({ timeout: 60 });
  expect((await plain.preview(3000)).headers).toEqual({ "X-Daytona-Preview-Token": "mock-preview-token" });
  await plain.destroy();
});
test("invalid lifecycle durations fail before creation", async () => {
  await expect(createSandbox(daytona({ apiKey: "key", autoDeleteMs: -1 }))).rejects.toMatchObject({ code: "invalid_argument" });
  await expect(createSandbox(daytona({ apiKey: "key", autoArchiveMs: 0 }))).rejects.toMatchObject({ code: "invalid_argument" });
  await expect(createSandbox(daytona({ apiKey: "key", createTimeoutMs: 0 }))).rejects.toMatchObject({ code: "invalid_argument" });
  expect(mockState.creates).toHaveLength(0);
});
test("JWT credentials with an organization replace the API key", async () => {
  vi.stubEnv("DAYTONA_API_KEY", "env-key");
  const box = await createSandbox(daytona({ jwtToken: "jwt", organizationId: "org" }));
  expect(mockState.configs.at(-1)).toMatchObject({ jwtToken: "jwt", organizationId: "org" });
  expect(mockState.configs.at(-1)?.apiKey).toBeUndefined();
  await box.destroy();
  vi.stubEnv("DAYTONA_API_KEY", "");
  vi.stubEnv("DAYTONA_ORGANIZATION_ID", "");
  await expect(createSandbox(daytona({ jwtToken: "jwt" }))).rejects.toMatchObject({ code: "auth" });
});
test("write mode is applied natively on the first and later writes", async () => {
  const box = await createSandbox(daytona({ apiKey: "key" }));
  // The first write goes through workspace setup in a code run.
  await box.files.write("first.txt", "a", { mode: 0o600 });
  expect(await modeOf(box, "/workspace/first.txt")).toBe(0o600);
  await box.files.write("later.sh", "b", { mode: 0o755 });
  expect(mockState.permissions.at(-1)).toEqual({ path: "/workspace/later.sh", mode: "755" });
  expect(await modeOf(box, "/workspace/later.sh")).toBe(0o755);
  const before = mockState.permissions.length;
  await box.files.write("plain.txt", "c");
  expect(mockState.permissions).toHaveLength(before);
  expect(box.files).toBeDefined();
  await box.destroy();
});
test("snapshot expiry is unsupported, 0 keeps the snapshot", async () => {
  const box = await createSandbox(daytona({ apiKey: "key" }));
  await expect(box.snapshot({ expiresInMs: 3_600_000 })).rejects.toMatchObject({ code: "unsupported", provider: "daytona" });
  expect(mockState.snapshots.size).toBe(0);
  expect((await box.snapshot({ expiresInMs: 0 })).id).toMatch(/^sdk-/);
  await box.destroy();
});
