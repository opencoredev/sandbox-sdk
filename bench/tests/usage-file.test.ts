import { expect, it } from "vitest";
import { decodeVercel } from "../src/billing/providers.js";
import { savedCosts, usageFileSchema } from "../src/realistic/usage-file.js";

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
