import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attemptBillingSchema, costedAttempts } from "../src/cost/attempt-input.js";
import { pairedBatches } from "../src/cost/batch-stats.js";
import { billingRule } from "../src/cost/billing-rules.js";
import { reportedCost } from "../src/cost/columns.js";
import { eligibility, type CostSourceAudit } from "../src/cost/eligibility.js";
import { PICK_LABEL, pick, type Candidate } from "../src/cost/picks.js";
import { systemClock } from "../src/realistic/gaps.js";
import { attemptRecordSchema } from "../src/realistic/record.js";
import {
  attributionFor,
  runBatch,
  type SlotProvider,
  type SlotSpec,
} from "../src/realistic/slots.js";
import { buildFixture, type Fixture } from "./realistic/fixture.js";
import { hostProvider, type HostProvider } from "./realistic/host-provider.js";

const headline: SlotSpec = {
  id: "fat-same",
  profile: "fix-and-test",
  track: "same-machine",
  variant: "headline",
};

const fx = { eurToUsd: 1.08, date: "2026-11-05" };

let fixture: Fixture;
let hosts: HostProvider[] = [];

beforeAll(async () => {
  fixture = await buildFixture();
  hosts = [await hostProvider(), await hostProvider()];
});

afterAll(async () => {
  await Promise.all(hosts.map((h) => h.dispose()));
  await fixture.cleanup();
});

describe("harness records through the cost model", () => {
  it("flows scheduler records from the host-provider fixture through eligibility and picks", async () => {
    // Two real providers' names, so their billing rules and attribution apply; the sandboxes are
    // the host-process fake, so no cloud is touched.
    const names = ["upstash", "e2b"] as const;

    const providers = hosts.map(
      (host, index): SlotProvider => ({
        name: names[index] ?? "upstash",
        provider: host,
        ...attributionFor(names[index] ?? "upstash"),
        paddingMs: 0,
        listAccount: async () => (await host.list({})).map((item) => item.id),
      }),
    );

    const lines: string[] = [];

    for (let batch = 0; batch < 3; batch++)
      await runBatch({
        runId: "rw-cost-e2e",
        batch,
        seed: 42,
        manifest: fixture.manifest,
        manifestSha256: null,
        slots: [headline],
        providers,
        clock: systemClock,
        blobs: fixture.blobs,
        prepare: { cacheBaseUrl: fixture.cacheBaseUrl },
        onRecord: async (record) => {
          lines.push(JSON.stringify(record));
        },
      });

    // What attempts.jsonl holds, read back through the harness's own schema.
    const records = lines.map((line) => attemptRecordSchema.parse(JSON.parse(line)));
    expect(records).toHaveLength(6);
    expect(
      records.every((r) => r.completion.kind === "completed" && r.sandboxIds.length === 1),
    ).toBe(true);

    // Billing collection's entries for the same attempts: Upstash bills, E2B meters.
    const billing = records.map((r) =>
      attemptBillingSchema.parse({
        attemptId: r.attemptId,
        product: null,
        allocation: {
          provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 10 },
          measured: { cpuQuota: 4, memoryGiB: 7.8 },
        },
        usage: null,
        charge:
          r.provider === "upstash"
            ? { kind: "billed", usd: 0.01 + r.batch * 0.0001, settled: true, source: "fixture" }
            : { kind: "metered", usd: 0.02 + r.batch * 0.0001, settled: true, source: "fixture" },
      }),
    );

    const attempts = costedAttempts(records, billing);
    expect(attempts.map((a) => a.attribution)).toEqual(records.map(() => "per-sandbox"));
    expect(attempts.every((a) => a.lifecycle.deletedAt !== null)).toBe(true);

    const audits: Record<(typeof names)[number], CostSourceAudit> = {
      upstash: {
        reconciliation: { kind: "not-reconciled", reason: "billed per sandbox" },
        resolutionUSDPerAttempt: 0,
        provisional: null,
      },
      e2b: {
        reconciliation: {
          kind: "reconciled",
          window: "profile-track",
          reportedUSD: 0.06,
          settledUSD: 0.061,
        },
        resolutionUSDPerAttempt: 0,
        provisional: null,
      },
    };

    const candidates: Candidate[] = names.map((name) => {
      const rule = billingRule(name, null);

      if (!rule) throw new Error(`No rule for ${name}`);
      const mine = attempts.filter((a) => a.record.provider === name);

      const costUSD = new Map(
        mine.map((a) => {
          const cost = reportedCost({ attempt: a, rule, fx });

          return [a.record.attemptId, cost.kind === "unavailable" ? NaN : cost.usd];
        }),
      );

      const [row] = pairedBatches([{ provider: name, attempts: mine, costUSD }]);

      return {
        provider: name,
        batches: row?.batches ?? [],
        eligibility: eligibility({
          rule,
          comparison: "same-machine",
          attempts: mine,
          audit: audits[name],
        }),
        audit: audits[name],
      };
    });

    expect(candidates.map((c) => [c.provider, c.eligibility.kind])).toEqual([
      ["upstash", "eligible"],
      ["e2b", "eligible"],
    ]);

    expect(candidates.map((c) => c.batches.length)).toEqual([3, 3]);

    const verdict = pick({
      candidates,
      procedure: "centred-max-deviation",
      options: { replicates: 2000 },
    });

    expect(verdict).toMatchObject({
      kind: "lowest-verified-cost",
      label: PICK_LABEL,
      provider: "upstash",
      eligible: ["upstash", "e2b"],
    });

    for (const host of hosts) expect(await host.list({})).toEqual([]);
  }, 120_000);
});
