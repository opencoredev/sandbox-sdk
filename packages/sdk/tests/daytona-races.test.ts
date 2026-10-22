import { afterEach, expect, test, vi } from "vitest";
import { createSandbox } from "../src/index.js";
import { daytona } from "../src/providers/daytona/index.js";
import { cleanupMock, MockDaytona } from "./daytona-mock.js";

vi.mock("@daytonaio/sdk", async () => ({ Daytona: (await import("./daytona-mock.js")).MockDaytona }));
afterEach(async () => { vi.restoreAllMocks(); await cleanupMock(); });

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("a fallback lookup captured before destroy cannot restore a deleted sandbox", async () => {
  const provider = daytona({ apiKey: "offline" });
  const box = await createSandbox(provider);
  const native = box.native;
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
