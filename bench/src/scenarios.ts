/** The main suite's scenarios before cpu-sustained, in order. */
const baseScenarioNames = [
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

/** The main suite's scenarios, in order. `--scenarios all` selects every one. */
export const scenarioNames = [...baseScenarioNames, "cpu-sustained"];

/** Whether `--scenarios` selects a main-suite scenario. */
export function selectsScenario(selection: readonly string[], scenario: string) {
  return selection.includes("all") || selection.includes(scenario);
}

/**
 * The longest one iteration can run: each scenario, plus create, fingerprint, restore and destroy,
 * may take up to the per-step timeout. The admission reserve and sandbox lifetimes both use it.
 * cpu-sustained adds its step only when selected, so runs without it reserve what they always did.
 */
export function iterationBoundMs(timeoutMs: number, selection: readonly string[] = []): number {
  const sustained = selectsScenario(selection, "cpu-sustained") ? 1 : 0;

  return timeoutMs * (baseScenarioNames.length + 4 + sustained);
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
 * The longest one cohort member can run, for its admission reserve: create and fingerprint each
 * take up to the per-step timeout, then the kind's own work. A survival member's last heartbeat
 * and a liveness lookup after a miss can each take another timeout.
 */
export function cohortBoundMs(kind: CohortKind, timeoutMs: number, survival: SurvivalPlan) {
  switch (kind) {
    case "burst":
      return timeoutMs * 2;
    case "cpu-burst":
      return timeoutMs * 3;
    case "survival":
      return timeoutMs * 4 + survival.windowMs;
    default: {
      const exhaustive: never = kind;

      return exhaustive;
    }
  }
}

/** Which cohort kinds a run collects. */
export function selectedCohorts(selection: readonly string[], bursts: readonly number[]) {
  const named = cohortKinds.filter((kind) => kind !== "burst" && selection.includes(kind));

  // Readiness bursts follow --bursts as they always have, unless the run names only new kinds.
  const plain = bursts.length > 0 && (selection.includes("burst") || named.length === 0);

  return [...(plain ? (["burst"] as const) : []), ...named];
}

/** Whether a run skips normal iterations: it names only cohort kinds, or names burst. */
export function cohortOnly(selection: readonly string[]) {
  return (
    !selection.includes("all") &&
    (selection.includes("burst") || selection.every((name) => isCohortKind(name)))
  );
}
