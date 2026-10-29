import { afterEach, expect, test, vi } from "vitest";
import { createSandbox } from "../src/index.js";
import { daytona } from "../src/providers/daytona/index.js";
import { cleanupMock, guest, MockDaytona, mockState } from "./daytona-mock.js";

afterEach(async () => { vi.restoreAllMocks(); await cleanupMock(); });

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("a fallback lookup captured before destroy cannot restore a deleted sandbox", async () => {
  const provider = daytona({ apiKey: "offline" });
  const box = await createSandbox(provider);
  const native = mockState.boxes.get(box.id);
  if (!native) throw new Error("Expected the retained mock sandbox");
  vi.spyOn(MockDaytona.prototype, "list").mockImplementation(async function* () {});
  const started = deferred(), release = deferred();
  vi.spyOn(MockDaytona.prototype, "get").mockImplementationOnce(async () => {
    started.resolve(); await release.promise; return native;
  });
  const listing = provider.list({});
  await started.promise;
  try { await provider.destroy(box.id); } finally { release.resolve(); }
  expect((await listing).map(value => value.id)).not.toContain(box.id);
  expect(() => provider.native(box.id)).toThrow();
});

// Stdin above the buffered inline limit forces the session transport.
const sessionStdin = "x".repeat(64 * 1024);
for (const chunks of [["X:\nO:eA=="], ["X:\n", "O:eA=="]]) {
  test(`session completion rejects a partial trailing record delivered in ${chunks.length} chunks`, async () => {
    const box = await createSandbox(daytona({ apiKey: "offline" }));
    vi.spyOn(guest(box.id).process, "executeSessionCommand").mockResolvedValue({ cmdId: "synthetic" });
    vi.spyOn(guest(box.id).process, "getSessionCommand").mockResolvedValue({ id: "synthetic", command: "", exitCode: 0 });
    vi.spyOn(guest(box.id).process, "getSessionCommandLogs").mockImplementation(async (_session, _command, stdout) => {
      for (const chunk of chunks) stdout(chunk);
      await new Promise<void>(() => {});
    });
    await expect(box.run("ignored", { stdin: sessionStdin, timeoutMs: 1000 })).rejects.toMatchObject({ code: "provider" });
  });
}

test("a split final frame preserves exact preceding user output", async () => {
  const box = await createSandbox(daytona({ apiKey: "offline" }));
  vi.spyOn(guest(box.id).process, "executeSessionCommand").mockResolvedValue({ cmdId: "synthetic" });
  vi.spyOn(guest(box.id).process, "getSessionCommand").mockResolvedValue({ id: "synthetic", command: "", exitCode: 0 });
  vi.spyOn(guest(box.id).process, "getSessionCommandLogs").mockImplementation(async (_session, _command, stdout) => {
    stdout("O:ZXhh"); stdout("Y3Q=\nX"); stdout(":\n");
    await new Promise<void>(() => {});
  });
  expect(await box.run("ignored", { stdin: sessionStdin, timeoutMs: 1000 })).toMatchObject({ stdout: "exact", exitCode: 0, timedOut: false });
});
