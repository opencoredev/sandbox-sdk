import type { Sandbox } from "@opencoredev/sandbox-sdk";

export const expandedCategories = [
  "cpu",
  "agent-tasks",
  "agent-loops",
  "filesystem",
  "builds",
  "runtime",
] as const;

export type ExpandedCategory = (typeof expandedCategories)[number];

export type ExpandedUnit = "s" | "ops/s" | "MB/s" | "files/s" | "queries/s" | "spawns/s";

export interface ExpandedContext {
  /** Fresh per-run 32-bit unsigned integer seed so cached or hardcoded answers fail verification. */
  readonly seed: number;
  /** Per-command timeout in milliseconds. */
  readonly timeoutMs: number;
}

export type ExpandedDetails = Readonly<Record<string, number | string | boolean>>;

export interface ExpandedOutcome {
  /** Primary measured value in `scenario.unit` (must be finite and > 0). */
  readonly value: number;
  /** Deterministic proof digest derived from `ctx.seed` and the verified guest work (min 8 chars). */
  readonly proof: string;
  /** Optional secondary metrics or timings. */
  readonly details?: ExpandedDetails;
}

export type VerifyResult =
  | {
      readonly ok: true;
      readonly value: number;
      readonly proof: string;
      readonly details?: ExpandedDetails;
    }
  | { readonly ok: false; readonly reason: string };

export interface ExpandedScenario {
  readonly id: string;
  readonly category: ExpandedCategory;
  readonly label: string;
  readonly description: string;
  readonly unit: ExpandedUnit;
  readonly better: "lower" | "higher";
  /**
   * Raised when what the metric measures changes, so its samples are never aggregated with those of
   * an earlier version. Absent means 1.
   */
  readonly metricVersion?: number;
  /** Run inside a real sandbox and return verified metric + seed-bound proof. */
  run(box: Sandbox, ctx: ExpandedContext): Promise<ExpandedOutcome>;
  /**
   * Pure verifier for raw guest output against `seed`.
   * Must return `{ ok: true, ... }` for valid output and `{ ok: false, reason }` for empty,
   * malformed, tampered, or wrong-seed output.
   */
  verifyOutput(raw: string, seed: number): VerifyResult;
}

export interface ExpandedRunSample {
  readonly scenarioId: string;
  readonly provider: string;
  readonly seed: number;
  readonly value: number;
  readonly unit: ExpandedUnit;
  readonly better: "lower" | "higher";
  readonly proof: string;
  readonly wallMs: number;
  readonly details?: ExpandedDetails;
  /** The scenario's `metricVersion` when it ran; absent in results from before versioning, meaning 1. */
  readonly metricVersion?: number;
}

export interface ExpandedSiteMetric {
  readonly id: string;
  readonly category: ExpandedCategory;
  readonly label: string;
  readonly description: string;
  readonly unit: ExpandedUnit;
  readonly better: "lower" | "higher";
  readonly metricVersion: number;
  readonly values: readonly {
    readonly provider: string;
    readonly n: number;
    readonly median: number;
    readonly min: number;
    readonly max: number;
  }[];
}

export interface ExpandedSiteData {
  readonly version: 1;
  readonly scenarioCount: number;
  readonly categories: readonly ExpandedCategory[];
  readonly metrics: readonly ExpandedSiteMetric[];
}
