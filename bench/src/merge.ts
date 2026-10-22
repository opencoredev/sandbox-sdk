import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { fingerprintSchema } from "./fingerprint.js";
import type { HostSample, Sample } from "./v2-model.js";
import { attemptPolicySchema, selectAttempts, type AttemptPolicy } from "./attempts.js";
import { sizeSchema, trackSchema } from "./v2-config.js";
import { pricing } from "./pricing.js";
import { distribution, wilson } from "./v2-stats.js";
import { publicationHtml, publicationMarkdown } from "./publication-report.js";

import { failureOutcomeSchema } from "./failure.js";

const finite = z.number().finite();
const hostSchema: z.ZodType<HostSample> = z
  .object({
    timestamp: z.string(),
    load: z.array(finite),
    cpu: z.object({ user: finite, system: finite }).passthrough(),
    network: z.string(),
    cpuTicks: z.array(z.array(finite)),
  })
  .passthrough();
export const sampleSchema = z
  .object({
    track: trackSchema.optional(),
    requestedSize: sizeSchema.nullable().optional(),
    template: z.string().nullable().optional(),
    provider: z.string(),
    iteration: z.number().int().nonnegative(),
    scenario: z.string(),
    unit: z.string(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: finite.nonnegative(),
    sandboxId: z.string().nullable(),
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("sample"), value: finite }).passthrough(),
      failureOutcomeSchema.passthrough(),
      z.object({ kind: z.literal("skipped"), note: z.string() }).passthrough(),
      z
        .object({ kind: z.literal("blocked"), blocked_by: z.string(), note: z.string() })
        .passthrough(),
    ]),
    phases: z.record(z.string(), finite),
    hostBefore: hostSchema,
    hostAfter: hostSchema,
    headroom: z
      .object({
        normalizedLoad: finite,
        processCpuMs: finite,
        hostCpuBusy: finite.nullable(),
        rxBytesPerSecond: finite.nullable(),
        txBytesPerSecond: finite.nullable(),
        highLoad: z.boolean(),
      })
      .passthrough(),
    fingerprint: fingerprintSchema.passthrough().nullable(),
    estimatedCost: finite.nullable(),
    details: z.unknown(),
  })
  .passthrough() satisfies z.ZodType<Sample>;
const priceSchema = z.object({ currency: z.enum(["USD", "EUR"]) }).passthrough();
const sourceSchema = z
  .object({
    schemaVersion: z.literal(2),
    runId: z.string(),
    timestamp: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    config: z
      .object({ seed: z.number().int(), scenarios: z.array(z.string()), bursts: z.array(finite), track: trackSchema.optional(), size: z.record(z.string(), sizeSchema).optional(), template: z.record(z.string(), z.string()).optional() })
      .passthrough(),
    metadata: z.object({ harnessCommit: z.string(), sdkCommit: z.string() }).passthrough(),
    host: z.object({ cpu: z.string(), os: z.string(), runtime: z.string() }).passthrough(),
    providers: z.array(
      z
        .object({ name: z.string(), configuredRegion: z.string().nullable(), note: z.string() })
        .passthrough(),
    ),
    budgets: z.record(z.string(), z.unknown()),
    cleanup: z.array(z.unknown()),
    methodology: z.array(z.string()),
    pricing: z.record(z.string(), priceSchema),
    samples: z.array(sampleSchema),
  })
  .passthrough();
export type MergeSource = z.infer<typeof sourceSchema>;
export type Suite = "main" | "snapshot" | "burst";
export type FailureClass = "provider-account-limit" | "client-third-party" | "provider-operation";
export type MergedSample = z.infer<typeof sampleSchema> & {
  sourceRunId: string;
  sourceSampleIndex: number;
  sourceIteration: number;
  iterationNamespace: string;
  suite: Suite;
  failureClass: FailureClass | null;
};
export const publicationRuns = [
  "publication-002",
  "publication-002-tenki",
  "publication-002-daytona",
  "publication-002-upstash",
  "publication-snapshot-002",
  "publication-bursts-001",
  "publication-bursts-002-daytona",
];
export const discardedRun = {
  runId: "publication-001",
  reason:
    "Aborted: snapshot timeouts blocked Daytona; discarded in full, including successful rows.",
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function classifyFailure(
  sample: Pick<Sample, "provider" | "scenario" | "outcome">,
): FailureClass | null {
  if (sample.outcome.kind !== "failure") return null;
  const note = sample.outcome.note;
  if (sample.provider === "boat" && /reported quota/i.test(note)) return "provider-account-limit";
  // Only this observed concurrent-create error is assigned to the likely account limit.
  // Other Daytona invalid_argument errors remain operation failures.
  if (
    sample.provider === "daytona" &&
    /^burst-\d+\/cold$/.test(sample.scenario) &&
    /invalid_argument/.test(note)
  )
    return "provider-account-limit";
  if (sample.scenario === "network-mbps" && /HTTP Error 429|Connection reset by peer/.test(note))
    return "client-third-party";
  return "provider-operation";
}
function suiteFor(source: MergeSource): Suite {
  if (source.config.scenarios.includes("burst")) return "burst";
  if (source.config.scenarios.length === 1 && source.config.scenarios.includes("snapshot"))
    return "snapshot";
  return "main";
}
function namespace(sample: Sample) {
  const burst = /^(burst-\d+)\/(.+)$/.exec(sample.scenario);
  return burst ? `${burst[1]}/${burst[2] === "all-ready" ? "cohort" : "member"}` : "iteration";
}
export function reliability(rows: readonly MergedSample[]) {
  const successes = rows.filter((s) => s.outcome.kind === "sample").length;
  const failures = rows.filter((s) => s.outcome.kind === "failure");
  const classes = {
    "provider-account-limit": failures.filter((s) => s.failureClass === "provider-account-limit")
      .length,
    "client-third-party": failures.filter((s) => s.failureClass === "client-third-party").length,
    "provider-operation": failures.filter((s) => s.failureClass === "provider-operation").length,
  };
  return {
    successes,
    failures: failures.length,
    classes,
    raw: wilson(successes, successes + failures.length),
    excludingLimitsAndClient: wilson(successes, successes + classes["provider-operation"]),
    skipped: rows.filter((s) => s.outcome.kind === "skipped").length,
    blocked: rows.filter((s) => s.outcome.kind === "blocked").length,
  };
}
export function summarizeMerged(samples: MergedSample[], seed: number) {
  const groups = new Map<string, MergedSample[]>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.track ?? "default", sample.requestedSize ?? null, sample.template ?? null, sample.suite, sample.provider, sample.scenario, sample.unit]);
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((rows) => {
    const first = rows[0];
    if (!first) return [];
    return [
      {
        track: first.track ?? "default",
        requestedSize: first.requestedSize ?? null,
        template: first.template ?? null,
        suite: first.suite,
        provider: first.provider,
        scenario: first.scenario,
        unit: first.unit,
        stats: distribution(
          rows.flatMap((s) => (s.outcome.kind === "sample" ? [s.outcome.value] : [])),
          seed,
        ),
        reliability: reliability(rows),
        comparable: first.scenario !== "network-mbps",
      },
    ];
  });
}
export function mergeSources(inputs: MergeSource[], excluded = [discardedRun], seed = 45, attemptPolicy?: AttemptPolicy) {
  const seen = new Set<string>();
  const sources = inputs.filter((s) => !excluded.some((e) => e.runId === s.runId));
  const samples: MergedSample[] = [];
  const nextIteration = new Map<string, number>();
  const provenance = sources.map((source) => {
    if (seen.has(source.runId)) throw new Error(`Duplicate source run: ${source.runId}`);
    seen.add(source.runId);
    const suite = suiteFor(source);
    const mappings = new Map<string, Map<number, number>>();
    for (const s of source.samples) {
      const key = JSON.stringify([s.provider, namespace(s)]);
      const mapping = mappings.get(key) ?? new Map<number, number>();
      mapping.set(s.iteration, 0);
      mappings.set(key, mapping);
    }
    const iterationMappings = [...mappings].map(([key, mapping]) => {
      const [provider, domain] = z.tuple([z.string(), z.string()]).parse(JSON.parse(key));
      const start = nextIteration.get(provider) ?? 0;
      let next = start;
      for (const original of [...mapping.keys()].sort((a, b) => a - b))
        mapping.set(original, next++);
      nextIteration.set(provider, next);
      return {
        provider,
        namespace: domain,
        firstMergedIteration: start,
        count: mapping.size,
        mapping: Object.fromEntries(mapping),
      };
    });
    source.samples.forEach((s, sourceSampleIndex) => {
      const domain = namespace(s);
      const iteration = mappings.get(JSON.stringify([s.provider, domain]))?.get(s.iteration);
      if (iteration === undefined) throw new Error("Missing iteration mapping");
      samples.push({
        ...s,
        track: s.track ?? source.config.track ?? "default",
        requestedSize: s.requestedSize ?? source.config.size?.[s.provider] ?? null,
        template: s.template ?? source.config.template?.[s.provider] ?? null,
        iteration,
        sourceRunId: source.runId,
        sourceSampleIndex,
        sourceIteration: s.iteration,
        iterationNamespace: domain,
        suite,
        failureClass: classifyFailure(s),
      });
    });
    const { samples: _samples, summaries: _summaries, ...originalMetadata } = source;
    const lifetimeCosts = source.providers.map(p => {
      const lifetimes = source.samples.filter(s => s.provider === p.name && /(^|\/)sandbox-lifetime$/.test(s.scenario));
      const known = lifetimes.flatMap(s => s.estimatedCost === null ? [] : [s.estimatedCost]);
      return { provider: p.name, sourceRunId: source.runId, currency: source.pricing[p.name]?.currency ?? "unknown", known: sum(known), missing: lifetimes.length - known.length, lifetimes: lifetimes.length };
    });
    return { ...originalMetadata, sampleCount: source.samples.length, suite, iterationMappings, lifetimeCosts };
  });
  // Cohort aggregates inherit classification from their failed creates, without changing outcomes.
  for (const sample of samples) {
    if (sample.outcome.kind !== "failure" || !sample.scenario.endsWith("/all-ready")) continue;
    const k = Number(/^burst-(\d+)/.exec(sample.scenario)?.[1]);
    const failures = samples.filter(
      (s) =>
        s.sourceRunId === sample.sourceRunId &&
        s.provider === sample.provider &&
        s.scenario === `burst-${k}/cold` &&
        Math.floor(s.sourceIteration / k) === sample.sourceIteration &&
        s.outcome.kind === "failure",
    );
    if (failures.length && failures.every((s) => s.failureClass === "provider-account-limit"))
      sample.failureClass = "provider-account-limit";
  }
  const selection = attemptPolicy ? selectAttempts(samples, attemptPolicy) : { samples, removed: {} };
  return {
    attemptPolicy,
    selectionRemoved: selection.removed,
    schemaVersion: "publication-merge-v1" as const,
    runId: "publication-final",
    bootstrapSeed: seed,
    reportPricing: pricing,
    timestamp: sources.map((s) => s.timestamp).sort()[0] ?? null,
    finishedAt:
      sources
        .map((s) => s.finishedAt)
        .sort()
        .at(-1) ?? null,
    schema: {
      samples:
        "All v2 sample fields retained. iteration is remapped per provider; sourceIteration is original. sourceRunId + sourceSampleIndex uniquely identifies each raw row. sourceSampleIndex is zero-based in results.json/samples.ndjson. iterationNamespace distinguishes burst member and cohort identities. Scenarios for one original iteration retain their shared identity.",
      sources:
        "Original non-sample metadata, flags/config, commits, pricing, cleanup and budgets per source; original cached summaries omitted. iterationMappings documents every remapping.",
      summaries:
        "Recomputed by track/requested size/template/suite/provider/scenario/unit. Distributions use successes only; 2000 seeded bootstrap resamples, nearest-rank percentiles, Wilson success intervals. No outliers removed. Suite separation prevents pooling snapshot cold creates with main cold creates.",
      reliability:
        "Raw = successes / (successes + failures). Excluding limits/client = successes / (successes + provider-operation failures). Skipped and blocked rows are separate in both denominators. Aggregate rates count observations, including correlated/derived metrics, not unique sandbox reliability.",
      failureClass:
        "Only failure rows classified: provider-account-limit (Boat quota; Daytona burst invalid_argument, likely concurrency; aggregates inherit); client-third-party (network-mbps HTTP 429 or resets); provider-operation (all remaining operation failures, cause may be unresolved).",
      costs:
        "Use original-source sandbox-lifetime estimatedCost only, before attempt selection, including restored lifetime already charged there; do not sum scenario allocations. Unknown lifetime costs stay unknown. Native currency, no FX conversion. Recorded pricing per source retained; reportPricing captures the existing pricing code used for sandbox-hour and command-efficiency estimates; budgets.estimatedUSD is a harness guard, not spend.",
    },
    sources: provenance,
    excludedSources: excluded,
    inputSampleCount: sum(sources.map((s) => s.samples.length)),
    samples: selection.samples,
    summaries: summarizeMerged(selection.samples, seed),
  };
}
export type PublicationReport = ReturnType<typeof mergeSources>;
export type PublicationSummary = PublicationReport["summaries"][number];
export function publicationTrack(input: PublicationReport, track: "default" | "same-spec"): PublicationReport {
  return {
    ...input,
    samples: input.samples.filter(s => (s.track ?? "default") === track),
    summaries: input.summaries.filter(s => (s.track ?? "default") === track),
    sources: input.sources.filter(s => (s.config.track ?? "default") === track),
  };
}

export async function readSource(directory: string) {
  const source = sourceSchema.parse(
    JSON.parse(await readFile(join(directory, "results.json"), "utf8")),
  );
  const lines = (await readFile(join(directory, "samples.ndjson"), "utf8"))
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length !== source.samples.length)
    throw new Error(`${directory}: results.json/NDJSON count mismatch`);
  // Read one canonical copy, but reject divergent journals instead of silently picking one.
  for (const [i, line] of lines.entries()) {
    const journal = sampleSchema.parse(JSON.parse(line));
    if (JSON.stringify(journal) !== JSON.stringify(source.samples[i]))
      throw new Error(`${directory}: sample ${i} differs from NDJSON`);
  }
  return source;
}
export async function mergeCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string", default: "results/publication-final" },
      exclude: { type: "string", multiple: true },
      seed: { type: "string", default: "45" },
      policy: { type: "string" },
    },
  });
  const output = resolve(values.out);
  const paths = positionals.length ? positionals : publicationRuns.map((n) => join("results", n));
  if (paths.some((p) => resolve(p) === output))
    throw new Error("Output must not overwrite an input directory");
  const excluded = [
    discardedRun,
    ...(values.exclude ?? []).map((runId) => ({ runId, reason: "Explicit --exclude" })),
  ];
  const inputs: MergeSource[] = [];
  for (const path of paths) {
    if (excluded.some((e) => e.runId === basename(path))) continue;
    inputs.push(await readSource(path));
  }
  if (!inputs.length) throw new Error("No included result directories");
  const policy = values.policy ? attemptPolicySchema.parse(JSON.parse(await readFile(values.policy, "utf8"))) : undefined;
  const report = mergeSources(inputs, excluded, z.coerce.number().int().parse(values.seed), policy);
  report.runId = basename(output);
  if (report.samples.length + sum(Object.values(report.selectionRemoved)) !== report.inputSampleCount)
    throw new Error("Sample conservation failed");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "samples.ndjson"),
    report.samples.map((s) => JSON.stringify(s)).join("\n") + "\n",
  );
  await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  const tracks = [...new Set(report.samples.map(s => s.track ?? "default"))];
  const primaryTrack = tracks.includes("default") ? "default" : "same-spec";
  const primary = publicationTrack(report, primaryTrack);
  await writeFile(join(output, "results.md"), publicationMarkdown(primary));
  await writeFile(join(output, "index.html"), publicationHtml(primary));
  for (const track of tracks) {
    const selected = publicationTrack(report, track);
    await writeFile(join(output, `results.${track}.md`), publicationMarkdown(selected));
    await writeFile(join(output, `index.${track}.html`), publicationHtml(selected));
  }
  process.stdout.write(
    `Merged ${report.sources.length} runs; ${report.samples.length} / ${report.inputSampleCount} samples retained. Reports: ${output}\n`,
  );
}
