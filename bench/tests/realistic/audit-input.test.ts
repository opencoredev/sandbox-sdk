import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AttemptBilling } from "../../src/cost/attempt-input.js";
import { AUDIT_SCHEMA, auditFileSchema, auditFor } from "../../src/cost/audit-file.js";
import { realisticCommand } from "../../src/realistic/cli.js";
import { at, attempt, type AttemptSpec } from "../cost-fixtures.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rw-audit-input-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const meter = (usd: number): AttemptBilling["charge"] => ({
  kind: "metered",
  usd,
  settled: true,
  source: "fixture meter",
});

/** Five completed boxd default-track attempts, $0.01 of metered usage each, 300 s apart. */
function boxdGroup(patch: AttemptSpec = {}) {
  return Array.from({ length: 5 }, (_, batch) =>
    attempt({
      attemptId: `boxd-${patch.profile ?? "fix-and-test"}-${patch.variant ?? "headline"}-${batch}`,
      provider: "boxd",
      track: "default",
      attribution: "per-machine",
      batch,
      charge: meter(0.01),
      ...patch,
    }),
  );
}

const period = { start: new Date(at(-60)).toISOString(), end: new Date(at(400)).toISOString() };

type AuditInput = z.input<typeof auditFileSchema>;

type Entry = AuditInput["entries"][number];

type Reconciled = Extract<Entry, { kind: "reconciled" }>;

const reconciled = (patch: Partial<Reconciled> = {}): Reconciled => ({
  kind: "reconciled",
  provider: "boxd",
  profile: "fix-and-test",
  track: "default",
  window: "profile-track",
  reportedUSD: 0.05,
  settledUSD: 0.052,
  source: "fixture charges API",
  period,
  isolation: "fixture: no other machine in the org",
  checkedAt: "2026-11-16",
  ...patch,
});

const file = (...entries: Entry[]) => auditFileSchema.parse({ schema: AUDIT_SCHEMA, entries });

describe("audit file", () => {
  it("leaves a provider with no entry not reconciled", () => {
    const group = boxdGroup();

    const { audit, used } = auditFor({
      file: file(),
      group: { provider: "boxd", profile: "fix-and-test", track: "default" },
      attempts: group,
      providerAttempts: group,
    });

    expect(audit.reconciliation.kind).toBe("not-reconciled");
    expect(used.kind).toBe("none");
  });

  it("passes a reconciliation whose reported total is our loaded metered total", () => {
    const group = boxdGroup();

    const { audit } = auditFor({
      file: file(reconciled()),
      group: { provider: "boxd", profile: "fix-and-test", track: "default" },
      attempts: group,
      providerAttempts: group,
    });

    expect(audit.reconciliation).toEqual({
      kind: "reconciled",
      window: "profile-track",
      reportedUSD: 0.05,
      settledUSD: 0.052,
    });
  });

  it("refuses a reported total that is not ours", () => {
    const group = boxdGroup();

    expect(() =>
      auditFor({
        file: file(reconciled({ reportedUSD: 0.052 })),
        group: { provider: "boxd", profile: "fix-and-test", track: "default" },
        attempts: group,
        providerAttempts: group,
      }),
    ).toThrow(/not our metered total/);
  });

  it("refuses a period that misses an attempt or that an attempt straddles", () => {
    const group = boxdGroup();
    const short = { start: period.start, end: new Date(at(200)).toISOString() };

    expect(() =>
      auditFor({
        file: file(reconciled({ period: short })),
        group: { provider: "boxd", profile: "fix-and-test", track: "default" },
        attempts: group,
        providerAttempts: group,
      }),
    ).toThrow(/does not cover every attempt/);

    const late = attempt({
      provider: "boxd",
      variant: "held-open",
      endedAt: 900,
      charge: meter(1),
    });

    expect(() =>
      auditFor({
        file: file(reconciled({ window: "mixed-profiles" })),
        group: { provider: "boxd", profile: "fix-and-test", track: "default" },
        attempts: group,
        providerAttempts: [...group, late],
      }),
    ).toThrow(/straddles/);
  });

  it("refuses an isolated window that also held other runs, and totals them in a mixed one", () => {
    const group = boxdGroup();
    const other = boxdGroup({ profile: "build", charge: meter(0.02) });
    const providerAttempts = [...group, ...other];
    const target = { provider: "boxd", profile: "fix-and-test", track: "default" };

    expect(() =>
      auditFor({ file: file(reconciled()), group: target, attempts: group, providerAttempts }),
    ).toThrow(/mixed-profiles/);

    // The period's charge covers both profiles, so our side is both profiles' meters: $0.15.
    expect(() =>
      auditFor({
        file: file(reconciled({ window: "mixed-profiles" })),
        group: target,
        attempts: group,
        providerAttempts,
      }),
    ).toThrow(/0\.15/);

    const { audit } = auditFor({
      file: file(reconciled({ window: "mixed-profiles", reportedUSD: 0.15, settledUSD: 0.15 })),
      group: target,
      attempts: group,
      providerAttempts,
    });

    expect(audit.reconciliation.kind).toBe("reconciled");
  });

  it("refuses a period holding an attempt with no cost", () => {
    const group = boxdGroup();

    const unknown = attempt({
      provider: "boxd",
      variant: "held-open",
      charge: { kind: "unavailable", reason: "fixture" },
    });

    expect(() =>
      auditFor({
        file: file(reconciled({ window: "mixed-profiles" })),
        group: { provider: "boxd", profile: "fix-and-test", track: "default" },
        attempts: group,
        providerAttempts: [...group, unknown],
      }),
    ).toThrow(/no metered cost/);
  });

  it("rejects two entries for one group and a reconciliation without its evidence", () => {
    expect(() => file(reconciled(), reconciled())).toThrow(/two entries/);
    expect(() => file(reconciled({ isolation: "" }))).toThrow();
    expect(() => file(reconciled({ source: undefined }))).toThrow();
  });
});

const summaryJson = z.object({
  rows: z.array(
    z.object({
      provider: z.string(),
      profile: z.string(),
      track: z.string(),
      eligibility: z.string(),
    }),
  ),
  audits: z.array(
    z.object({ provider: z.string(), audit: z.object({ kind: z.string() }).loose() }),
  ),
});

/** A run folder with the group's records and billing, as `realistic run` and `billing` write them. */
async function runDir(
  name: string,
  attempts: ReturnType<typeof boxdGroup>,
  /** Attempts written under another run ID, such as a run superseded by a rerun. */
  runIdOf: (attemptId: string) => string = () => "fixture",
) {
  const out = join(root, name);
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "attempts.jsonl"),
    attempts
      .map((a) => JSON.stringify({ ...a.record, runId: runIdOf(a.record.attemptId) }))
      .join("\n") + "\n",
  );
  await writeFile(
    join(out, "billing.jsonl"),
    attempts
      .map((a) =>
        JSON.stringify({
          attemptId: a.record.attemptId,
          product: null,
          allocation: a.allocation,
          usage: null,
          charge: a.charge,
        }),
      )
      .join("\n") + "\n",
  );

  return out;
}

async function summarize(out: string, audit?: AuditInput, extra: string[] = []) {
  const args = ["summary", "--out", out, "--to", out, ...extra];

  if (audit !== undefined) {
    await writeFile(join(out, "audit.json"), JSON.stringify(audit));
    args.push("--audit", join(out, "audit.json"));
  }

  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await realisticCommand(args);

  return summaryJson.parse(JSON.parse(await readFile(join(out, "summary.json"), "utf8")));
}

describe("realistic summary --audit", () => {
  it("keeps a meter provisional without an audit file", async () => {
    const out = await runDir("no-audit", boxdGroup());
    const { rows, audits } = await summarize(out);

    expect(rows[0]?.eligibility).toMatch(
      /meter not reconciled with settled charges: no settled-charge/,
    );
    expect(audits).toEqual([
      expect.objectContaining({
        provider: "boxd",
        audit: expect.objectContaining({ kind: "none" }),
      }),
    ]);
  });

  it("makes a meter eligible only when its settled charge reconciles within 10%", async () => {
    const out = await runDir("reconciled", boxdGroup());

    const within = await summarize(out, { schema: AUDIT_SCHEMA, entries: [reconciled()] });
    expect(within.rows[0]?.eligibility).toBe("eligible");
    expect(within.audits[0]?.audit).toEqual(
      expect.objectContaining({ kind: "reconciled", settledUSD: 0.052 }),
    );

    // $0.05 of meter against a $0.04 settled charge is a 25% residual: still not verified.
    const wide = await summarize(out, {
      schema: AUDIT_SCHEMA,
      entries: [reconciled({ settledUSD: 0.04 })],
    });

    expect(wide.rows[0]?.eligibility).toMatch(/settled charges differ by 25\.0%/);
  });

  it("records a not-reconciled entry's reason and refuses an entry that is not our total", async () => {
    const out = await runDir("blocked", boxdGroup());

    const blocked = await summarize(out, {
      schema: AUDIT_SCHEMA,
      entries: [
        {
          kind: "not-reconciled",
          provider: "boxd",
          profile: null,
          track: null,
          reason: "fixture: charges visible only in the dashboard",
          source: null,
          blocked: "open the dashboard",
          checkedAt: "2026-11-16",
        },
      ],
    });

    expect(blocked.rows[0]?.eligibility).toMatch(/fixture: charges visible only in the dashboard/);

    await expect(
      summarize(out, { schema: AUDIT_SCHEMA, entries: [reconciled({ reportedUSD: 0.06 })] }),
    ).rejects.toThrow(/not our metered total/);
  });
});

describe("realistic summary --audit with --drop", () => {
  it("checks a reconciliation's period against dropped runs too", async () => {
    // A superseded build run ($0.10 of meters) shares the period with the kept fix-and-test one.
    const superseded = boxdGroup({ profile: "build", charge: meter(0.02) });

    const out = await runDir("dropped", [...boxdGroup(), ...superseded], (id) =>
      superseded.some((a) => a.record.attemptId === id) ? "old" : "fixture",
    );

    const audit = (reportedUSD: number, settledUSD: number): AuditInput => ({
      schema: AUDIT_SCHEMA,
      entries: [reconciled({ window: "mixed-profiles", reportedUSD, settledUSD })],
    });

    // Leaving the dropped run out of our side would hide $0.10 of the period's settled charge.
    await expect(summarize(out, audit(0.05, 0.05), ["--drop", "boxd@old"])).rejects.toThrow(
      /not our metered total for the period, 0\.15/,
    );

    const { rows } = await summarize(out, audit(0.15, 0.15), ["--drop", "boxd@old"]);

    expect(rows.map((r) => [r.profile, r.eligibility])).toEqual([["fix-and-test", "eligible"]]);
  });

  it("joins dropped runs only for a reconciled entry, so other summaries read as before", async () => {
    const out = await runDir("orphan", boxdGroup());

    const orphan = {
      attemptId: "gone",
      product: null,
      allocation: boxdGroup()[0]?.allocation,
      usage: null,
      charge: meter(1),
    };

    await writeFile(
      join(out, "billing.jsonl"),
      (await readFile(join(out, "billing.jsonl"), "utf8")) + JSON.stringify(orphan) + "\n",
    );

    expect((await summarize(out)).rows.map((r) => r.provider)).toEqual(["boxd"]);

    // A reconciliation cannot vouch for a period whose billing names an attempt nobody recorded.
    await expect(
      summarize(out, { schema: AUDIT_SCHEMA, entries: [reconciled()] }),
    ).rejects.toThrow();
  });
});

describe("realistic billing --providers", () => {
  const e2bEntry = {
    attemptId: "keep-e2b",
    product: null,
    allocation: {
      provisioned: { cpu: 4, memoryGiB: 8, diskGiB: 10 },
      measured: { cpuQuota: 4, memoryGiB: 8 },
    },
    usage: null,
    charge: {
      kind: "metered",
      usd: 0.123,
      settled: true,
      source: "events read before retention ended",
    },
  };

  // Spaced, with a trailing zero and a field the schema does not know: kept as this exact text.
  const keptLine = JSON.stringify({ ...e2bEntry, provenance: "collected 2026-11-06" }, null, 1)
    .replace(/\n/g, "")
    .replace("0.123", "0.1230");

  async function mixedDir(name: string, extra: AttemptSpec[] = []) {
    const out = join(root, name);
    await mkdir(out, { recursive: true });

    const records = [
      attempt({ attemptId: "keep-e2b", provider: "e2b" }),
      attempt({ attemptId: "redo-tenki", provider: "tenki" }),
      ...extra.map((spec) => attempt(spec)),
    ].map((a) => a.record);

    await writeFile(
      join(out, "attempts.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    await writeFile(
      join(out, "billing.jsonl"),
      [
        keptLine,
        JSON.stringify({
          ...e2bEntry,
          attemptId: "redo-tenki",
          charge: { kind: "unavailable", reason: "stale" },
        }),
      ].join("\n") + "\n",
    );
    await writeFile(
      join(out, "billing-sources.json"),
      JSON.stringify({
        collectedAt: "2026-11-06T04:41:58.738Z",
        providers: [{ provider: "e2b", sandboxes: 1 }],
      }),
    );

    return out;
  }

  it("recollects only the named providers and keeps every other entry and source row", async () => {
    const out = await mixedDir("partial");
    const fetch = vi.spyOn(globalThis, "fetch");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await realisticCommand(["billing", "--out", out, "--providers", "tenki"]);

    const lines = (await readFile(join(out, "billing.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(fetch).not.toHaveBeenCalled();
    expect(lines.map((l) => l.attemptId)).toEqual(["keep-e2b", "redo-tenki"]);
    expect((await readFile(join(out, "billing.jsonl"), "utf8")).split("\n")[0]).toBe(keptLine);
    expect(lines[1].charge.kind).toBe("estimate");

    const sources = JSON.parse(await readFile(join(out, "billing-sources.json"), "utf8"));

    expect(sources.collectedAt).toBe("2026-11-06T04:41:58.738Z");
    expect(sources.providers).toEqual([{ provider: "e2b", sandboxes: 1 }]);
    expect(sources.recollected).toEqual([expect.objectContaining({ adapters: ["tenki"] })]);
  });

  it("changes nothing when the previous billing sources cannot be read", async () => {
    const out = await mixedDir("bad-sources");
    await writeFile(join(out, "billing-sources.json"), "{ not json");
    const before = await readFile(join(out, "billing.jsonl"), "utf8");

    await expect(
      realisticCommand(["billing", "--out", out, "--providers", "tenki"]),
    ).rejects.toThrow();
    expect(await readFile(join(out, "billing.jsonl"), "utf8")).toBe(before);
    expect(await readFile(join(out, "billing-sources.json"), "utf8")).toBe("{ not json");
  });

  it("refuses a provider with no attempts and half of a shared adapter", async () => {
    const out = await mixedDir("refuse", [
      { attemptId: "box", provider: "upstash" },
      { attemptId: "eph", provider: "upstash-ephemeral" },
    ]);

    await expect(
      realisticCommand(["billing", "--out", out, "--providers", "boat"]),
    ).rejects.toThrow(/names no attempts/);
    await expect(
      realisticCommand(["billing", "--out", out, "--providers", "upstash-ephemeral"]),
    ).rejects.toThrow(/must also name upstash/);
  });
});
