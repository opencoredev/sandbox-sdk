import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { decodeVercel, vercelMeter } from "../src/billing/providers.js";
import { captureUsage, savedCosts, usageFileSchema } from "../src/realistic/usage-file.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const meter = {
  name: "sbx-1",
  status: "stopped",
  totalActiveCpuDurationMs: 6476,
  totalDurationMs: 8964,
  memory: 4096,
  totalIngressBytes: 150_000_000,
  totalEgressBytes: 2_000_000,
};

// The cost a run saved before the byte counters were read: CPU, memory and one creation only.
const oldCost = {
  kind: "metered",
  usd: 0.0016,
  scope: "sandbox-lifetime",
  complete: true,
  confidence: "medium",
  note: "Vercel's active-CPU and wall-time meters at published Pro iad1 rates",
} as const;

it("prices a Vercel usage file again from its raw meter, data transfer included", () => {
  const file = usageFileSchema.parse({ sandboxes: [{ id: "sbx-1", cost: oldCost }], meter });

  expect(savedCosts("vercel", file)).toEqual([{ id: "sbx-1", cost: decodeVercel(meter, "sbx-1") }]);
  expect(savedCosts("vercel", file)[0]?.cost).toMatchObject({ kind: "metered", complete: true });
});

it("never calls a Vercel usage file without a raw meter final: it leaves out billed data transfer", () => {
  const file = usageFileSchema.parse({ sandboxes: [{ id: "sbx-1", cost: oldCost }] });
  const [saved] = savedCosts("vercel", file);

  expect(saved?.cost).toMatchObject({ kind: "metered", usd: 0.0016, complete: false });
  expect(saved?.cost.note).toContain("data transfer Vercel bills is left out");
});

it("refuses a Vercel raw meter that belongs to another sandbox", () => {
  const file = usageFileSchema.parse({
    sandboxes: [{ id: "sbx-2", cost: oldCost }],
    meter,
  });

  expect(() => savedCosts("vercel", file)).toThrow("Billing ID mismatch");
});

it("takes other adapters' saved costs as they are", () => {
  const file = usageFileSchema.parse({ sandboxes: [{ id: "box-1", cost: oldCost }] });

  expect(savedCosts("boat", file)).toEqual([{ id: "box-1", cost: oldCost }]);
});

it("captures a Vercel sandbox with one meter reading, priced from that reading and saved beside it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-"));
  const stop = vi.spyOn(vercelMeter, "stop").mockResolvedValue();
  const read = vi.spyOn(vercelMeter, "read").mockResolvedValueOnce(meter);

  // A second reading fails, as a transient API error would; capture must not need it.
  read.mockRejectedValue(new Error("Status code 503 is not ok"));

  const file = await captureUsage({
    adapter: "vercel",
    id: "sbx-1",
    usageDir: dir,
    env: { VERCEL_OIDC_TOKEN: "token" },
  });

  const saved = usageFileSchema.parse(JSON.parse(await readFile(file, "utf8")));

  expect(stop).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(saved.meter).toEqual(meter);
  expect(saved.sandboxes).toEqual([{ id: "sbx-1", cost: decodeVercel(meter, "sbx-1") }]);
});

it("still saves why a Vercel cost is unavailable when the one meter reading fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-"));
  vi.spyOn(vercelMeter, "stop").mockResolvedValue();
  vi.spyOn(vercelMeter, "read").mockRejectedValue(new Error("Status code 503 is not ok"));

  const file = await captureUsage({
    adapter: "vercel",
    id: "sbx-1",
    usageDir: dir,
    env: { VERCEL_OIDC_TOKEN: "token" },
  });

  const saved = usageFileSchema.parse(JSON.parse(await readFile(file, "utf8")));

  expect(saved.meter).toBeUndefined();
  expect(saved.sandboxes[0]?.cost).toMatchObject({
    kind: "unavailable",
    note: expect.stringContaining("3 tries"),
  });
});

it("keeps the raw meter when a Vercel reading succeeds only on a retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-"));
  vi.spyOn(vercelMeter, "stop").mockResolvedValue();

  const read = vi
    .spyOn(vercelMeter, "read")
    .mockRejectedValueOnce(new Error("Status code 503 is not ok"))
    .mockResolvedValueOnce(meter)
    .mockRejectedValue(new Error("no third reading expected"));

  const file = await captureUsage({
    adapter: "vercel",
    id: "sbx-1",
    usageDir: dir,
    env: { VERCEL_OIDC_TOKEN: "token" },
  });

  const saved = usageFileSchema.parse(JSON.parse(await readFile(file, "utf8")));

  expect(read).toHaveBeenCalledTimes(2);
  expect(saved.meter).toEqual(meter);
  expect(savedCosts("vercel", saved)[0]?.cost).toMatchObject({ kind: "metered", complete: true });
});
