import type { MergeSource, Suite } from "./merge.js";

/** The suite a source run belongs to, from its scenarios: cost, burst and snapshot runs by name, anything else main. */
export function suiteFor(source: Pick<MergeSource, "config">): Suite {
  if (source.config.scenarios.includes("cost")) return "cost";

  if (source.config.scenarios.includes("burst")) return "burst";

  if (source.config.scenarios.length === 1 && source.config.scenarios.includes("snapshot"))
    return "snapshot";

  return "main";
}

/** The suite one sample counts toward: burst and snapshot scenarios keep their own suite inside any run. */
export function sampleSuite(scenario: string, sourceSuite: Suite): Suite {
  if (scenario.startsWith("burst-")) return "burst";

  if (/^(snapshot(?:-|$)|create-from-snapshot$|restore-)/.test(scenario)) return "snapshot";

  return sourceSuite;
}
