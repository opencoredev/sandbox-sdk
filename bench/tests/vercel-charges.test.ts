import { describe, expect, it } from "vitest";
import {
  parseChargeLines,
  receiptProblems,
  SANDBOX_SERVICES,
  sandboxChargeDay,
  type ChargeLine,
  type SandboxService,
} from "../src/cost/vercel-charges.js";

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

const units: Record<SandboxService, string> = {
  "Sandbox Active CPU": "hour",
  "Sandbox Provisioned Memory": "gigabyte-hour",
  "Sandbox Creations": "Creations",
  "Sandbox Data Transfer": "gigabyte",
  "Snapshot Storage": "gigabyte",
  "Drive Storage": "gigabyte",
  "Drive Reads": "gigabyte",
  "Drive Writes": "gigabyte",
};

const global = new Set<SandboxService>(["Sandbox Creations", "Snapshot Storage"]);

// What Vercel lists when nothing ran or was stored: every service, regional ones in each region.
const zeros = (from: string, to: string) =>
  SANDBOX_SERVICES.flatMap((service) =>
    (global.has(service) ? [null] : ["iad1", "arn1"]).map((RegionId) =>
      line({
        ServiceName: service,
        ConsumedUnit: units[service],
        RegionId,
        ChargePeriodStart: from,
        ChargePeriodEnd: to,
      }),
    ),
  );

// One day of our sandboxes: CPU, memory, transfer and 20 creations, plus zero lines for other
// regions (Vercel lists every region) and a non-sandbox service, which are ignored.
const day = [
  ...zeros(period.start, period.end),
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

const previous = { start: "2026-11-15T08:00:00.000Z", end: period.start };

const quietDay = zeros(previous.start, previous.end);

const input = { lines: day, teamId, project, period, sandboxes: 20, previousDay: quietDay };

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

it("refuses a day with the right creation count when older resources were still billing before it", () => {
  // An older snapshot, still stored the day before, bills storage into our day without a creation.
  const stored = line({
    ServiceName: "Snapshot Storage",
    ConsumedUnit: "gigabyte",
    RegionId: null,
    ChargePeriodStart: previous.start,
    ChargePeriodEnd: previous.end,
    BilledCost: 0.0001,
    EffectiveCost: 0.0001,
    ConsumedQuantity: 0.05,
    Tags: ours,
  });

  // A sandbox from an earlier run still running at the day's start.
  const running = line({
    ChargePeriodStart: previous.start,
    ChargePeriodEnd: previous.end,
    BilledCost: 0.02,
    EffectiveCost: 0.02,
    ConsumedQuantity: 0.15,
    Tags: ours,
  });

  for (const extra of [stored, running])
    expect(sandboxChargeDay({ ...input, previousDay: [...quietDay, extra] })).toMatchObject({
      kind: "not-isolated",
      reasons: [expect.stringContaining("on the day before charged")],
    });
});

it("refuses a missing or wrong export for the day before", () => {
  expect(sandboxChargeDay({ ...input, previousDay: [] }).kind).toBe("not-isolated");
  expect(sandboxChargeDay({ ...input, previousDay: day }).kind).toBe("not-isolated");
});

it("refuses an export of the day before that misses a service or region the day lists", () => {
  // A truncated export: the Snapshot Storage line, which could carry an older snapshot, is missing.
  const truncated = quietDay.filter((l) => l.ServiceName !== "Snapshot Storage");
  const noArn1 = quietDay.filter((l) => l.RegionId !== "arn1");

  for (const previousDay of [truncated, noArn1])
    expect(sandboxChargeDay({ ...input, previousDay })).toMatchObject({
      kind: "not-isolated",
      reasons: expect.arrayContaining([expect.stringContaining("may be incomplete")]),
    });
});

it("refuses a day whose own export misses a Sandbox service", () => {
  const lines = day.filter((l) => l.ServiceName !== "Drive Storage");

  expect(sandboxChargeDay({ ...input, lines })).toMatchObject({
    kind: "not-isolated",
    reasons: [expect.stringContaining("does not list Drive Storage")],
  });
});

describe("export receipts", () => {
  const receipt = {
    url: `/api/v1/billing/charges?teamId=${teamId}&from=${period.start}&to=${period.end}`,
    status: 200,
    bytes: 1234,
    sha256: "a".repeat(64),
    fetchedAt: "2026-11-17T10:00:00.000Z",
  };

  const check = (over: Partial<typeof receipt>, body = { bytes: 1234, sha256: "a".repeat(64) }) =>
    receiptProblems({ receipt: { ...receipt, ...over }, body, teamId, period, label: "export" });

  it("accepts the body the browser received for the settled day", () => {
    expect(check({})).toEqual([]);
  });

  it("refuses a saved file that lost a row on the way, even one zero-valued look-alike row", () => {
    // Dropping a charged Snapshot Storage row and keeping its zero twin leaves every key in place,
    // so only the body's length and hash can tell.
    expect(check({}, { bytes: 1100, sha256: "b".repeat(64) })).toEqual([
      expect.stringContaining("not the body the browser received"),
    ]);
  });

  it("refuses an error response, another day or team, and an export read too early", () => {
    expect(check({ status: 403 })).toEqual([expect.stringContaining("HTTP 403")]);
    expect(check({ url: receipt.url.replace("2026-11-16T08", "2026-11-15T08") })).toEqual([
      expect.stringContaining("not 2026-11-16T08:00:00.000Z"),
    ]);
    expect(check({ url: receipt.url.replace(teamId, "team_2") })).toHaveLength(1);
    expect(check({ fetchedAt: "2026-11-17T09:00:00.000Z" })).toEqual([
      expect.stringContaining("less than 2 hours"),
    ]);
  });
});
