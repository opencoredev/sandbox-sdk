import { expect, it } from "vitest";
import { parseChargeLines, sandboxChargeDay, type ChargeLine } from "../src/cost/vercel-charges.js";

const period = { start: "2026-11-16T08:00:00.000Z", end: "2026-11-17T08:00:00.000Z" };
const teamId = "team_1";
const project = { id: "prj_1", name: "sandbox-bench-runner" };
const ours = { ProjectId: "prj_1", ProjectName: "sandbox-bench-runner" };

const line = (over: Partial<ChargeLine>): ChargeLine => ({
  BilledCost: 0,
  EffectiveCost: 0,
  BillingCurrency: "USD",
  ChargePeriodStart: period.start,
  ChargePeriodEnd: period.end,
  ServiceName: "Sandbox Active CPU",
  ServiceCategory: "Sandbox",
  ConsumedQuantity: 0,
  ConsumedUnit: "hour",
  RegionId: "iad1",
  SubAccountId: teamId,
  Tags: {},
  ...over,
});

// One day of our sandboxes: CPU, memory, transfer and 20 creations, plus zero lines for other
// regions (Vercel lists every region) and a non-sandbox service, which are ignored.
const day = [
  line({ BilledCost: 0.4, EffectiveCost: 0.4, ConsumedQuantity: 3.1, Tags: ours }),
  line({ RegionId: "arn1" }),
  line({
    ServiceName: "Sandbox Provisioned Memory",
    ConsumedUnit: "gigabyte-hour",
    BilledCost: 0.9,
    EffectiveCost: 0.9,
    ConsumedQuantity: 42.5,
    Tags: ours,
  }),
  line({
    ServiceName: "Sandbox Data Transfer",
    ConsumedUnit: "gigabyte",
    BilledCost: 0.6,
    EffectiveCost: 0.6,
    ConsumedQuantity: 4,
    Tags: ours,
  }),
  line({
    ServiceName: "Sandbox Creations",
    ConsumedUnit: "Creations",
    RegionId: null,
    BilledCost: 0.000012,
    EffectiveCost: 0.000012,
    ConsumedQuantity: 20,
    Tags: ours,
  }),
  line({
    ServiceName: "Speed Insights Plus Events",
    ServiceCategory: "Observability",
    BilledCost: 5,
  }),
];

const input = { lines: day, teamId, project, period, sandboxes: 20 };

it("totals a day that holds only our sandboxes, every Sandbox service included", () => {
  const result = sandboxChargeDay(input);

  expect(result.kind).toBe("isolated");

  if (result.kind !== "isolated") return;
  expect(result.settledUSD).toBeCloseTo(0.4 + 0.9 + 0.6 + 0.000012, 12);
  expect(result.creations).toBe(20);
  expect(result.services.find((s) => s.service === "Sandbox Data Transfer")).toMatchObject({
    usd: 0.6,
    quantity: 4,
    unit: "gigabyte",
  });
});

it("refuses a day with more creations than the run's sandboxes (the 2026-11-09 case)", () => {
  const result = sandboxChargeDay({ ...input, sandboxes: 19 });

  expect(result).toMatchObject({
    kind: "not-isolated",
    reasons: [expect.stringContaining("20 sandbox creations and the run created 19")],
  });
});

it("refuses sandbox charges for another project, an untagged one, or another team", () => {
  const other = { ProjectId: "prj_2", ProjectName: "someone-else" };

  for (const extra of [
    line({ BilledCost: 0.01, EffectiveCost: 0.01, ConsumedQuantity: 0.1, Tags: other }),
    line({ ConsumedQuantity: 0.1 }),
    line({ SubAccountId: "team_2" }),
  ])
    expect(sandboxChargeDay({ ...input, lines: [...day, extra] }).kind).toBe("not-isolated");
});

it("refuses a line for another period, an unknown Sandbox service, or a non-USD bill", () => {
  for (const extra of [
    line({
      ChargePeriodStart: "2026-11-17T08:00:00.000Z",
      ChargePeriodEnd: "2026-11-18T08:00:00.000Z",
    }),
    line({ ServiceName: "Sandbox GPU" }),
    line({ BillingCurrency: "EUR" }),
    line({ ConsumedQuantity: null, ConsumedUnit: null }),
  ])
    expect(sandboxChargeDay({ ...input, lines: [...day, extra] }).kind).toBe("not-isolated");
});

it("refuses a period that is not one charge day and an export with no Sandbox lines", () => {
  expect(
    sandboxChargeDay({ ...input, period: { ...period, end: "2026-11-17T09:00:00.000Z" } }).kind,
  ).toBe("not-isolated");
  expect(sandboxChargeDay({ ...input, lines: [], sandboxes: 0 }).kind).toBe("not-isolated");
});

it("parses Vercel's JSONL and names the line that does not parse", () => {
  const jsonl = day.map((l) => JSON.stringify({ ...l, SkuId: "ignored" })).join("\n") + "\n";

  expect(parseChargeLines(jsonl)).toHaveLength(day.length);
  expect(() => parseChargeLines(`${jsonl}{"BilledCost":"x"}\n`)).toThrow(
    `charges line ${day.length + 1}`,
  );
});
