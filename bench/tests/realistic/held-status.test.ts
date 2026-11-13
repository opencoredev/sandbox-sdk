import { expect, it } from "vitest";
import type { ReportedCost } from "../../src/cost/columns.js";
import { heldStatus } from "../../src/realistic/held-status.js";

const charge = (kind: "billed" | "metered", settled: boolean): ReportedCost => ({
  kind,
  usd: 0.01,
  parts: [],
  settled,
  attribution: "per-sandbox",
  storage: "unknown",
  assumptions: [],
});

const estimate: ReportedCost = { kind: "estimate", usd: 0.01, parts: [], assumptions: [] };

it("settles only billed charges; a complete meter stays unreconciled", () => {
  // Upstash: billed and final.
  expect(heldStatus([charge("billed", true), charge("billed", true)])).toBe("settled");
  // Daytona: billed, not final yet.
  expect(heldStatus([charge("billed", true), charge("billed", false)])).toBe("unsettled");
  // E2B, boxd, Vercel: complete usage meters at list price, never reconciled with a bill.
  expect(heldStatus([charge("metered", true), charge("metered", true)])).toBe(
    "metered, unreconciled (provisional)",
  );
  // Boat: meter read while the sandbox still ran.
  expect(heldStatus([charge("metered", false)])).toBe(
    "unsettled; metered, unreconciled (provisional)",
  );
  expect(heldStatus([estimate])).toBe("estimate");
  expect(heldStatus([])).toBeNull();
});
