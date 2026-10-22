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
  | import("./failure.js").FailureOutcome
  | { kind: "skipped"; note: string }
  | { kind: "blocked"; blocked_by: string; note: string };
export interface AllocationMetadata {
  track?: ConfigV2["track"];
  requestedSize?: ConfigV2["size"][string] | null;
  template?: string | null;
}
export interface Sample extends AllocationMetadata {
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
  headroom: ReturnType<typeof import("./publication.js").headroom>;
  fingerprint: Fingerprint | null;
  estimatedCost: number | null;
  details: unknown;
}
export interface Summary extends AllocationMetadata {
  provider: string;
  scenario: string;
  unit: string;
  stats: ReturnType<typeof distribution>;
  success: ReturnType<typeof wilson>;
  failures: number;
  skipped: number;
  blocked: number;
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
  metadata: Awaited<ReturnType<typeof import("./publication.js").collectMetadata>>;
  host: { cpu: string; os: string; runtime: string };
  samples: Sample[];
  summaries: Summary[];
  providers: (AllocationMetadata & { name: string; kind: "ready" | "skipped"; note: string; configuredRegion: string | null })[];
  cleanupReview?: import("./ownership.js").CleanupReview[];
  cleanup: { provider: string; remaining: string[]; error: string | null }[];
  admissionStopped?: { provider: string; scenario: string; iteration: number; track: ConfigV2["track"]; reason: string }[];
  budgets: Record<string, { created: number; estimatedUSD: number; stop: string | null }>;
  methodology: string[];
}
