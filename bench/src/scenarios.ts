/** The main suite's scenarios, in order. `--scenarios all` selects every one. */
export const scenarioNames = [
  "command",
  "files-1kb",
  "files-10mb",
  "reconnect",
  "pause-resume",
  "snapshot",
  "fingerprint",
  "perf",
  "git-clone",
  "npm-install",
  "dev-server",
  "preview-first-byte",
  "edit-loop",
  "tool-replay",
  "pip-install",
];

/**
 * The stress suites, added after the publication runs. They run only when named, never by `all`
 * and never beside a publication scenario, so a run is a stress run by its plan alone.
 */
export const stressSuites = ["cpu-sustained", "cpu-burst", "survival"] as const;

/** Whether `--scenarios` names a stress suite. */
export function isStressSelection(selection: readonly string[]) {
  return selection.some((name) => stressSuites.some((suite) => suite === name));
}

/** Whether `--scenarios` selects a scenario: by name, or a main-suite one by `all`. */
export function selectsScenario(selection: readonly string[], scenario: string) {
  return (
    selection.includes(scenario) || (selection.includes("all") && scenarioNames.includes(scenario))
  );
}

/**
 * The longest one iteration can run: each scenario, plus create, fingerprint, restore and destroy,
 * may take up to the per-step timeout. The admission reserve and sandbox lifetimes both use it.
 * cpu-sustained adds its step only when selected, so runs without it reserve what they always did.
 */
export function iterationBoundMs(timeoutMs: number, selection: readonly string[] = []): number {
  const sustained = selection.includes("cpu-sustained") ? 1 : 0;

  return timeoutMs * (scenarioNames.length + 4 + sustained);
}

/**
 * Cohorts start K sandboxes at once, in isolation from normal iterations: `burst` times readiness,
 * `cpu-burst` runs the short CPU workload on every member together, and `survival` keeps every
 * member alive through a heartbeat window.
 */
export const cohortKinds = ["burst", "cpu-burst", "survival"] as const;

export type CohortKind = (typeof cohortKinds)[number];

/** The row each cohort writes once, after its members: `<kind>-<K>/<aggregate>`. */
export const cohortAggregate = {
  burst: "all-ready",
  "cpu-burst": "all-complete",
  survival: "cohort",
} as const satisfies Record<CohortKind, string>;

export function isCohortKind(name: string): name is CohortKind {
  return cohortKinds.some((kind) => kind === name);
}

/** A cohort scenario such as `cpu-burst-10/cpu-single`, split into its kind, K and member scenario. */
export function parseCohortScenario(scenario: string) {
  const match = /^(burst|cpu-burst|survival)-(\d+)\/(.+)$/.exec(scenario);
  const kind = match?.[1];

  if (!match?.[2] || !match[3] || kind === undefined || !isCohortKind(kind)) return null;

  return {
    kind,
    k: Number(match[2]),
    member: match[3],
    aggregate: match[3] === cohortAggregate[kind],
  };
}

/** The heartbeat window every survival member must stay alive and responsive through. */
export interface SurvivalPlan {
  windowMs: number;
  intervalMs: number;
}

/**
 * From a survival window's start until its last heartbeat, and the exact lookup after a miss,
 * have finished: each is bounded by the heartbeat deadline, which never exceeds the interval.
 */
export function windowBoundMs(plan: SurvivalPlan, timeoutMs: number) {
  return plan.windowMs + 2 * Math.min(timeoutMs, plan.intervalMs);
}

/**
 * Steps a stress sandbox's cleanup reserves after its work: draining its tracked calls, then one
 * delete attempt (the live ownership check, then the delete). A retry starts only while a whole
 * attempt still fits (`deleteAttemptMs`), so cleanup never runs past the reserve.
 */
export const cleanupSteps = 3;

/** The longest one delete attempt can take: the ownership check, then the delete. */
export const deleteAttemptMs = (timeoutMs: number) => 2 * timeoutMs;

/**
 * The longest one cohort member can run, for its admission reserve and sandbox lifetime: create
 * and fingerprint each take up to the per-step timeout, then the kind's own work, then cleanup.
 * cpu-burst's work is staging the probe and running it; survival's is the heartbeat window, which
 * `survivalEndBy` holds to its bound so the cleanup steps stay reserved. Readiness bursts keep
 * the published reserve, which counts no cleanup.
 */
export function cohortBoundMs(kind: CohortKind, timeoutMs: number, survival: SurvivalPlan) {
  switch (kind) {
    case "burst":
      return timeoutMs * 2;
    case "cpu-burst":
      return timeoutMs * (2 + 2 + cleanupSteps);
    case "survival":
      return timeoutMs * 2 + windowBoundMs(survival, timeoutMs) + timeoutMs * cleanupSteps;
    default: {
      const exhaustive: never = kind;

      return exhaustive;
    }
  }
}

/**
 * The absolute `performance.now()` deadline for a survival cohort's windows: the cohort's start
 * plus its member bound, less the cleanup steps. Every member's heartbeats and lookups end by it.
 */
export function survivalEndBy(cohortStart: number, timeoutMs: number, plan: SurvivalPlan) {
  return cohortStart + cohortBoundMs("survival", timeoutMs, plan) - timeoutMs * cleanupSteps;
}

/** Conservative concurrent-sandbox caps per account, where `--account-limits` gives none. */
const defaultAccountCaps = new Map([
  ["boxd", 50],
  ["e2b", 20],
  ["upstash", 10],
  ["freestyle", 10],
  ["tenki", 5],
  ["baseten", 10],
  ["instabox", 25],
  // Archil's Developer plan cap (Free 5, Team 250): docs.archil.com/administration/billing.md
  ["archil", 20],
  // Maritime's Growth plan: 25 machines awake at once.
  ["maritime", 25],
  // Buddy's Pro plan has no published sandbox cap; the bench keeps bursts modest.
  ["buddy", 10],
  // Agent 37's tier 2 (top-ups of $50 or more): 200 GB of memory awake at once, 50 of its smallest
  // size, 2 vCPU / 4 GB (GET /v1/billing, 2026-11-28). A 4/8 cohort fits 25.
  ["agent37", 50],
]);

/** The most sandboxes one cohort may hold on a provider's account; boxd never above 50. */
export function accountCap(provider: string, overrides: Readonly<Record<string, number>>) {
  const configured = overrides[provider] ?? defaultAccountCaps.get(provider) ?? 10;

  return provider === "boxd" ? Math.min(configured, 50) : configured;
}

/** Which cohort kinds a run collects. */
export function selectedCohorts(selection: readonly string[], bursts: readonly number[]) {
  const named = cohortKinds.filter((kind) => kind !== "burst" && selection.includes(kind));

  // Readiness bursts follow --bursts as they always have, unless the run names a stress suite.
  const plain = bursts.length > 0 && (selection.includes("burst") || !isStressSelection(selection));

  return [...(plain ? (["burst"] as const) : []), ...named];
}

/**
 * Whether a run skips normal iterations: it names only cohort kinds. cpu-sustained named beside
 * cpu-burst or survival runs as normal iterations, then the cohorts run.
 */
export function cohortOnly(selection: readonly string[]) {
  return !selection.includes("all") && selection.every((name) => isCohortKind(name));
}

/**
 * Refuse a scenario plan that mixes stress suites with publication scenarios, or names a cohort
 * suite with no cohort sizes to run.
 */
export function checkScenarioPlan(selection: readonly string[], bursts: readonly number[]) {
  const others = selection.filter((name) => !stressSuites.some((suite) => suite === name));

  if (isStressSelection(selection) && others.length)
    throw new Error(
      `Stress suites (${stressSuites.join(", ")}) run apart from the publication scenarios; drop ${others.join(", ")} or collect them in their own run`,
    );

  const cohorts = selection.filter((name) => isCohortKind(name));

  if (cohorts.length && !bursts.length)
    throw new Error(`--scenarios ${cohorts.join(",")} needs cohort sizes: pass --bursts K[,K...]`);
}
