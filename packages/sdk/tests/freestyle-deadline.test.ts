import { afterEach, expect, test, vi } from "vitest";
import { freestyle } from "../src/providers/freestyle/index.js";
import { FreestyleApiError } from "freestyle";

afterEach(() => vi.unstubAllGlobals());

test("overall deadline stops the real SDK's HTTP 202 polling without another network request", async () => {
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      requests++;
      if (requests > 1) return new Response(JSON.stringify({ vms: [], totalCount: 0 }));
      return new Response(
        JSON.stringify({ requestId: "offline", resultUrl: "/v5/background-requests/offline" }),
        { status: 202 },
      );
    }),
  );
  const provider = freestyle({ apiKey: "mock", requestTimeoutMs: 20 });
  const start = Date.now();
  await expect(provider.list({})).rejects.toMatchObject({ code: "timeout" });
  expect(Date.now() - start).toBeLessThan(500);
  expect(requests).toBe(1);
  // 0.2.20 sleeps two seconds between background polls. Its next iteration
  // must see a terminal SDK error before fetching, not retry for five minutes.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  expect(requests).toBe(1);
}, 5000);

test("every awaited native operation is bounded and aborts its fetch", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Missing deadline signal");
          signals.push(signal);
          const abort = () => reject(new DOMException("stopped", "AbortError"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
    ),
  );
  const p = freestyle({ apiKey: "mock", requestTimeoutMs: 20 });
  const operations = [
    () => p.create({ labels: {} }),
    () => p.connect("offline"),
    () => p.list({}),
    () => p.destroy("offline"),
    () => p.pause?.("offline"),
    () => p.resume?.("offline"),
    () => p.snapshot?.("offline"),
    () => p.previewUrl("offline", 3000),
    () => p.files.read("offline", "/workspace/file"),
    () => p.files.readRange?.("offline", "/workspace/file", { offset: 0, length: 100000 }),
    () => p.files.write("offline", "/workspace/file", new Uint8Array([1])),
    () => p.files.stat("offline", "/workspace/file"),
    () => p.files.list("offline", "/workspace"),
    () => p.files.mkdir("offline", "/workspace/dir"),
    () => p.files.remove("offline", "/workspace/file", { recursive: false }),
  ];
  for (const [i, operation] of operations.entries()) {
    const start = Date.now();
    await expect(operation()).rejects.toMatchObject({
      code: i === 0 ? "outcome_unknown" : "timeout",
    });
    expect(Date.now() - start).toBeLessThan(500);
    expect(signals.at(-1)?.aborted).toBe(true);
  }
});

test("caller abort interrupts a pending native create and its HTTP request", async () => {
  const c = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          fetchSignal?.addEventListener(
            "abort",
            () => reject(new FreestyleApiError(408, { code: "STOPPED", message: "stopped" })),
            { once: true },
          );
          c.abort();
        }),
    ),
  );
  await expect(
    freestyle({ apiKey: "mock", requestTimeoutMs: 1000 }).create({ labels: {}, signal: c.signal }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(fetchSignal?.aborted).toBe(true);
});

test("an already-aborted operation makes no native request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const c = new AbortController();
  c.abort();
  await expect(
    freestyle({ apiKey: "mock" }).create({ labels: {}, signal: c.signal }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(fetch).not.toHaveBeenCalled();
});
