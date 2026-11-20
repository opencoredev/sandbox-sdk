import {
  expandedCategories,
  type ExpandedRunSample,
  type ExpandedScenario,
  type ExpandedSiteData,
  type ExpandedSiteMetric,
} from "./types.js";

/**
 * Registry of all expanded benchmark scenarios, grouped by category.
 * Kept separate from the legacy `scenarioNames` so existing publication site-data stays unchanged.
 */
export const expandedScenarios: readonly ExpandedScenario[] = [];

export function findExpandedScenario(id: string): ExpandedScenario | undefined {
  return expandedScenarios.find((s) => s.id === id);
}

function medianOf(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;

  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Export verified expanded benchmark samples into a chart-ready site-data structure. */
export function exportExpandedSiteData(
  samples: readonly ExpandedRunSample[],
  scenarios: readonly ExpandedScenario[] = expandedScenarios,
): ExpandedSiteData {
  const metrics: ExpandedSiteMetric[] = scenarios.map((scenario) => {
    const byProvider = new Map<string, number[]>();

    for (const sample of samples) {
      if (sample.scenarioId !== scenario.id) continue;

      if (!Number.isFinite(sample.value) || sample.value <= 0) continue;

      const list = byProvider.get(sample.provider) ?? [];
      list.push(sample.value);
      byProvider.set(sample.provider, list);
    }

    const values = [...byProvider.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, nums]) => {
        const sorted = [...nums].sort((a, b) => a - b);

        return {
          provider,
          n: sorted.length,
          median: medianOf(sorted),
          min: sorted[0] ?? 0,
          max: sorted[sorted.length - 1] ?? 0,
        };
      });

    return {
      id: scenario.id,
      category: scenario.category,
      label: scenario.label,
      description: scenario.description,
      unit: scenario.unit,
      better: scenario.better,
      values,
    };
  });

  return {
    version: 1,
    scenarioCount: scenarios.length,
    categories: expandedCategories,
    metrics,
  };
}
