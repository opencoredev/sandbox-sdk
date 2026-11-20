import { z } from "zod";
import type { MergeSource } from "./merge.js";
import { cohortOnly, isStressSelection, parseCohortScenario } from "./scenarios.js";

/** Suites keep their samples apart in summaries and attempt selection. */
export const suiteSchema = z.enum([
  "main",
  "snapshot",
  "burst",
  "cost",
  "cpu-sustained",
  "cpu-burst",
  "survival",
]);

type Suite = z.infer<typeof suiteSchema>;

const stressSuiteNames: readonly Suite[] = ["cpu-sustained", "cpu-burst", "survival"];

/**
 * Whether a source run is a stress run, from its scenario plan: it named a stress suite. The plan
 * decides, whatever rows a selection policy later keeps or removes.
 */
export function isStressRun(source: { config: { scenarios: readonly string[] } }) {
  return isStressSelection(source.config.scenarios);
}

/**
 * The suite a source run belongs to, from its scenarios: cost, readiness-burst, snapshot and
 * stress runs by name, anything else main. Every row of a stress run is a stress row, so its
 * ordinary rows (create, fingerprint, destroy, lifetime) take its stress suite.
 */
export function suiteFor(source: Pick<MergeSource, "config">): Suite {
  const { scenarios } = source.config;

  if (scenarios.includes("cost")) return "cost";

  if (isStressRun(source))
    return scenarios.includes("cpu-sustained")
      ? "cpu-sustained"
      : scenarios.includes("cpu-burst")
        ? "cpu-burst"
        : "survival";

  // Only a run of cohorts alone is a burst run; `command,burst` runs normal iterations too.
  if (scenarios.includes("burst") && cohortOnly(scenarios)) return "burst";

  if (scenarios.length === 1 && scenarios.includes("snapshot")) return "snapshot";

  return "main";
}

/**
 * Rows of the stress suites, selected and published apart from the rest: every row of a stress
 * run, and any cpu-sustained row a run collected before stress runs were kept apart.
 */
export function isStressSample(sample: { suite: Suite; scenario: string }) {
  return (
    stressSuiteNames.includes(sample.suite) ||
    /^cpu-sustained(-single|-all)?$/.test(sample.scenario)
  );
}

/**
 * The unit a stress row is selected with: its whole cohort (`<kind>-<K>` and cohort index), or
 * for cpu-sustained its iteration. A policy rule that matches any row of a unit removes all of
 * it; for the cohort suites, a superseded rule's `iterations` are cohort indices.
 */
export function stressUnit(sample: { scenario: string; sourceIteration: number }) {
  const cohort = parseCohortScenario(sample.scenario);

  if (!cohort) return { name: "cpu-sustained", index: sample.sourceIteration };

  return {
    name: `${cohort.kind}-${cohort.k}`,
    index: cohort.aggregate
      ? sample.sourceIteration
      : Math.floor(sample.sourceIteration / cohort.k),
  };
}

/** The suite one sample counts toward: burst and snapshot scenarios keep their own suite inside any run. */
export function sampleSuite(scenario: string, sourceSuite: Suite): Suite {
  const cohort = parseCohortScenario(scenario);

  if (cohort) return cohort.kind;

  if (/^(snapshot(?:-|$)|create-from-snapshot$|restore-)/.test(scenario)) return "snapshot";

  return sourceSuite;
}
