import { z } from "zod";
import type { MergeSource } from "./merge.js";
import { parseCohortScenario } from "./scenarios.js";

/** Suites keep their samples apart in summaries and attempt selection. */
export const suiteSchema = z.enum(["main", "snapshot", "burst", "cost", "cpu-burst", "survival"]);

type Suite = z.infer<typeof suiteSchema>;

/** The suite a source run belongs to, from its scenarios: cost, burst and snapshot runs by name, anything else main. */
export function suiteFor(source: Pick<MergeSource, "config">): Suite {
  if (source.config.scenarios.includes("cost")) return "cost";

  if (source.config.scenarios.includes("burst")) return "burst";

  // A run that names only cpu-burst or survival collects nothing else.
  for (const kind of ["cpu-burst", "survival"] as const)
    if (source.config.scenarios.length === 1 && source.config.scenarios[0] === kind) return kind;

  if (source.config.scenarios.length === 1 && source.config.scenarios.includes("snapshot"))
    return "snapshot";

  return "main";
}

/**
 * Rows of the stress suites, added after the publication runs: cpu-sustained in the main suite,
 * and the cpu-burst and survival cohorts. They are selected and published apart from the rest.
 */
export function isStressSample(sample: { suite: Suite; scenario: string }) {
  return (
    sample.suite === "cpu-burst" ||
    sample.suite === "survival" ||
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
