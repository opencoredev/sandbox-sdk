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

/** The suite one sample counts toward: burst and snapshot scenarios keep their own suite inside any run. */
export function sampleSuite(scenario: string, sourceSuite: Suite): Suite {
  const cohort = parseCohortScenario(scenario);

  if (cohort) return cohort.kind;

  if (/^(snapshot(?:-|$)|create-from-snapshot$|restore-)/.test(scenario)) return "snapshot";

  return sourceSuite;
}
