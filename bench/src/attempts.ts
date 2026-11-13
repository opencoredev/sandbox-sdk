import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { MergedSample, MergeSource, Suite } from "./merge.js";
import { attemptApp, type JournalApp } from "./modal-apps.js";
import { sampleSuite, suiteFor } from "./suite.js";

export const cloudProviders = [
  "e2b",
  "daytona",
  "upstash",
  "boat",
  "boxd",
  "freestyle",
  "tenki",
  "superserve",
  "modal",
  "vercel",
];

export const mainTests = [
  "cold",
  "command",
  "files-1kb",
  "files-10mb",
  "reconnect",
  "pause-resume",
  "destroy",
  "cpu-single",
  "cpu-all",
  "memory-mbps",
  "disk-write-mbps",
  "disk-read-mbps",
  "disk-4k-write-iops",
  "disk-4k-read-iops",
  "tcp-ms",
];

export const workloads = [
  "git-clone",
  "npm-install",
  "pip-install",
  "dev-server",
  "preview-first-byte",
  "edit-loop",
  "tool-replay",
];

const identity = z.object({
  provider: z.enum(cloudProviders),
  suite: z.enum(["main", "snapshot", "burst", "cost"]),
  scenario: z.string(),
  track: z.enum(["default", "same-spec"]).optional(),
});

/**
 * Iterations of one source run that a rerun replaces, with every sample they recorded, for failures
 * on our side that never reached the provider (SBX-103: Modal's 200-App limit stopped the App lookup
 * before any create). They are dropped as "superseded-by-rerun" and counted in selectionRemoved.
 */
const supersededIterations = z.object({
  provider: z.enum(cloudProviders),
  suite: z.enum(["main", "snapshot", "burst", "cost"]),
  track: z.enum(["default", "same-spec"]).optional(),
  sourceRunId: z.string().min(1),
  iterations: z.array(z.number().int().nonnegative()).min(1),
  rerunSourceRunIds: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
});

export const attemptPolicySchema = z.object({
  replacements: z.array(identity.extend({ sourceRunIds: z.array(z.string()).min(1) })),
  notRun: z.array(identity.extend({ reason: z.string().min(1) })),
  superseded: z.array(supersededIterations).optional(),
});

export type AttemptPolicy = z.infer<typeof attemptPolicySchema>;

/** Each source's ownership-journal Apps by run ID; a source missing from the map has no journal. */
export type SourceJournals = ReadonlyMap<string, readonly JournalApp[]>;

const completion = z.object({
  admissionStopped: z.array(z.unknown()).optional(),
  cleanupReview: z.array(z.unknown()).optional(),
});

const sameTrack = (a: string | undefined, b: string | undefined) =>
  (a ?? "default") === (b ?? "default");

/**
 * Why each superseded rule cannot be applied; empty when every rule is backed by evidence. A rule
 * for a source outside the merge removes nothing and is not checked. Otherwise it
 * stands only when the source's ownership journal shows each named iteration's App with no create
 * journaled and no sandbox (beginAllocation journals every create before it is submitted, so none
 * reached the provider), none of the iteration's samples names a sandbox, and each named rerun is
 * merged, completed (no stopped admission, no unresolved cleanup) and ran at least as many
 * iterations of the provider on the same track as it replaces.
 */
export function supersededRefusals({
  policy,
  sources,
  journals,
}: {
  policy: AttemptPolicy;
  sources: readonly MergeSource[];
  journals: SourceJournals;
}): string[] {
  return (policy.superseded ?? []).flatMap((rule) => {
    const origin = sources.find((s) => s.runId === rule.sourceRunId);

    // A rule for a run outside this merge (another track's) removes nothing.
    if (!origin) return [];
    const label = `superseded ${rule.provider}@${rule.sourceRunId}`;
    const refusals: string[] = [];
    const apps = journals.get(rule.sourceRunId);

    if (!apps) refusals.push(`${label}: source has no ownership journal`);

    for (const iteration of rule.iterations) {
      const name = attemptApp(rule.sourceRunId, iteration);
      const app = apps?.find((a) => a.provider === rule.provider && a.name === name);

      if (apps && !app) refusals.push(`${label}: iteration ${iteration} has no journaled App`);

      if (app && (app.allocations.length > 0 || app.sandboxes.length > 0))
        refusals.push(
          `${label}: iteration ${iteration} journaled ${app.allocations.length} create(s) and ${app.sandboxes.length} sandbox(es)`,
        );

      for (const s of origin.samples)
        if (
          s.provider === rule.provider &&
          s.iteration === iteration &&
          sameTrack(s.track ?? origin.config.track, rule.track) &&
          s.sandboxId !== null
        )
          refusals.push(`${label}: iteration ${iteration} recorded sandbox ${s.sandboxId}`);
    }

    for (const runId of rule.rerunSourceRunIds) {
      const rerun = sources.find((s) => s.runId === runId);

      if (!rerun || runId === rule.sourceRunId) {
        refusals.push(`${label}: rerun ${runId} is not among the merged sources`);
        continue;
      }

      const state = completion.parse(rerun);

      if (state.admissionStopped?.length || state.cleanupReview?.length)
        refusals.push(`${label}: rerun ${runId} did not complete`);

      // Only the rule's own suite counts: a snapshot-only rerun can't stand in for main-suite iterations.
      const rerunSuite = suiteFor(rerun);

      const ran = new Set(
        rerun.samples
          .filter(
            (s) =>
              s.provider === rule.provider &&
              sampleSuite(s.scenario, rerunSuite) === rule.suite &&
              sameTrack(s.track ?? rerun.config.track, rule.track) &&
              s.outcome.kind !== "skipped" &&
              s.outcome.kind !== "blocked",
          )
          .map((s) => s.iteration),
      ).size;

      if (ran < rule.iterations.length)
        refusals.push(
          `${label}: rerun ${runId} ran ${ran} ${rule.provider} ${rule.suite} iterations, fewer than the ${rule.iterations.length} it replaces`,
        );
    }

    return refusals;
  });
}

export function attemptTarget(suite: Suite, scenario: string): number | null {
  if (suite === "cost") return scenario === "tool-replay" ? 10 : null;

  if (suite === "main")
    return mainTests.includes(scenario) ? 100 : workloads.includes(scenario) ? 30 : null;

  if (suite === "snapshot")
    return ["snapshot", "create-from-snapshot"].includes(scenario) ? 30 : null;

  return /^burst-(10|25)\/all-ready$/.test(scenario) ? 3 : null;
}

export function isAttempt(s: Pick<MergedSample, "outcome">) {
  return s.outcome.kind === "sample" || s.outcome.kind === "failure";
}

function matches(s: z.infer<typeof identity>, rule: z.infer<typeof identity>) {
  return (
    (s.track ?? "default") === (rule.track ?? "default") &&
    s.provider === rule.provider &&
    s.suite === rule.suite &&
    (rule.scenario.endsWith("/*")
      ? s.scenario.startsWith(rule.scenario.slice(0, -1))
      : s.scenario === rule.scenario)
  );
}

export function selectAttempts(samples: MergedSample[], policy: AttemptPolicy) {
  const counts = new Map<string, number>();
  const removed = new Map<string, number>();
  const removedByTrack = new Map<string, Map<string, number>>();

  const drop = (reason: string, s: Pick<MergedSample, "track">) => {
    removed.set(reason, (removed.get(reason) ?? 0) + 1);
    const track = s.track ?? "default";
    const byReason = removedByTrack.get(track) ?? new Map<string, number>();
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    removedByTrack.set(track, byReason);

    return false;
  };

  const selected = [...samples]
    .sort(
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) ||
        a.sourceRunId.localeCompare(b.sourceRunId) ||
        a.sourceSampleIndex - b.sourceSampleIndex,
    )
    .filter((s) => {
      if (!cloudProviders.includes(s.provider)) return true;

      if (policy.replacements.some((r) => matches(s, r) && !r.sourceRunIds.includes(s.sourceRunId)))
        return drop("replaced-source", s);

      if (policy.notRun.some((r) => matches(s, r))) return drop("documented-not-run", s);

      if (
        (policy.superseded ?? []).some(
          (r) =>
            r.provider === s.provider &&
            r.suite === s.suite &&
            (r.track ?? "default") === (s.track ?? "default") &&
            r.sourceRunId === s.sourceRunId &&
            r.iterations.includes(s.sourceIteration),
        )
      )
        return drop("superseded-by-rerun", s);

      if (s.failureClass === "provider-account-limit" || s.failureClass === "client-third-party")
        return drop(s.failureClass, s);

      if (s.suite === "cost") return true; // Keep whole tasks; never select replay rows independently of billing IDs.
      const target = attemptTarget(s.suite, s.scenario);

      if (target === null || !isAttempt(s)) return true;
      const key = JSON.stringify([s.track ?? "default", s.provider, s.suite, s.scenario]);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);

      return count <= target || drop("above-target", s);
    });

  const cohorts = new Set(
    selected
      .filter((s) => /^burst-(10|25)\/all-ready$/.test(s.scenario))
      .map(
        (s) =>
          `${s.track ?? "default"}/${s.provider}/${s.sourceRunId}/${s.scenario.split("/")[0]}/${s.sourceIteration}`,
      ),
  );

  const complete = selected.filter((s) => {
    const burst = /^burst-(10|25)\/(?!all-ready$)/.exec(s.scenario);

    if (!burst || !cloudProviders.includes(s.provider)) return true;
    const identity = `${s.track ?? "default"}/${s.provider}/${s.sourceRunId}/burst-${burst[1]}/${Math.floor(s.sourceIteration / Number(burst[1]))}`;

    return cohorts.has(identity) || drop("unselected-cohort-member", s);
  });

  return {
    samples: complete,
    removed: Object.fromEntries(removed),
    removedByTrack: Object.fromEntries(
      [...removedByTrack].map(([track, byReason]) => [track, Object.fromEntries(byReason)]),
    ),
  };
}

export function checkAttempts(
  samples: MergedSample[],
  policy: AttemptPolicy,
  sourceTracks?: ("default" | "same-spec")[],
) {
  const tracks = [...new Set(sourceTracks ?? samples.map((s) => s.track ?? "default"))];

  if (!tracks.length)
    tracks.push(
      ...new Set([...policy.replacements, ...policy.notRun].map((r) => r.track ?? "default")),
    );

  if (!tracks.length) tracks.push("default");

  return tracks.flatMap((track) =>
    cloudProviders.flatMap((provider) => {
      const tests: { suite: Suite; scenario: string }[] = [
        ...[...mainTests, ...workloads].map((scenario) => ({ suite: "main" as const, scenario })),
        ...["snapshot", "create-from-snapshot"].map((scenario) => ({
          suite: "snapshot" as const,
          scenario,
        })),
        ...[10, 25].map((k) => ({ suite: "burst" as const, scenario: `burst-${k}/all-ready` })),
        { suite: "cost", scenario: "tool-replay" },
      ];

      return tests.map(({ suite, scenario }) => {
        const rows = samples.filter(
          (s) =>
            (s.track ?? "default") === track &&
            s.provider === provider &&
            s.suite === suite &&
            s.scenario === scenario &&
            isAttempt(s),
        );

        const reason =
          policy.notRun.find((r) => matches({ provider, suite, scenario, track }, r))?.reason ??
          null;

        const target = attemptTarget(suite, scenario);

        const phasesOK =
          scenario !== "pause-resume" ||
          rows.every(
            (s) =>
              s.outcome.kind !== "sample" ||
              ["pauseMs", "resumeReturnedMs", "resumeReadyMs"].every((k) =>
                Number.isFinite(s.phases[k]),
              ),
          );

        return {
          track,
          provider,
          suite,
          scenario,
          attempts: rows.length,
          target,
          reason,
          pass: phasesOK && (reason ? rows.length === 0 : rows.length === target),
        };
      });
    }),
  );
}

export async function attemptsCommand(args: string[]) {
  const [directory] = args;

  if (!directory) throw new Error("Usage: bun bench attempts results/publication-final-v2");

  const report = z
    .object({
      samples: z.array(
        (await import("./merge.js")).sampleSchema.extend({
          sourceRunId: z.string(),
          sourceSampleIndex: z.number(),
          sourceIteration: z.number(),
          iterationNamespace: z.string(),
          suite: z.enum(["main", "snapshot", "burst", "cost"]),
          failureClass: z
            .enum(["provider-account-limit", "client-third-party", "provider-operation"])
            .nullable(),
        }),
      ),
      sources: z
        .array(
          z.object({ config: z.object({ track: z.enum(["default", "same-spec"]).optional() }) }),
        )
        .optional(),
      attemptPolicy: attemptPolicySchema,
    })
    .parse(JSON.parse(await readFile(`${directory}/results.json`, "utf8")));

  const checks = checkAttempts(
    report.samples,
    report.attemptPolicy,
    report.sources?.map((s) => s.config.track ?? "default"),
  );

  process.stdout.write(
    "track\tprovider\tsuite\ttest\tattempts\ttarget\tstatus/reason\n" +
      checks
        .map(
          (r) =>
            `${r.track}\t${r.provider}\t${r.suite}\t${r.scenario}\t${r.attempts}\t${r.target}\t${r.pass ? "PASS" : "FAIL"}${r.reason ? `: ${r.reason}` : ""}`,
        )
        .join("\n") +
      "\n",
  );

  if (checks.some((r) => !r.pass)) process.exitCode = 1;
}
