export interface Resources {
  cpu: number;
  memoryGiB: number;
  diskGiB: number;
}

export interface MachineTier {
  cpu: number;
  memoryGiB: number;
  hourly: number;
}

export interface Price {
  currency: "USD" | "EUR";
  cpuSecond: number;
  memoryGiBSecond: number;
  diskGiBSecond: number;
  freeDiskGiB: number;
  minimumSeconds: number;
  incrementSeconds: number;
  perSandbox: number;
  source: string;
  retrieved: string;
  notes: string;
  fixed: Resources | null;
  fixedHour: number | null;
  tiers: MachineTier[] | null;
  offeredSizes: Pick<Resources, "cpu" | "memoryGiB">[] | null;
  /**
   * Billed on the requested allocation, so the guest's own view is never priced. `minimum` is the
   * request of a sandbox created without a size: a lower bound when usage above it is also billed.
   */
  requestBilled: { minimum: Pick<Resources, "cpu" | "memoryGiB"> } | null;
  /** Price multipliers for a pinned region: `broad` for one of `broadRegions`, `narrow` for any other. */
  regionMultiplier: { broad: number; narrow: number; broadRegions: readonly string[] } | null;
}

const base = {
  currency: "USD",
  minimumSeconds: 0,
  incrementSeconds: 1,
  perSandbox: 0,
  freeDiskGiB: 0,
  retrieved: "2026-10-21",
  fixed: null,
  fixedHour: null,
  tiers: null,
  offeredSizes: null,
  requestBilled: null,
  regionMultiplier: null,
} satisfies Partial<Price>;

/** Published prices, keyed by provider name. */
export interface PriceTable {
  readonly [provider: string]: Price;
}

export const pricing: PriceTable = {
  superserve: {
    ...base,
    cpuSecond: 0.0504 / 3600,
    memoryGiBSecond: 0.0162 / 3600,
    diskGiBSecond: 0,
    retrieved: "2026-10-21",
    source: "https://www.superserve.ai/pricing",
    notes:
      "Published vCPU and GiB-hour rates converted to seconds. Credits excluded. One-second rounding assumed; snapshot storage, disk, transfer and any minimum charge excluded. Adapter default superserve/node-22 is 1 vCPU, 1 GiB RAM, 4 GiB disk; resources are template-owned. SDK runtime preparation is included in cold timing.",
  },
  e2b: {
    ...base,
    cpuSecond: 0.000014,
    memoryGiBSecond: 0.0000045,
    diskGiBSecond: 0,
    source: "https://e2b.dev/pricing",
    notes:
      "10 GiB Hobby / 20 GiB Pro included disk. Subscription excluded. Per-second billing; no separate creation fee listed.",
  },
  daytona: {
    ...base,
    cpuSecond: 0.0504 / 3600,
    memoryGiBSecond: 0.0162 / 3600,
    diskGiBSecond: 0.000108 / 3600,
    freeDiskGiB: 5,
    source: "https://www.daytona.io/pricing",
    notes:
      "Hourly published rates converted to seconds. Assumed one-second increment; minimum and creation fee not stated. Snapshot storage excluded.",
  },
  upstash: {
    ...base,
    cpuSecond: 0,
    // https://upstash.com/pricing/box: size table + engineer confirmation take
    // precedence over the contradictory FAQ example. These are per-box rates.
    tiers: [
      { cpu: 2, memoryGiB: 4, hourly: 0.1 },
      { cpu: 4, memoryGiB: 8, hourly: 0.2 },
      { cpu: 8, memoryGiB: 16, hourly: 0.4 },
    ],
    memoryGiBSecond: 0,
    diskGiBSecond: 0.1 / (30 * 86400),
    source: "https://upstash.com/pricing/box",
    notes:
      "PAYG ACTIVE CPU billing: Small $0.10, Medium $0.20, Large $0.40 per active box-hour; tier price × wall time is an upper-bound estimate, not metered usage. Disk allocated capacity is an upper bound for written data. 30-day month. No RAM fee listed. Increment/minimum unspecified.",
  },
  boat: {
    ...base,
    cpuSecond: 0,
    memoryGiBSecond: 0,
    diskGiBSecond: 0,
    perSandbox: 0,
    source: "https://docs.boat.dev/machines",
    fixed: { cpu: 4, memoryGiB: 8, diskGiB: 50 },
    fixedHour: 0.036,
    tiers: [
      { cpu: 2, memoryGiB: 4, hourly: 0.018 },
      { cpu: 4, memoryGiB: 8, hourly: 0.036 },
      { cpu: 8, memoryGiB: 16, hourly: 0.072 },
      { cpu: 16, memoryGiB: 32, hourly: 0.2 },
    ],
    notes:
      "Default VM $0.036/hour (4 vCPU, 8 GB, 50 GB). Flat rate for each size; Small, Large and Xlarge are also offered. $20 monthly minimum/packs excluded; billed per second.",
  },
  boxd: {
    ...base,
    currency: "EUR",
    // https://docs.boxd.sh/guides/resources: naming either dimension picks a shape.
    offeredSizes: [
      { cpu: 1, memoryGiB: 4 },
      { cpu: 2, memoryGiB: 8 },
      { cpu: 4, memoryGiB: 16 },
      { cpu: 8, memoryGiB: 32 },
    ],
    cpuSecond: 0.039 / 3600,
    memoryGiBSecond: 0.012 / 3600,
    diskGiBSecond: 0.00008 / 3600,
    source: "https://boxd.sh/pricing",
    notes:
      "EUR; RAM in use and written disk billed, so allocated resources are an upper bound. Metered per second, settled every 15 minutes (not a rounding increment). FX budget uses conservative 2 USD/EUR, not a market quote.",
  },
  freestyle: {
    ...base,
    cpuSecond: 0.04032 / 3600,
    memoryGiBSecond: 0.0129 / 3600,
    diskGiBSecond: 0.000086 / 3600,
    source: "https://www.freestyle.sh/pricing",
    notes:
      "Published overage rates, allowances/subscriptions excluded. $0.02/GB transfer excluded. Billing increment/minimum and creation fees unspecified; one-second estimate.",
  },
  tenki: {
    ...base,
    cpuSecond: 0.000014,
    memoryGiBSecond: 0.0000045,
    diskGiBSecond: 0.00000003,
    freeDiskGiB: 5,
    source: "https://tenki.cloud/pricing",
    notes:
      "Per-second, no minimum. Separate persistent storage $0.000000076/GiB-second excluded. Credits excluded.",
  },
  modal: {
    ...base,
    // Sandbox rates, three times the Function rates: sandboxes are billed as non-preemptible.
    cpuSecond: 0.00003942,
    memoryGiBSecond: 0.00000667,
    diskGiBSecond: 0,
    retrieved: "2026-11-09",
    source: "https://modal.com/pricing",
    requestBilled: { minimum: { cpu: 0.125, memoryGiB: 0.125 } },
    // https://modal.com/docs/guide/region-selection
    regionMultiplier: { broad: 1.15, narrow: 1.75, broadRegions: ["us", "eu", "ap"] },
    notes:
      "Sandbox rates ($0.1419 per CPU-hour, $0.024 per GiB-hour; one Modal CPU is a physical core). Billed per second on max(request, usage), minimum request 0.125 CPU. Priced on the requested allocation, never on the guest's MemTotal, which shows the host's memory without a size. A sized sandbox pins request = limit, so its estimate is exact. The default track (0.125 CPU, 128 MiB request) bursts into spare host capacity and that usage is billed too, so its estimate is a lower bound. A pinned region adds 1.15x (broad, such as us) or 1.75x (narrow, such as us-east). No disk charge or creation fee listed; plan credits excluded.",
  },
  vercel: {
    ...base,
    // https://vercel.com/docs/sandbox/pricing (updated 2026-09-10), Pro, iad1. Active CPU is CPU time
    // summed over vCPUs, so pricing the whole allocation is an upper bound; memory is the allocation.
    cpuSecond: 0.128 / 3600,
    memoryGiBSecond: 0.0212 / 3600,
    diskGiBSecond: 0,
    perSandbox: 0.6 / 1_000_000,
    // "Billed in 1 minute minimum increments" (memory): read as whole minutes, the dearer reading.
    minimumSeconds: 60,
    incrementSeconds: 60,
    retrieved: "2026-11-09",
    offeredSizes: [1, 2, 4, 6, 8].map((cpu) => ({ cpu, memoryGiB: cpu * 2 })),
    source: "https://vercel.com/docs/sandbox/pricing",
    notes:
      "Pro, iad1: active CPU $0.128 per vCPU-hour of CPU time (I/O wait not billed), memory $0.0212 per GB-hour of wall time in one-minute minimum increments, $0.60 per million creations. Vercel's docs leave rounding after the first minute open; we charge whole minutes, the dearer reading. Metered: the bench stops each sandbox to read Vercel's meter before deleting it, so the meter includes the stop's disk snapshot (about 3% in one probe; approximate, not corrected per task). Hourly assumes every vCPU busy. Pro's $20 credit, data transfer and snapshot storage excluded.",
  },
  local: {
    ...base,
    cpuSecond: 0,
    memoryGiBSecond: 0,
    diskGiBSecond: 0,
    source: "https://www.docker.com/products/docker-engine/",
    notes:
      "Reference baseline only: host hardware, power, network and administration cost excluded; zero marginal provider charge.",
  },
};

/** The price multiplier for a pinned region. Modal charges a list mixing broad and narrow regions at the smaller one. */
export function regionMultiplier(provider: string, region: string | null | undefined): number {
  const multiplier = pricing[provider]?.regionMultiplier;

  if (!multiplier || !region?.trim()) return 1;

  return Math.min(
    ...region
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) =>
        multiplier.broadRegions.includes(entry) ? multiplier.broad : multiplier.narrow,
      ),
  );
}

/** Compute only; measured RAM can be lower than a tier's provisioned RAM. */
export function computeHourly(p: Price, r: Pick<Resources, "cpu" | "memoryGiB">): number | null {
  if (p.tiers)
    return p.tiers.find((t) => t.cpu === r.cpu && r.memoryGiB <= t.memoryGiB)?.hourly ?? null;

  if (p.fixed) return p.fixedHour;

  return (r.cpu * p.cpuSecond + r.memoryGiB * p.memoryGiBSecond) * 3600;
}

/** Exact offered allocation for a like-for-like comparison, without disk. */
export function priceAtSize(
  provider: string,
  r: Pick<Resources, "cpu" | "memoryGiB">,
): number | null {
  const p = pricing[provider];

  if (!p) return null;
  const offered = p.tiers ?? p.offeredSizes ?? (p.fixed ? [p.fixed] : null);

  if (offered && !offered.some((t) => t.cpu === r.cpu && t.memoryGiB === r.memoryGiB)) return null;

  return computeHourly(p, r);
}

// Provisioned sizes of the templates actually benchmarked, not kernel-usable
// RAM. Tenki does not document its default, so it stays measured.
interface ComputeTable {
  readonly [provider: string]: Pick<Resources, "cpu" | "memoryGiB">;
}

export const defaultCompute: ComputeTable = {
  e2b: { cpu: 2, memoryGiB: 0.5 },
  daytona: { cpu: 1, memoryGiB: 1 },
  upstash: { cpu: 2, memoryGiB: 4 },
  boat: { cpu: 4, memoryGiB: 8 },
  boxd: { cpu: 2, memoryGiB: 8 },
  freestyle: { cpu: 4, memoryGiB: 8 },
  superserve: { cpu: 1, memoryGiB: 1 },
  vercel: { cpu: 2, memoryGiB: 4 },
};

export function estimateCost(
  provider: string,
  durationMs: number,
  resources: Resources | null,
  region: string | null = null,
): number | null {
  const p = pricing[provider];

  if (!p) return null;

  if (provider === "local") return 0;
  const r = p.fixed ?? resources;

  if (!r) return null;

  const seconds = Math.max(
    p.minimumSeconds,
    Math.ceil(durationMs / 1000 / p.incrementSeconds) * p.incrementSeconds,
  );

  const compute = computeHourly(p, r);

  if (compute === null) return null;

  return (
    seconds *
      (compute / 3600 + Math.max(0, r.diskGiB - p.freeDiskGiB) * p.diskGiBSecond) *
      regionMultiplier(provider, region) +
    p.perSandbox
  );
}

// Conservative allocation for iterations without a fingerprint (e.g. a failed create).
export const fallbackResources: Resources = { cpu: 8, memoryGiB: 16, diskGiB: 100 };

/** Budget charge for one finished iteration: measured duration at observed, previously observed, or conservative resources. */
export function settledBudgetUSD(
  provider: string,
  durationMs: number,
  observed: Resources | null,
  previous: Resources | null,
): number | null {
  const cost = estimateCost(provider, durationMs, observed ?? previous ?? fallbackResources);

  return cost === null ? null : budgetUSD(provider, cost);
}

export function budgetUSD(provider: string, cost: number) {
  return cost * (pricing[provider]?.currency === "EUR" ? 2 : 1);
}
