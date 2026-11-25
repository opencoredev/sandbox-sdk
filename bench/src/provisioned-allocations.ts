/** Provisioned resources, not kernel-usable RAM. Sources checked 2026-10-21:
 * E2B template builds and e2b.dev/pricing; Daytona snapshot metadata and
 * daytona.io/docs/en/sandboxes; Superserve template builds; provider defaults
 * documented in apps/bench-site/src/lib/sizes.ts. Unknown templates fail closed.
 * Luxor does not document default CPU/RAM, so it intentionally has no entry.
 */
interface ProvisionedAllocation {
  cpu: number;
  memoryGiB: number;
  diskGiB?: number;
  documentedDisk?: { value: number; unit: "GB"; scope: string; source: string };
}

/** Allocations of known templates, by provider and then template. */
interface TemplateAllocations {
  readonly [provider: string]: Record<string, ProvisionedAllocation>;
}

const templates: TemplateAllocations = {
  e2b: {
    "sandbox-bench-same-spec": { cpu: 4, memoryGiB: 8 },
    r1h7gud12rf1f6iu29r0: { cpu: 4, memoryGiB: 8 },
    "sandbox-bench-advertised-default": { cpu: 2, memoryGiB: 4 },
    base: { cpu: 2, memoryGiB: 0.5 },
  },
  daytona: { "daytona-large": { cpu: 4, memoryGiB: 8, diskGiB: 10 } },
  // Maritime's stock templates start at its default size, small (https://maritime.sh/docs/limits).
  maritime: {
    base: { cpu: 2, memoryGiB: 4, diskGiB: 12 },
    python: { cpu: 2, memoryGiB: 4, diskGiB: 12 },
    "code-interpreter": { cpu: 2, memoryGiB: 4, diskGiB: 12 },
  },
  // GET /templates on 2026-11-23; df on /workspace read 51G for base.
  styne: {
    base: { cpu: 4, memoryGiB: 8, diskGiB: 51 },
    default: { cpu: 4, memoryGiB: 8, diskGiB: 51 },
    small: { cpu: 2, memoryGiB: 4, diskGiB: 51 },
    large: { cpu: 8, memoryGiB: 16, diskGiB: 111 },
    xlarge: { cpu: 16, memoryGiB: 32, diskGiB: 251 },
  },
  superserve: {
    "sandbox-bench-node22-py311-1x1": { cpu: 1, memoryGiB: 1, diskGiB: 4 },
    "sandbox-bench-node22-py311-1x1-pinned": { cpu: 1, memoryGiB: 1, diskGiB: 4 },
    "522daf7b-fec9-41d8-80cd-361f3b8b1fa8": { cpu: 1, memoryGiB: 1, diskGiB: 4 },
    // Same-spec template; Template.list reported 4 vCPU / 8192 MiB / 4096 MiB disk on 2026-10-22.
    "sandbox-bench-node22-py311-4x8-pinned": { cpu: 4, memoryGiB: 8, diskGiB: 4 },
    "bd88e7c5-139e-419f-9a73-8d2ec34d3edf": { cpu: 4, memoryGiB: 8, diskGiB: 4 },
  },
};

interface DefaultAllocations {
  readonly [provider: string]: ProvisionedAllocation;
}

const defaults: DefaultAllocations = {
  e2b: { cpu: 2, memoryGiB: 0.5 },
  daytona: { cpu: 1, memoryGiB: 1, diskGiB: 3 },
  upstash: { cpu: 2, memoryGiB: 4, diskGiB: 5 },
  boat: {
    cpu: 4,
    memoryGiB: 8,
    documentedDisk: {
      value: 50,
      unit: "GB",
      scope: "User files; excludes operating system and pre-installed tools",
      source: "https://docs.boat.dev/machines",
    },
  },
  boxd: { cpu: 2, memoryGiB: 8, diskGiB: 100 },
  freestyle: { cpu: 4, memoryGiB: 8, diskGiB: 32 },
  superserve: { cpu: 1, memoryGiB: 1, diskGiB: 4 },
  // https://vercel.com/docs/sandbox/pricing: 2 vCPUs by default, 2 GB per vCPU, 64 GB NVMe.
  vercel: { cpu: 2, memoryGiB: 4, diskGiB: 64 },
  // Files live in memory (half of it by default), so no disk is provisioned.
  baseten: { cpu: 2, memoryGiB: 4, diskGiB: 0 },
  // agent-browser default: 4 vCPU / 8 GiB, 20 GiB /data (where /workspace lives) plus a 16 GiB system disk.
  instabox: { cpu: 4, memoryGiB: 8, diskGiB: 20 },
  // The base template: 4 vCPU / 8 GiB with a 51 GiB root disk (df on /workspace, 2026-11-23).
  styne: { cpu: 4, memoryGiB: 8, diskGiB: 51 },
  // Beam's TypeScript SDK default, 1 CPU and 128 MiB; sandbox disk is not billed.
  beam: { cpu: 1, memoryGiB: 0.125, diskGiB: 0 },
  // Archil's default, 1 vCPU and 2048 MiB. The root disk (about 1 TB, not configurable) bills
  // stored data as storage, not a provisioned size, so none is counted.
  archil: { cpu: 1, memoryGiB: 2, diskGiB: 0 },
  // Maritime's default size, small: 2 vCPU / 4 GiB with a 12 GiB root disk (nproc, df, 2026-11-23).
  maritime: { cpu: 2, memoryGiB: 4, diskGiB: 12 },
  // Microsandbox Cloud's create defaults (CloudSandboxComputeResources, openapi.json 2026-11-24):
  // 1 vCPU / 512 MiB. The default root disk is not documented, so none is counted until a live run
  // measures it.
  microsandbox: { cpu: 1, memoryGiB: 0.5 },
  "microsandbox-shared": { cpu: 1, memoryGiB: 0.5 },
};

export function provisionedAllocation(provider: string, template: string | null) {
  return (template ? templates[provider]?.[template] : defaults[provider]) ?? null;
}
