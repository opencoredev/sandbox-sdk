import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test, expect, vi } from "vitest";
import { cleanupMock, guest, mockState, requests } from "./daytona-mock.js";
import { daytona } from "../src/providers/daytona/index.js";
import { createSandbox } from "../src/index.js";
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupMock();
});
const modeOf = async (box: { id: string }, path: string) =>
  (await stat(join(guest(box.id).root, path))).mode & 0o7777;

test("lifecycle, preview, volume, proxy and create-timeout options reach the create request", async () => {
  const volumes = [{ volumeId: "vol-1", mountPath: "/data" }];
  const box = await createSandbox(
    daytona({
      apiKey: "key",
      public: true,
      autoArchiveMs: 90_000,
      autoDeleteMs: 0,
      volumes,
      outboundProxyUrl: "http://proxy.test:8080",
      createTimeoutMs: 150_500,
    }),
  );
  expect(mockState.creates.at(-1)).toMatchObject({
    public: true,
    autoArchiveInterval: 2,
    autoDeleteInterval: 0,
    volumes,
    outboundProxyUrl: "http://proxy.test:8080",
  });
  expect((await box.preview(3000)).headers).toBeUndefined();
  await box.destroy();
  const plain = await createSandbox(daytona({ apiKey: "key" }));
  const params = mockState.creates.at(-1);
  expect(params).toMatchObject({ public: false });
  for (const field of ["autoArchiveInterval", "autoDeleteInterval", "volumes", "outboundProxyUrl"])
    expect(params).not.toHaveProperty(field);
  expect((await plain.preview(3000)).headers).toEqual({
    "X-Daytona-Preview-Token": "mock-preview-token",
  });
  await plain.destroy();
});
test("createTimeoutMs bounds the wait for a sandbox to start", async () => {
  mockState.createState = "creating";
  const started = Date.now();
  await expect(
    createSandbox(daytona({ apiKey: "key", createTimeoutMs: 400 })),
  ).rejects.toMatchObject({ code: "timeout", provider: "daytona" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  expect(Date.now() - started).toBeLessThan(5_000);
  // A sandbox that starts after a few polls is returned.
  mockState.createState = "started";
  mockState.startPolls = 3;
  const box = await createSandbox(daytona({ apiKey: "key", createTimeoutMs: 5_000 }));
  expect(
    requests.filter(
      (request) => request.method === "GET" && request.url === `/api/sandbox/${box.id}`,
    ).length,
  ).toBeGreaterThanOrEqual(3);
  await box.destroy();
});
test("invalid lifecycle durations fail before creation", async () => {
  await expect(createSandbox(daytona({ apiKey: "key", autoDeleteMs: -1 }))).rejects.toMatchObject({
    code: "invalid_argument",
  });
  await expect(createSandbox(daytona({ apiKey: "key", autoArchiveMs: 0 }))).rejects.toMatchObject({
    code: "invalid_argument",
  });
  await expect(createSandbox(daytona({ apiKey: "key", createTimeoutMs: 0 }))).rejects.toMatchObject(
    { code: "invalid_argument" },
  );
  expect(mockState.creates).toHaveLength(0);
});
test("JWT credentials with an organization replace the API key", async () => {
  vi.stubEnv("DAYTONA_API_KEY", "env-key");
  const box = await createSandbox(daytona({ jwtToken: "jwt", organizationId: "org" }));
  const create = requests.find(
    (request) => request.method === "POST" && request.url === "/api/sandbox",
  );
  expect(create?.headers).toMatchObject({
    authorization: "Bearer jwt",
    "x-daytona-organization-id": "org",
  });
  // The toolbox plane gets the same credentials.
  await box.run("true");
  const toolbox = requests.find((request) => request.url.startsWith(`/toolbox/${box.id}/`));
  expect(toolbox?.headers).toMatchObject({
    authorization: "Bearer jwt",
    "x-daytona-organization-id": "org",
  });
  expect(requests.some((request) => request.headers.authorization === "Bearer env-key")).toBe(
    false,
  );
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
  await expect(box.snapshot({ expiresInMs: 3_600_000 })).rejects.toMatchObject({
    code: "unsupported",
    provider: "daytona",
  });
  expect(mockState.snapshots.size).toBe(0);
  expect((await box.snapshot({ expiresInMs: 0 })).id).toMatch(/^sdk-/);
  await box.destroy();
});
