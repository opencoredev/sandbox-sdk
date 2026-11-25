// GPT-6.2 Sol's independent review of the Microsandbox adapter (2026-11-24): its reproductions of
// the adapter's own findings, kept verbatim as regressions. The bench's share is in
// bench/tests/microsandbox-review.test.ts.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { peerError } from "../src/providers/microsandbox/errors.js";
import { microsandbox, type MicrosandboxOptions } from "../src/providers/microsandbox/index.js";
import { microsandboxFake, type MicrosandboxFake } from "./microsandbox-fake.js";

const key = "msb_fake_key_0123456789";
let fake: MicrosandboxFake;
const realFetch = globalThis.fetch.bind(globalThis);

beforeEach(async () => {
  fake = await microsandboxFake();
  vi.stubEnv("MSB_API_KEY", key);
  vi.stubEnv("MSB_API_URL", fake.url);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fake.close();
});

function adapter(options: MicrosandboxOptions = {}) {
  return microsandbox({
    apiKey: key,
    baseUrl: fake.url,
    computeType: "standard",
    peer: async () => fake.peer,
    ...options,
  });
}

const labels = (tier = "standard") => ({
  "sandbox-bench-run": "independent-review",
  "sandbox-sdk": "1",
  "sandbox-bench-tier": tier,
});

test("R1 sandbox DELETE is dispatched when the Services request consumes its deadline", async () => {
  const p = adapter({
    fetch: async (url, init) => {
      if (new URL(url).pathname === "/v1/services") {
        cleanup.abort();
        throw new DOMException("cleanup deadline", "TimeoutError");
      }

      return realFetch(url, init);
    },
  });

  const { id: sandbox } = await p.create({ labels: labels() });
  const cleanup = new AbortController();
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout")
    .mockImplementationOnce(() => cleanup.signal)
    .mockImplementation(nativeTimeout);
  await p.destroy(sandbox).catch(() => {});
  expect(
    fake.requests.some((r) => r.method === "DELETE" && r.path === "/v1/sandboxes/" + sandbox),
  ).toBe(true);
  expect(fake.sandboxes.has(sandbox)).toBe(false);
});

test("R2 failed Service discovered by a fresh adapter remains available to the next destroy", async () => {
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels() });
  const { url } = await p.previewUrl(sandbox, 3000);
  const slug = new URL(url).pathname.split("/").at(-1) ?? "";
  const fresh = adapter();
  fake.faults.serviceDeleteFails = true;
  await expect(fresh.destroy(sandbox)).rejects.toThrow(/Services/);
  expect(fake.sandboxes.has(sandbox)).toBe(false);
  expect(fake.services.get(slug)?.status).toBe("detached");
  fake.faults.serviceDeleteFails = false;
  await fresh.destroy(sandbox);
  expect(fake.services.has(slug)).toBe(false);
});

test("R11 peer error codes go through the same redactor as peer messages", () => {
  const marker = "msb_pat_dummy_review_marker";
  const clean = (s: string) => s.replace(/msb_(?:pat_)?[A-Za-z0-9_-]+/g, "[REDACTED]");

  const error = peerError(
    Object.assign(new Error("peer " + marker), { code: marker }),
    "finding the sandbox",
    { redact: clean },
  );

  expect(error.message.includes(marker)).toBe(false);
  expect(String(error.cause).includes(marker)).toBe(false);
});

test("R13 an OCI size with a CPU count outside the OpenAPI int32 range is rejected before dispatch", async () => {
  const p = adapter();

  // The repo's lint forbids an `unknown` parameter, so the rejection is asserted directly.
  await expect(
    p.create({ labels: labels(), size: { cpu: 2 ** 31, memoryMb: 512 } }),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  expect(
    fake.requests.some((r) => r.method === "POST" && r.path.startsWith("/v1/sandboxes?")),
  ).toBe(false);
});

// Beyond the reproductions: the rest of the fixes' contracts.

test("memory and disk outside the OpenAPI int32 range are rejected before dispatch", async () => {
  const p = adapter();

  for (const size of [
    { cpu: 1, memoryMb: 2 ** 31 },
    { cpu: 1, memoryMb: 512, diskGb: 2 ** 31 / 1024 },
  ])
    await expect(p.create({ labels: labels(), size })).rejects.toMatchObject({
      code: "invalid_argument",
    });

  expect(fake.requests.some((r) => r.method === "POST")).toBe(false);
});

test("the Service hooks report a 409 as a conflict before the next slug is journaled", async () => {
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels() });
  const slug = "sbx-" + sandbox.replaceAll("-", "").slice(0, 16) + "-p3000";
  const events: string[] = [];
  fake.faults.takenSlugs = new Set([slug]);
  p.setAttemptHooks({
    service: (attempt) => void events.push(`journal ${attempt.slug}`),
    serviceSettled: (settled) => void events.push(`${settled.outcome} ${settled.slug}`),
  });
  const { url } = await p.previewUrl(sandbox, 3000);
  const retry = new URL(url).pathname.split("/").at(-1) ?? "";

  expect(retry).not.toBe(slug);
  expect(events).toEqual([
    `journal ${slug}`,
    `conflict ${slug}`,
    `journal ${retry}`,
    `created ${retry}`,
  ]);
  await p.destroy(sandbox);
});
