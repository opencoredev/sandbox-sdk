import type { Config } from "./config.js";
import type { statistics } from "./stats.js";

export const scenarios = [
  "cold",
  "command",
  "files-1kb",
  "files-10mb",
  "dev-server",
  "preview-first-byte",
  "destroy",
  "raw-cpu",
  "sdk-cpu",
  "overhead-cpu",
] as const;

export type Scenario = (typeof scenarios)[number];

export type Observation =
  | { kind: "sample"; value: number }
  | { kind: "failure"; note: string }
  | { kind: "skipped"; note: string };

export interface Metric {
  scenario: Scenario;
  unit: "ms" | "cpu-ms/call";
  samples: number[];
  stats: ReturnType<typeof statistics>;
  failures: string[];
  skipped: string[];
}

export type ProviderReport =
  | { kind: "skipped"; name: string; note: string }
  | {
      kind: "measured";
      name: string;
      region: string | null;
      metrics: Metric[];
      notes?: string[];
      warmupFailures: string[];
      cleanupFailures: string[];
    };

export interface Report {
  schemaVersion: 1;
  timestamp: string;
  sdkVersion: string;
  machine: {
    cpu: string;
    logicalCpus: number;
    ramBytes: number;
    os: string;
    arch: string;
    runtime: string;
  };
  config: Config;
  plannedCloudSandboxes: number;
  methodology: { percentiles: string; cold: string; files: string; cpu: string };
  providers: ProviderReport[];
}
