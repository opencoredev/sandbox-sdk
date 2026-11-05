import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attemptBillingSchema, costedAttempts, elapsedSeconds } from "../src/cost/attempt-input.js";
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

    // E2B's open-edge listing (the slot's health check) fails once in batch 1: an unavailable slot.
    let outage = false;

    const providers = hosts.map((host, index): SlotProvider => {
      const name = names[index] ?? "upstash";

      return {
        name,
        provider: host,
        ...attributionFor(name),
        paddingMs: 0,
        listAccount: async () => {
          if (name === "e2b" && outage) {
            outage = false;
            throw new Error("health check failed");
          }

          return (await host.list({})).map((item) => item.id);
        },
      };
    });

    const lines: string[] = [];

    for (let batch = 0; batch < 3; batch++) {
      outage = batch === 1;

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
    }

    // What attempts.jsonl holds, read back through the harness's own schema.
    const records = lines.map((line) => attemptRecordSchema.parse(JSON.parse(line)));

    expect(records.map((r) => [r.batch, r.provider, r.completion.kind])).toEqual([
      [0, "upstash", "completed"],
      [0, "e2b", "completed"],
      [1, "upstash", "completed"],
      [1, "e2b", "incomplete"],
      [2, "upstash", "completed"],
      [2, "e2b", "completed"],
    ]);

    // Billing collection has entries only for attempts that made a sandbox: Upstash bills, E2B meters.
    const billing = records.flatMap((r) =>
      r.sandboxIds.length === 0
        ? []
        : [
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
                  ? { kind: "billed", usd: 0.01, settled: true, source: "fixture" }
                  : { kind: "metered", usd: 0.02, settled: true, source: "fixture" },
            }),
          ],
    );

    const attempts = costedAttempts(records, billing);
    const outageAttempt = attempts.find((a) => a.record.batch === 1 && a.record.provider === "e2b");

    expect(outageAttempt).toMatchObject({
      outcome: "incomplete",
      attribution: "none",
      charge: { kind: "no-sandbox" },
    });

    expect(outageAttempt?.record.completion).toMatchObject({ reason: "unavailable" });

    // Lifecycle comes from the record's own create and destroy spans, and elapsed time ends at
    // confirmed deletion.
    for (const a of attempts.filter((x) => x.record.sandboxIds.length > 0)) {
      const create = a.record.phases.find((p) => p.name === "create");
      const destroy = a.record.phases.find((p) => p.name === "destroy");

      expect(a.attribution).toBe("per-sandbox");
      expect(a.record.deletionConfirmed).toBe(true);

      expect(a.lifecycle).toEqual({
        createdAt: create?.endedAt,
        deleteRequestedAt: destroy?.startedAt,
        deletedAt: destroy?.endedAt,
      });

      expect(elapsedSeconds(a)).toBe(((destroy?.endedAt ?? 0) - a.record.startedAt) / 1000);
    }

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
          reportedUSD: 0.04,
          settledUSD: 0.041,
        },
        resolutionUSDPerAttempt: 0,
        provisional: null,
      },
    };

    const rule = (name: (typeof names)[number]) => {
      const found = billingRule(name, null);

      if (!found) throw new Error(`No rule for ${name}`);

      return found;
    };

    const groups = names.map((name) => {
      const mine = attempts.filter((a) => a.record.provider === name);

      const costUSD = new Map(
        mine.map((a) => {
          const cost = reportedCost({ attempt: a, rule: rule(name), fx });

          return [a.record.attemptId, cost.kind === "unavailable" ? NaN : cost.usd];
        }),
      );

      return { provider: name, attempts: mine, costUSD };
    });

    // Batches pair across providers: E2B's outage batch is present with no completion.
    const rows = pairedBatches(groups);
    expect(rows.map((r) => r.batches.map((b) => b.completions))).toEqual([
      [1, 1, 1],
      [1, 0, 1],
    ]);

    expect(rows[1]?.batches[1]?.costUSD).toBe(0);

    const candidates: Candidate[] = groups.map((group, index) => ({
      provider: group.provider,
      batches: rows[index]?.batches ?? [],
      eligibility: eligibility({
        rule: rule(group.provider),
        comparison: "same-machine",
        attempts: group.attempts,
        audit: audits[group.provider],
      }),
      audit: audits[group.provider],
    }));

    // One unavailable slot is within the at-most-one-incomplete rule.
    expect(candidates.map((c) => [c.provider, c.eligibility.kind])).toEqual([
      ["upstash", "eligible"],
      ["e2b", "eligible"],
    ]);

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
