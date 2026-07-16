import {
  daytonaCapabilities,
  e2bCapabilities,
  localCapabilities,
  railwayCapabilities,
  upstashCapabilities,
  vercelCapabilities,
} from "./providers/capabilities";
import type { CapabilityMap, ProviderName } from "./core/types";

export interface LiveTestResult {
  provider: ProviderName;
  testedAt: string;
  adapterVersion: string;
  providerSdkVersion: string;
  passed: number;
  failed: number;
  skipped: number;
  capabilities: Partial<CapabilityMap>;
}

export interface ProviderMetadata {
  id: ProviderName;
  displayName: string;
  officialUrl: string;
  packageName: string | null;
  packageVersion: string;
  capabilities: CapabilityMap;
  environmentVariables: readonly string[];
  technicalStatus: "supported" | "experimental";
  providerReviewed: boolean;
  sponsor: boolean;
  liveTest: LiveTestResult | null;
  portBehavior: string;
  snapshotBehavior: string;
  runtimeLimitations: string;
}

export const providers: readonly ProviderMetadata[] = [
  {
    id: "local",
    displayName: "Local",
    officialUrl: "https://rivet.dev/docs/agent-os/",
    packageName: "@rivet-dev/agentos-core",
    packageVersion: "0.2.7",
    capabilities: localCapabilities,
    environmentVariables: [],
    technicalStatus: "supported",
    providerReviewed: false,
    sponsor: false,
    liveTest: null,
    portBehavior:
      "Returns a private in-process URL. HTTP traffic is bridged through ExposedPort.request().",
    snapshotBehavior:
      "Exports the AgentOS virtual filesystem and recreates the VM when restoring it.",
    runtimeLimitations:
      "Powered by the beta AgentOS runtime. Requires a supported Node.js host and cannot run arbitrary native Linux binaries.",
  },
  {
    id: "e2b",
    displayName: "E2B",
    officialUrl: "https://e2b.dev/docs",
    packageName: "e2b",
    packageVersion: "2.32.0",
    capabilities: e2bCapabilities,
    environmentVariables: ["E2B_API_KEY"],
    technicalStatus: "supported",
    providerReviewed: false,
    sponsor: false,
    liveTest: null,
    portBehavior:
      "Returns an E2B host. Restricted traffic uses the native access token only inside request().",
    snapshotBehavior:
      "Creates persistent E2B snapshot templates; restore creates a new native sandbox and remains on raw.",
    runtimeLimitations: "Requires Node.js 20.18.1 or newer and an E2B account.",
  },
  {
    id: "daytona",
    displayName: "Daytona",
    officialUrl: "https://www.daytona.io/docs/en/sandboxes/",
    packageName: "@daytona/sdk",
    packageVersion: "0.196.0",
    capabilities: daytonaCapabilities,
    environmentVariables: ["DAYTONA_API_KEY", "DAYTONA_API_URL", "DAYTONA_TARGET"],
    technicalStatus: "supported",
    providerReviewed: false,
    sponsor: false,
    liveTest: null,
    portBehavior:
      "Returns public or token-authenticated preview URLs according to the sandbox setting.",
    snapshotBehavior:
      "Daytona snapshot and fork operations have provider-specific lifecycle semantics and remain on raw.",
    runtimeLimitations: "Some binary and streaming methods require a Node.js-compatible runtime.",
  },
  {
    id: "vercel",
    displayName: "Vercel Sandbox",
    officialUrl: "https://vercel.com/docs/sandbox",
    packageName: "@vercel/sandbox",
    packageVersion: "2.5.0",
    capabilities: vercelCapabilities,
    environmentVariables: [
      "VERCEL_OIDC_TOKEN",
      "VERCEL_TOKEN",
      "VERCEL_TEAM_ID",
      "VERCEL_PROJECT_ID",
    ],
    technicalStatus: "supported",
    providerReviewed: false,
    sponsor: false,
    liveTest: null,
    portBehavior:
      "Returns a public vercel.run route. Port registration is updated when expose() is called.",
    snapshotBehavior:
      "Creating a filesystem snapshot stops the session. Starting from it creates a new sandbox through raw.",
    runtimeLimitations:
      "Available runtimes are controlled by Vercel; node24 is the adapter default.",
  },
  {
    id: "upstash",
    displayName: "Upstash Box",
    officialUrl: "https://upstash.com/docs/box",
    packageName: "@upstash/box",
    packageVersion: "0.5.3",
    capabilities: upstashCapabilities,
    environmentVariables: ["UPSTASH_BOX_API_KEY"],
    technicalStatus: "supported",
    providerReviewed: false,
    sponsor: false,
    liveTest: null,
    portBehavior:
      "Creates a public URL by default, or a bearer-token URL whose credential stays inside request().",
    snapshotBehavior:
      "Captures persistent workspace state. Restoring creates a new Box and remains available through raw.",
    runtimeLimitations:
      "Durable Debian or Alpine boxes with Node.js, Python, Go, Ruby, or Rust runtimes.",
  },
  {
    id: "railway",
    displayName: "Railway Sandboxes",
    officialUrl: "https://docs.railway.com/sandboxes",
    packageName: "railway",
    packageVersion: "3.5.7",
    capabilities: railwayCapabilities,
    environmentVariables: ["RAILWAY_API_TOKEN", "RAILWAY_ENVIRONMENT_ID"],
    technicalStatus: "experimental",
    providerReviewed: false,
    sponsor: false,
    liveTest: null,
    portBehavior:
      "Normalized ports.expose() is unsupported. Use railway sandbox forward or sandbox.raw for port access.",
    snapshotBehavior:
      "snapshot.create() forks the live filesystem into a new sandbox. Restore is unsupported; boot forks or checkpoints through sandbox.raw.",
    runtimeLimitations:
      "Priority Boarding feature. Requires a Railway project environment and API token. Sandboxes are ephemeral VMs billed by resource usage.",
  },
];

export function getProviderMetadata(id: ProviderName): ProviderMetadata {
  return providers.find((provider) => provider.id === id)!;
}
