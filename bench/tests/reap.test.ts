import { afterAll, afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanupFreestyle, freestyleFetch, freestyleState } from "../../packages/sdk/tests/freestyle-mock.js";
// The fake Freestyle API; any other host throws.
vi.stubGlobal("fetch", vi.fn(freestyleFetch));
vi.mock("../src/providers.js", () => ({ loadProvider: vi.fn() }));
import { loadProvider } from "../src/providers.js";
import { freestyle } from "../../packages/sdk/src/providers/freestyle/index.js";
import { createSandbox } from "../../packages/sdk/src/index.js";
import { main } from "../src/cli.js";
afterAll(() => vi.unstubAllGlobals());
const argv = process.argv;
const exitCode = process.exitCode;
afterEach(async () => {
  process.argv = argv;
  process.exitCode = exitCode;
  freestyleState.listError = 0;
  vi.restoreAllMocks();
  await cleanupFreestyle();
});
test("bench reap skips legacy missing metadata, recovers native-labelled orphans, and keeps other runs", async () => {
  const directory = await mkdtemp(resolve("reap-test-"));
  const provider = freestyle({ apiKey: "mock-key" });
  const own = await createSandbox(provider, { labels: { "sandbox-bench-run": "reap-43" } });
  const unrelated = await createSandbox(provider, { labels: { "sandbox-bench-run": "other" } });
  const legacy = await createSandbox(provider);
  const native = freestyleState.boxes.get(legacy.id);
  if (!native) throw new Error("Missing mock VM");
  delete native.record.metadata["sandbox-sdk-info"];
  const ownVm = freestyleState.boxes.get(own.id);
  if (!ownVm) throw new Error("Missing mock VM");
  vi.spyOn(native.fs, "readFile").mockRejectedValue(Object.assign(new Error("missing marker or VM"), { status: 404 }));
  vi.spyOn(ownVm.fs, "readFile").mockRejectedValue(Object.assign(new Error("setup never ran"), { status: 404 }));
  vi.mocked(loadProvider).mockResolvedValue({ kind: "ready", name: "freestyle", cloud: true, region: null, provider });
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    // Journal can know a returned id, but cannot know the orphan's id before create returns.
    await writeFile(resolve(directory, "ownership.json"), JSON.stringify({ runId: "reap-43", resources: [] }));
    process.argv = ["bun", "bench", "reap", "--providers", "freestyle", "--run", "reap-43", "--out", directory];
    process.exitCode = 0;
    await main();
    expect(process.exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith("freestyle: 0 leftovers for reap-43\n");
    expect(freestyleState.boxes.has(own.id)).toBe(false);
    expect(freestyleState.boxes.has(unrelated.id)).toBe(true);
    expect(freestyleState.boxes.has(legacy.id)).toBe(true);
    expect(JSON.parse(await readFile(resolve(directory, "ownership.json"), "utf8")).resources).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("bench reap fails on native listing auth errors", async () => {
  const directory = await mkdtemp(resolve("reap-test-"));
  vi.mocked(loadProvider).mockResolvedValue({ kind: "ready", name: "freestyle", cloud: true, region: null, provider: freestyle({ apiKey: "mock-key" }) });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    freestyleState.listError = 401;
    process.argv = ["bun", "bench", "reap", "--providers", "freestyle", "--run", "reap-43", "--out", directory];
    process.exitCode = 0;
    await main();
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Freestyle request failed"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reap recovers exactly labelled resources even when the journal is truncated", async () => {
  const directory = await mkdtemp(resolve("reap-test-"));
  const provider = freestyle({ apiKey: "mock-key" });
  const own = await createSandbox(provider, { labels: { "sandbox-bench-run": "corrupt-run" } });
  const other = await createSandbox(provider, { labels: { "sandbox-bench-run": "other" } });
  vi.mocked(loadProvider).mockResolvedValue({ kind: "ready", name: "freestyle", cloud: true, region: null, provider });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await writeFile(resolve(directory, "ownership.json"), '{"resources":[');
    process.argv = ["bun", "bench", "reap", "--providers", "freestyle", "--run", "corrupt-run", "--out", directory];
    process.exitCode = 0;
    await main();
    expect(process.exitCode).toBe(0);
    expect(freestyleState.boxes.has(own.id)).toBe(false);
    expect(freestyleState.boxes.has(other.id)).toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("journal is corrupt"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
