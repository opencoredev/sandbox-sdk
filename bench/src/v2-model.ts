import type { Fingerprint } from "./fingerprint.js";
import type { ConfigV2 } from "./v2-config.js";
import type { distribution, wilson } from "./v2-stats.js";
export interface HostSample {
  timestamp: string;
  load: number[];
  cpu: { user: number; system: number };
  network: string;
  cpuTicks: number[][];
}
export type Outcome =
  | { kind: "sample"; value: number }
  | { kind: "failure"; note: string }
  | { kind: "skipped"; note: string };
export interface Sample {
  provider: string;
  iteration: number;
  scenario: string;
  unit: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sandboxId: string | null;
  outcome: Outcome;
  phases: Record<string, number>;
  hostBefore: HostSample;
  hostAfter: HostSample;
  fingerprint: Fingerprint | null;
  estimatedCost: number | null;
  details: unknown;
}
export interface Summary {
  provider: string;
  scenario: string;
  unit: string;
  stats: ReturnType<typeof distribution>;
  success: ReturnType<typeof wilson>;
  failures: number;
  skipped: number;
  estimatedCost: number | null;
  per1000: number | null;
  performancePerDollar: number | null;
}
export interface ReportV2 {
  schemaVersion: 2;
  runId: string;
  timestamp: string;
  finishedAt: string;
  config: ConfigV2;
  host: { cpu: string; os: string; runtime: string };
  samples: Sample[];
  summaries: Summary[];
  providers: { name: string; kind: "ready" | "skipped"; note: string }[];
  cleanup: { provider: string; remaining: string[]; error: string | null }[];
  budgets: Record<string, { created: number; estimatedUSD: number; stop: string | null }>;
  methodology: string[];
}
