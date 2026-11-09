/**
 * How each provider runs the release-1 profiles on each track, in one table.
 *
 * - Same-machine sizes and templates are the bench's existing same-spec flags (collection-plan.sh):
 *   E2B and Superserve 4 vCPU / 8 GiB templates, Daytona's daytona-large, Upstash medium, boxd
 *   4 vCPU / 16 GiB (its 4 vCPU shape; non-compliant by the eligibility code), Tenki 4:8192, and
 *   the 4 vCPU / 8 GiB defaults of Boat and Freestyle.
 * - Default sizes and "default size too small" come from FIT.md (SBX-95, fetched 2026-11-05).
 * - `lifetime`: whether the adapter accepts `timeoutMs` (Upstash, Superserve and Boat refuse it).
 * - `provisioned` is the size each is billed for, used for list prices and the budget guard.
 */
import type { CreateInput } from "@opencoredev/sandbox-sdk/provider";

export const tracks = ["same-machine", "default"] as const;

export type TrackId = (typeof tracks)[number];

export interface TrackSetup {
  readonly template?: string;
  readonly size?: CreateInput["size"];
  /** Worker count for the frozen commands: the size's vCPUs. */
  readonly vcpu: number;
  readonly provisioned: {
    readonly cpu: number;
    readonly memoryGiB: number;
    readonly diskGiB: number;
  };
  /** Profiles the fit check found this size cannot complete, with FIT.md's reason. */
  readonly tooSmall: { readonly [profile: string]: string };
}

export interface ProviderSetup {
  /** As recorded in attempts.jsonl. */
  readonly name: string;
  /** The SDK adapter and the bench's provider loader name. */
  readonly adapter: string;
  readonly product: string | null;
  /** The adapter accepts `timeoutMs` as a hard lifetime. */
  readonly lifetime: boolean;
  /** Key into `pricing` for the budget guard. */
  readonly pricingKey: string;
  readonly tracks: { readonly [K in TrackId]: TrackSetup };
}

const size = (cpu: number, memoryGiB: number, diskGiB: number) => ({ cpu, memoryGiB, diskGiB });

const fit = {
  e2b: "FIT.md: 2 vCPU / 0.5 GiB is OOM-killed during install",
  heap1g: "FIT.md: 1 vCPU / 1 GiB, tsc aborts with JavaScript heap out of memory",
  install1g: "FIT.md: 1 vCPU / 1 GiB is OOM-killed during install",
  tenkiBuild: "FIT.md: 2 vCPU / 3.8 GiB is OOM-killed in the build",
} as const;

export const providerSetups: readonly ProviderSetup[] = [
  {
    name: "e2b",
    adapter: "e2b",
    product: null,
    lifetime: true,
    pricingKey: "e2b",
    tracks: {
      "same-machine": {
        template: "r1h7gud12rf1f6iu29r0",
        vcpu: 4,
        provisioned: size(4, 8, 22),
        tooSmall: {},
      },
      default: {
        template: "base",
        vcpu: 2,
        provisioned: size(2, 0.5, 22),
        tooSmall: { "fix-and-test": fit.e2b, build: fit.e2b },
      },
    },
  },
  {
    name: "daytona",
    adapter: "daytona",
    product: null,
    lifetime: true,
    pricingKey: "daytona",
    tracks: {
      "same-machine": {
        template: "daytona-large",
        vcpu: 4,
        provisioned: size(4, 8, 10),
        tooSmall: {},
      },
      default: {
        vcpu: 1,
        provisioned: size(1, 1, 3),
        tooSmall: { "fix-and-test": fit.heap1g, build: fit.install1g },
      },
    },
  },
  {
    name: "upstash",
    adapter: "upstash",
    product: null,
    lifetime: false,
    pricingKey: "upstash",
    tracks: {
      "same-machine": { size: "medium", vcpu: 4, provisioned: size(4, 8, 10), tooSmall: {} },
      default: { vcpu: 2, provisioned: size(2, 4, 10), tooSmall: {} },
    },
  },
  {
    name: "upstash-ephemeral",
    adapter: "upstash",
    product: "ephemeral",
    lifetime: false,
    pricingKey: "upstash",
    tracks: {
      "same-machine": { size: "medium", vcpu: 4, provisioned: size(4, 8, 10), tooSmall: {} },
      default: { vcpu: 2, provisioned: size(2, 4, 10), tooSmall: {} },
    },
  },
  {
    name: "boxd",
    adapter: "boxd",
    product: null,
    lifetime: true,
    pricingKey: "boxd",
    tracks: {
      "same-machine": {
        size: { cpu: 4, memoryMb: 16_384 },
        vcpu: 4,
        provisioned: size(4, 16, 100),
        tooSmall: {},
      },
      default: { vcpu: 2, provisioned: size(2, 8, 100), tooSmall: {} },
    },
  },
  {
    name: "freestyle",
    adapter: "freestyle",
    product: null,
    lifetime: true,
    pricingKey: "freestyle",
    tracks: {
      "same-machine": { vcpu: 4, provisioned: size(4, 8, 32), tooSmall: {} },
      default: { vcpu: 4, provisioned: size(4, 8, 32), tooSmall: {} },
    },
  },
  {
    name: "tenki",
    adapter: "tenki",
    product: null,
    lifetime: true,
    pricingKey: "tenki",
    tracks: {
      "same-machine": {
        size: { cpu: 4, memoryMb: 8192 },
        vcpu: 4,
        provisioned: size(4, 8, 5),
        tooSmall: {},
      },
      default: { vcpu: 2, provisioned: size(2, 3.8, 5), tooSmall: { build: fit.tenkiBuild } },
    },
  },
  {
    name: "superserve",
    adapter: "superserve",
    product: null,
    lifetime: false,
    pricingKey: "superserve",
    tracks: {
      "same-machine": {
        template: "sandbox-bench-node22-py311-4x8-pinned",
        vcpu: 4,
        provisioned: size(4, 8, 4),
        tooSmall: {},
      },
      default: {
        template: "sandbox-bench-node22-py311-1x1-pinned",
        vcpu: 1,
        provisioned: size(1, 1, 4),
        tooSmall: { "fix-and-test": fit.heap1g, build: fit.install1g },
      },
    },
  },
  {
    name: "boat",
    adapter: "boat",
    product: null,
    lifetime: false,
    pricingKey: "boat",
    tracks: {
      "same-machine": { vcpu: 4, provisioned: size(4, 8, 50), tooSmall: {} },
      default: { vcpu: 4, provisioned: size(4, 8, 50), tooSmall: {} },
    },
  },
  {
    // Same-machine: cpu 4 = cpuLimit 4 and 8 GiB pinned (about 4 threads of throughput, MODAL.md;
    // Modal bills each CPU as a physical core). Default: Modal's 0.125 CPU / 128 MiB request, which
    // bursts into the host; nproc shows 1 and there is no memory limit, so FIT.md's small-size
    // failures do not apply. `provisioned` is the billed minimum there, a lower bound.
    name: "modal",
    adapter: "modal",
    product: null,
    lifetime: true,
    pricingKey: "modal",
    tracks: {
      "same-machine": {
        size: { cpu: 4, memoryMb: 8192 },
        vcpu: 4,
        provisioned: size(4, 8, 0),
        tooSmall: {},
      },
      default: { vcpu: 1, provisioned: size(0.125, 0.125, 0), tooSmall: {} },
    },
  },
];

export function providerSetup(name: string): ProviderSetup {
  const setup = providerSetups.find((s) => s.name === name);

  if (!setup)
    throw new Error(
      `Unknown provider ${name}; known: ${providerSetups.map((s) => s.name).join(", ")}`,
    );

  return setup;
}
