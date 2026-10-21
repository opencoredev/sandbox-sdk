import type { Provider } from "@/lib/data";
import type { ProviderId } from "@/lib/providers";

/**
 * The size each provider advertises for the sandbox we got, from its own docs
 * (checked 2026-10-21), or null where the docs don't say. Measured values sit
 * a little lower because the kernel keeps some memory and the filesystem
 * keeps some disk. `note` explains any gap between advertised and tested.
 */
export const advertised = {
  e2b: {
    vcpu: 2,
    memoryGiB: 0.5,
    diskGiB: null,
    source: "https://e2b.dev/pricing",
    note: "The SDK starts E2B's base template, a 512 MB machine. E2B's pricing page says its default sandbox has 4 GiB, so E2B ran smaller here than its advertised default.",
  },
  daytona: { vcpu: 1, memoryGiB: 1, diskGiB: 3, source: "https://www.daytona.io/docs/en/sandboxes/", note: null },
  upstash: { vcpu: 2, memoryGiB: 4, diskGiB: 5, source: "https://upstash.com/pricing/box", note: null },
  boat: { vcpu: 4, memoryGiB: 8, diskGiB: 50, source: "https://docs.boat.dev/machines", note: null },
  boxd: { vcpu: 2, memoryGiB: 8, diskGiB: 100, source: "https://boxd.sh/", note: null },
  freestyle: { vcpu: 4, memoryGiB: 8, diskGiB: 32, source: "https://www.freestyle.sh/docs/guides/run-hexclave-in-a-sandbox", note: null },
  tenki: {
    vcpu: null,
    memoryGiB: null,
    diskGiB: 5,
    source: "https://tenki.cloud/docs/sandbox/cli.md",
    note: "Tenki documents a 5 GiB default disk but not a default vCPU or RAM, so those are what we measured.",
  },
  superserve: {
    vcpu: 1,
    memoryGiB: 1,
    diskGiB: 4,
    source: "https://docs.superserve.ai",
    note: "The SDK starts Superserve's node-22 template, because its base template has no Node or Python. Both are 1 vCPU, 1 GiB RAM, 4 GiB disk.",
  },
} as const satisfies Record<
  ProviderId,
  { vcpu: number | null; memoryGiB: number | null; diskGiB: number | null; source: string; note: string | null }
>;

/** The size to show: advertised where the provider states it, otherwise what we measured inside. */
export function sizeOf(p: Provider) {
  const a = advertised[p.id];
  return {
    vcpu: a.vcpu ?? p.hardware?.vcpu ?? null,
    memoryGiB: a.memoryGiB ?? p.hardware?.memoryGiB ?? null,
    diskGiB: a.diskGiB ?? p.hardware?.diskGiB ?? null,
  };
}
