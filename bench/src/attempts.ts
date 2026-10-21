import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { MergedSample, Suite } from "./merge.js";

export const cloudProviders = ["e2b", "daytona", "upstash", "boat", "boxd", "freestyle", "tenki", "superserve"];
export const mainTests = ["cold", "command", "files-1kb", "files-10mb", "reconnect", "pause-resume", "destroy", "cpu-single", "cpu-all", "memory-mbps", "disk-write-mbps", "disk-read-mbps", "disk-4k-write-iops", "disk-4k-read-iops", "tcp-ms"];
export const workloads = ["git-clone", "npm-install", "pip-install", "dev-server", "preview-first-byte", "edit-loop", "tool-replay"];
const identity = z.object({ provider: z.enum(cloudProviders), suite: z.enum(["main", "snapshot", "burst"]), scenario: z.string() });
export const attemptPolicySchema = z.object({
  replacements: z.array(identity.extend({ sourceRunIds: z.array(z.string()).min(1) })),
  notRun: z.array(identity.extend({ reason: z.string().min(1) })),
});
export type AttemptPolicy = z.infer<typeof attemptPolicySchema>;
export function attemptTarget(suite: Suite, scenario: string): number | null {
  if (suite === "main") return mainTests.includes(scenario) ? 100 : workloads.includes(scenario) ? 30 : null;
  if (suite === "snapshot") return ["snapshot", "create-from-snapshot"].includes(scenario) ? 30 : null;
  return /^burst-(10|25)\/all-ready$/.test(scenario) ? 3 : null;
}
export function isAttempt(s: Pick<MergedSample, "outcome">) {
  return s.outcome.kind === "sample" || s.outcome.kind === "failure";
}
function matches(s: z.infer<typeof identity>, rule: z.infer<typeof identity>) {
  return s.provider === rule.provider && s.suite === rule.suite &&
    (rule.scenario.endsWith("/*") ? s.scenario.startsWith(rule.scenario.slice(0, -1)) : s.scenario === rule.scenario);
}
export function selectAttempts(samples: MergedSample[], policy: AttemptPolicy) {
  const counts = new Map<string, number>();
  const removed = new Map<string, number>();
  const drop = (reason: string) => { removed.set(reason, (removed.get(reason) ?? 0) + 1); return false; };
  const selected = [...samples].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sourceRunId.localeCompare(b.sourceRunId) || a.sourceSampleIndex - b.sourceSampleIndex).filter(s => {
    if (!cloudProviders.includes(s.provider)) return true;
    if (policy.replacements.some(r => matches(s, r) && !r.sourceRunIds.includes(s.sourceRunId))) return drop("replaced-source");
    if (policy.notRun.some(r => matches(s, r))) return drop("documented-not-run");
    if (s.failureClass === "provider-account-limit" || s.failureClass === "client-third-party") return drop(s.failureClass);
    const target = attemptTarget(s.suite, s.scenario);
    if (target === null || !isAttempt(s)) return true;
    const key = JSON.stringify([s.provider, s.suite, s.scenario]);
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    return count <= target || drop("above-target");
  });
  const cohorts = new Set(selected.filter(s => /^burst-(10|25)\/all-ready$/.test(s.scenario)).map(s => `${s.provider}/${s.sourceRunId}/${s.scenario.split("/")[0]}/${s.sourceIteration}`));
  const complete = selected.filter(s => {
    const burst = /^burst-(10|25)\/(?!all-ready$)/.exec(s.scenario);
    if (!burst || !cloudProviders.includes(s.provider)) return true;
    const identity = `${s.provider}/${s.sourceRunId}/burst-${burst[1]}/${Math.floor(s.sourceIteration / Number(burst[1]))}`;
    return cohorts.has(identity) || drop("unselected-cohort-member");
  });
  return { samples: complete, removed: Object.fromEntries(removed) };
}
export function checkAttempts(samples: MergedSample[], policy: AttemptPolicy) {
  return cloudProviders.flatMap(provider => {
    const tests: {suite: Suite; scenario: string}[] = [
      ...[...mainTests, ...workloads].map(scenario => ({suite: "main" as const, scenario})),
      ...["snapshot", "create-from-snapshot"].map(scenario => ({suite: "snapshot" as const, scenario})),
      ...[10, 25].map(k => ({suite: "burst" as const, scenario: `burst-${k}/all-ready`})),
    ];
    return tests.map(({suite, scenario}) => {
      const rows = samples.filter(s => s.provider === provider && s.suite === suite && s.scenario === scenario && isAttempt(s));
      const reason = policy.notRun.find(r => matches({provider, suite, scenario}, r))?.reason ?? null;
      const target = attemptTarget(suite, scenario);
      const phasesOK = scenario !== "pause-resume" || rows.every(s => s.outcome.kind !== "sample" || ["pauseMs", "resumeReturnedMs", "resumeReadyMs"].every(k => Number.isFinite(s.phases[k])));
      return {provider, suite, scenario, attempts: rows.length, target, reason, pass: phasesOK && (reason ? rows.length === 0 : rows.length === target)};
    });
  });
}
export async function attemptsCommand(args: string[]) {
  const [directory] = args;
  if (!directory) throw new Error("Usage: bun bench attempts results/publication-final-v2");
  const report = z.object({samples: z.array((await import("./merge.js")).sampleSchema.extend({
    sourceRunId: z.string(), sourceSampleIndex: z.number(), sourceIteration: z.number(), iterationNamespace: z.string(), suite: z.enum(["main", "snapshot", "burst"]), failureClass: z.enum(["provider-account-limit", "client-third-party", "provider-operation"]).nullable(),
  })), attemptPolicy: attemptPolicySchema}).parse(JSON.parse(await readFile(`${directory}/results.json`, "utf8")));
  const checks = checkAttempts(report.samples, report.attemptPolicy);
  process.stdout.write("provider\tsuite\ttest\tattempts\ttarget\tstatus/reason\n" + checks.map(r => `${r.provider}\t${r.suite}\t${r.scenario}\t${r.attempts}\t${r.target}\t${r.pass ? "PASS" : "FAIL"}${r.reason ? `: ${r.reason}` : ""}`).join("\n") + "\n");
  if (checks.some(r => !r.pass)) process.exitCode = 1;
}
