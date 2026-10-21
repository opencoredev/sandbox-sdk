import type { ProviderId } from "@/lib/providers";

/**
 * The size each provider advertises for the sandbox we got, from its own docs
 * (checked 2026-10-21). Measured values sit a little lower because the kernel
 * keeps some memory and the filesystem keeps some disk. `note` explains any
 * gap between what is advertised and what we tested.
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
  tenki: { vcpu: 2, memoryGiB: 4, diskGiB: 5, source: "https://tenki.cloud/", note: null },
} as const satisfies Record<
  ProviderId,
  { vcpu: number; memoryGiB: number; diskGiB: number | null; source: string; note: string | null }
>;
