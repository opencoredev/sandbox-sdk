// Regressions from the fourth re-check of the stress suites.
import { afterEach, expect, it, vi } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { cpuOverlap } from "../src/cpu.js";
import { lookupSandbox } from "../src/existence.js";
import { bound } from "./native-fakes.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("the overlap bound is the same at epoch timestamps as at relative ones", () => {
  // Proven single-phase overlap is 799.9997 ms of a 999.9999 ms phase: 0.79999978, under 0.8.
  const windows: readonly { d: number; r: number }[] = [
    { d: 0, r: 2100 },
    { d: 100, r: 2200 },
  ];

  const members = (at: number) =>
    windows.map(({ d, r }) => ({
      exec: [at + d, at + r] satisfies [number, number],
      singleSeconds: 0.9999999,
      allSeconds: 0.9999999,
    }));

  const relative = cpuOverlap(members(0));
  const epoch = cpuOverlap(members(1_795_152_192_000));

  expect(relative).toMatchObject({ ok: false });
  expect(epoch).toMatchObject({ ok: false });
});

it("a Superserve lookup goes to the control plane of the key's region, as the SDK routes it", async () => {
  vi.stubEnv("SUPERSERVE_API_KEY", `ss_live_usw_${"a".repeat(32)}`);
  vi.stubEnv("SUPERSERVE_BASE_URL", "");

  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ id: "target", status: "running" })));

  vi.stubGlobal("fetch", fetcher);
  await lookupSandbox(bound({ ...memory(), name: "superserve" }), "target", 100);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://api-usw.superserve.ai/sandboxes/target");
});

it("an explicit SUPERSERVE_BASE_URL still wins over the key's region", async () => {
  vi.stubEnv("SUPERSERVE_API_KEY", `ss_live_usw_${"a".repeat(32)}`);
  vi.stubEnv("SUPERSERVE_BASE_URL", " https://api-staging.superserve.ai ");

  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ id: "target", status: "running" })));

  vi.stubGlobal("fetch", fetcher);
  await lookupSandbox(bound({ ...memory(), name: "superserve" }), "target", 100);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://api-staging.superserve.ai/sandboxes/target");
});

it("a trailing slash on a base URL override doesn't change the lookup path, as in the SDK", async () => {
  vi.stubEnv("SUPERSERVE_API_KEY", `ss_live_usw_${"a".repeat(32)}`);
  vi.stubEnv("SUPERSERVE_BASE_URL", "https://api-usw.superserve.ai//");
  vi.stubEnv("INSTABOX_API_URL", "https://api.instabox.sh/");
  vi.stubEnv("INSTABOX_API_KEY", "offline");

  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ id: "target", status: "running" })));

  vi.stubGlobal("fetch", fetcher);
  await lookupSandbox(bound({ ...memory(), name: "superserve" }), "target", 100);
  await lookupSandbox(bound({ ...memory(), name: "instabox" }), "target", 100);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "https://api-usw.superserve.ai/sandboxes/target",
    "https://api.instabox.sh/v1/machines/target",
  ]);
});
