/**
 * How each provider runs the release-1 profiles on each track, in one table.
 *
 * - Same-machine sizes and templates are the bench's existing same-spec flags (collection-plan.sh):
 *   E2B and Superserve 4 vCPU / 8 GiB templates, Daytona's daytona-large, Upstash medium, boxd
 *   4 vCPU / 16 GiB (its 4 vCPU shape; non-compliant by the eligibility code), Luxor 4:8192, and
 *   the 4 vCPU / 8 GiB defaults of Boat and Freestyle. Luxor and Superserve get 20 GB disks
 *   (2026-11-18): their 5 GB and 4 GiB disks left too little free space for the workloads.
 * - Default sizes and "default size too small" come from FIT.md (SBX-95, fetched 2026-11-05).
 * - `lifetime`: whether the adapter accepts `timeoutMs` (Upstash, Superserve and Boat refuse it).
 * - `provisioned` is the size each is billed for, used for list prices and the budget guard.
 */
import type { CreateInput } from "@opencoredev/sandbox-sdk/provider";
import type { VolumeOption } from "../providers.js";

/** Factory options a profile may add to its adapter (`ProviderSetup.profileFactory`). */
export type ProfileFactory = { readonly volume?: VolumeOption };

export const tracks = ["same-machine", "default"] as const;

export type TrackId = (typeof tracks)[number];

export interface ProvisionedSize {
  readonly cpu: number;
  readonly memoryGiB: number;
  readonly diskGiB: number;
}

export interface TrackSetup {
  readonly template?: string;
  readonly size?: CreateInput["size"];
  /** Worker count for the frozen commands: the size's vCPUs. */
  readonly vcpu: number;
  readonly provisioned: ProvisionedSize;
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
  /**
   * Extra factory options for one profile's attempts, on both tracks: that profile gets its own
   * adapter instance. A volume's size is added to the provisioned disk for those attempts.
   */
  readonly profileFactory?: { readonly [profile: string]: ProfileFactory };
  readonly tracks: { readonly [K in TrackId]: TrackSetup };
}

const size = (cpu: number, memoryGiB: number, diskGiB: number) => ({ cpu, memoryGiB, diskGiB });

const fit = {
  e2b: "FIT.md: 2 vCPU / 0.5 GiB is OOM-killed during install",
  heap1g: "FIT.md: 1 vCPU / 1 GiB, tsc aborts with JavaScript heap out of memory",
  install1g: "FIT.md: 1 vCPU / 1 GiB is OOM-killed during install",
  tenkiBuild: "FIT.md: 2 vCPU / 3.8 GiB is OOM-killed in the build",
  beam128m: "FIT.md: 1 vCPU / 1 GiB is OOM-killed during install; Beam's default is 128 MiB",
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
      // 20 GB disk: at Luxor's 5 GB minimum the build stopped in preparation with 2.06 GiB free
      // of the 4 GiB it needs (rw-head1, 2026-11-05). Other providers run with 10 to 100 GB.
      "same-machine": {
        size: { cpu: 4, memoryMb: 8192, diskGb: 20 },
        vcpu: 4,
        provisioned: size(4, 8, 20),
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
      // Same recipe as sandbox-bench-node22-py311-4x8-pinned with a 20 GiB disk: at 4 GiB the build
      // and fix-and-test stopped in preparation with 1.46 GiB free (rw-head1, 2026-11-05).
      "same-machine": {
        template: "sandbox-bench-node22-py311-4x8-d20-pinned",
        vcpu: 4,
        provisioned: size(4, 8, 20),
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
    // https://vercel.com/docs/sandbox/pricing: 2 vCPUs and 2 GB per vCPU by default, 64 GB NVMe;
    // `large` is 4 vCPU / 8 GB (checked in the guest 2026-11-09: nproc 4, memory.max 8 GiB).
    name: "vercel",
    adapter: "vercel",
    product: null,
    lifetime: true,
    pricingKey: "vercel",
    tracks: {
      "same-machine": { size: "large", vcpu: 4, provisioned: size(4, 8, 64), tooSmall: {} },
      default: { vcpu: 2, provisioned: size(2, 4, 64), tooSmall: {} },
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
  {
    // Instabox: the default agent-browser template is 4 vCPU / 8 GiB (Debian 13, glibc) with a
    // 20 GiB /data disk that /workspace links to, so both tracks run the same machine; same-machine
    // asks for 4/8 explicitly. Idle pause is Instabox's default (30 minutes).
    // https://instabox.sh/docs/account/limits.md
    name: "instabox",
    adapter: "instabox",
    product: null,
    lifetime: true,
    pricingKey: "instabox",
    tracks: {
      "same-machine": {
        size: { cpu: 4, memoryMb: 8192 },
        vcpu: 4,
        provisioned: size(4, 8, 20),
        tooSmall: {},
      },
      default: { vcpu: 4, provisioned: size(4, 8, 20), tooSmall: {} },
    },
  },
  {
    // Baseten (limits as of 2026-11-13): memory sets CPU, 2 GiB per vCPU up to 4. Baseten holds a
    // sandbox's files in its memory, so the build's workspace goes on an 8 GiB volume (the
    // account's cap, 2026-11-16), as Baseten advised: without one, its node_modules sat in RAM and
    // tsc was OOM-killed at 4 vCPU / 8 GiB (rw-baseten-head1). Fix-and-test completed without one
    // and runs as before: the volume is network storage (virtiofs) and slowed its install from
    // about 140 s to 246 s in a smoke run. Default is Baseten's 4096 MiB (2 vCPU).
    // Baseten's default image is Alpine (musl, BusyBox), which the frozen glibc toolchain cannot
    // run, so both tracks use sandbox-bench-node22: node:22-bookworm built with Baseten's
    // ImageBuilder, which adds its sandbox agent (bench/README.md). The main suite keeps Baseten's
    // default image and no volume.
    name: "baseten",
    adapter: "baseten",
    product: null,
    lifetime: true,
    pricingKey: "baseten",
    profileFactory: { build: { volume: { sizeGiB: 8, mountPath: "/workspace" } } },
    tracks: {
      "same-machine": {
        template: "sandbox-bench-node22:latest",
        size: { cpu: 4, memoryMb: 8192 },
        vcpu: 4,
        provisioned: size(4, 8, 0),
        tooSmall: {},
      },
      default: {
        template: "sandbox-bench-node22:latest",
        vcpu: 2,
        provisioned: size(2, 4, 0),
        tooSmall: {},
      },
    },
  },
  {
    // Beam Sandboxes (2026-11-18): any whole vCPU count and MiB, set per sandbox and enforced as
    // the cgroup limit (checked in the guest: nproc 2, memory.max 4 GiB for 2:4096). Default is the
    // TypeScript SDK's 1 CPU / 128 MiB, which cannot run either profile. The adapter's default
    // image is node:22-bookworm (glibc); Beam's own image has no Node. Sandbox disk is not billed.
    name: "beam",
    adapter: "beam",
    product: null,
    lifetime: true,
    pricingKey: "beam",
    tracks: {
      "same-machine": {
        size: { cpu: 4, memoryMb: 8192 },
        vcpu: 4,
        provisioned: size(4, 8, 0),
        tooSmall: {},
      },
      default: {
        vcpu: 1,
        provisioned: size(1, 0.125, 0),
        tooSmall: { "fix-and-test": fit.beam128m, build: fit.beam128m },
      },
    },
  },
];

/** The size an attempt of `profile` provisions: its track's, plus a profile volume's disk. */
export function provisionedFor(setup: ProviderSetup, track: TrackId, profile: string) {
  const base = setup.tracks[track].provisioned;
  const volume = setup.profileFactory?.[profile]?.volume;

  return volume ? { ...base, diskGiB: base.diskGiB + volume.sizeGiB } : base;
}

/** The largest size any profile provisions on this track: for spend that is not recorded. */
export function provisionedAtMost(setup: ProviderSetup, track: TrackId): ProvisionedSize {
  const base = setup.tracks[track].provisioned;

  const volumes = Object.values(setup.profileFactory ?? {}).map((f) => f.volume?.sizeGiB ?? 0);

  return { ...base, diskGiB: base.diskGiB + Math.max(0, ...volumes) };
}

/**
 * The size a recorded attempt provisioned: its track's, plus the volume the record says it
 * mounted. A record without `volumeGiB` from a provider whose setup mounts volumes predates the
 * field, so whether it had one is unknown: null, which prices nothing rather than guessing.
 */
export function provisionedOf(
  setup: ProviderSetup,
  track: TrackId,
  record: { readonly volumeGiB?: number | undefined },
) {
  const base = setup.tracks[track].provisioned;

  if (record.volumeGiB !== undefined) return { ...base, diskGiB: base.diskGiB + record.volumeGiB };

  const mountsVolumes = Object.values(setup.profileFactory ?? {}).some((f) => f.volume);

  return mountsVolumes ? null : base;
}

export function providerSetup(name: string): ProviderSetup {
  const setup = providerSetups.find((s) => s.name === name);

  if (!setup)
    throw new Error(
      `Unknown provider ${name}; known: ${providerSetups.map((s) => s.name).join(", ")}`,
    );

  return setup;
}
