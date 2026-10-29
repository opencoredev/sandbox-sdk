import { stat } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { cleanupTenki, MockSession, tenkiState } from "./tenki-mock.js";
import { tenki } from "../src/providers/tenki/index.js";
import { createSandbox } from "../src/index.js";
vi.mock("@tenkicloud/sandbox", async () => ({
  TenkiSandbox: (await import("./tenki-mock.js")).MockTenki,
}));
vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupTenki);
const key = { apiKey: "offline-test-key" };
const modeOf = async (box: { native: unknown }, path: string) => {
  if (!(box.native instanceof MockSession)) throw new Error("Expected the Tenki mock");
  return (await stat(`${box.native.root}${path}`)).mode & 0o7777;
};

test("retention, volumes and workspace reach create; workspace scopes list", async () => {
  const volumes = [{ volumeId: "vol_1", mountPath: "/data", readOnly: true }];
  const box = await createSandbox(tenki({ ...key, pauseRetentionMs: 3_600_000, volumes, workspaceId: "ws_1" }));
  try {
    expect(tenkiState.creates.at(-1)).toMatchObject({ pauseRetentionMs: 3_600_000, volumes, workspaceId: "ws_1" });
    await tenki({ ...key, workspaceId: "ws_1" }).list({});
    expect(tenkiState.calls.list.at(-1)).toEqual({ workspaceId: "ws_1" });
  } finally { await box.destroy(); }
  const plain = await createSandbox(tenki(key));
  try {
    for (const field of ["pauseRetentionMs", "volumes", "workspaceId"]) expect(tenkiState.creates.at(-1)).not.toHaveProperty(field);
    await tenki(key).list({});
    expect(tenkiState.calls.list.at(-1)).toBeUndefined();
  } finally { await plain.destroy(); }
});
test("previewTtlMs reaches exposePort", async () => {
  const box = await createSandbox(tenki({ ...key, previewTtlMs: 600_000 }));
  try { await box.preview(3000); expect(tenkiState.calls.exposePort.at(-1)).toEqual({ ttlMs: 600_000 }); }
  finally { await box.destroy(); }
});
test("write mode uses the native streaming write under /home/tenki and the guest fallback elsewhere", async () => {
  const box = await createSandbox(tenki(key));
  try {
    await box.files.write("/home/tenki/secret.txt", "a", { mode: 0o600 });
    expect(tenkiState.calls.writeFileStream.at(-1)).toEqual({ path: "/home/tenki/secret.txt", options: { mode: 0o600, truncate: true } });
    expect(await modeOf(box, "/home/tenki/secret.txt")).toBe(0o600);
    expect(await box.files.read("/home/tenki/secret.txt")).toBe("a");
    const streams = tenkiState.calls.writeFileStream.length;
    await box.files.write("/tmp/.sandbox-sdk/sbx-secret", "b", { mode: 0o640 });
    expect(tenkiState.calls.writeFileStream).toHaveLength(streams);
    expect(await modeOf(box, "/tmp/.sandbox-sdk/sbx-secret")).toBe(0o640);
    // Rewriting an existing file still applies the new mode on the fallback path.
    await box.files.write("/tmp/.sandbox-sdk/sbx-secret", "c", { mode: 0o600 });
    expect(await modeOf(box, "/tmp/.sandbox-sdk/sbx-secret")).toBe(0o600);
    expect(await box.files.read("/tmp/.sandbox-sdk/sbx-secret")).toBe("c");
    const plain = tenkiState.calls.writeFile;
    await box.files.write("/home/tenki/plain.txt", "d");
    expect(tenkiState.calls.writeFile).toBe(plain + 1);
    expect(tenkiState.calls.writeFileStream).toHaveLength(streams);
  } finally { await box.destroy(); }
});
test("snapshot expiresInMs becomes expiresAt; 0 sets no expiry", async () => {
  const box = await createSandbox(tenki(key));
  try {
    const before = Date.now();
    await box.snapshot({ expiresInMs: 3_600_000 });
    const options = tenkiState.calls.createSnapshot.at(-1);
    expect(options).toMatchObject({ async: true, expiresAt: expect.any(Date) });
    const expiresAt = options && typeof options === "object" && "expiresAt" in options && options.expiresAt instanceof Date ? options.expiresAt.getTime() : 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    await box.snapshot({ expiresInMs: 0 });
    expect(tenkiState.calls.createSnapshot.at(-1)).toEqual({ async: true });
    await expect(box.snapshot({ expiresInMs: -1 })).rejects.toMatchObject({ code: "invalid_argument", provider: "tenki" });
  } finally { await box.destroy(); }
});
