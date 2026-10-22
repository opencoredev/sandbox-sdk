/** Provisioned resources, not kernel-usable RAM. Sources checked 2026-10-21:
 * E2B template builds and e2b.dev/pricing; Daytona snapshot metadata and
 * daytona.io/docs/en/sandboxes; Superserve template builds; provider defaults
 * documented in apps/bench-site/src/lib/sizes.ts. Unknown templates fail closed.
 * Tenki does not document default CPU/RAM, so it intentionally has no entry.
 */
interface ProvisionedAllocation { cpu: number; memoryGiB: number; diskGiB?: number }
const templates: Record<string, Record<string, ProvisionedAllocation>> = {
  e2b: {
    "sandbox-bench-same-spec": {cpu: 4, memoryGiB: 8},
    r1h7gud12rf1f6iu29r0: {cpu: 4, memoryGiB: 8},
    "sandbox-bench-advertised-default": {cpu: 2, memoryGiB: 4},
    base: {cpu: 2, memoryGiB: 0.5},
  },
  daytona: {"daytona-large": {cpu: 4, memoryGiB: 8, diskGiB: 10}},
  superserve: {
    "sandbox-bench-node22-py311-1x1": {cpu: 1, memoryGiB: 1, diskGiB: 4},
    "sandbox-bench-node22-py311-1x1-pinned": {cpu: 1, memoryGiB: 1, diskGiB: 4},
    "522daf7b-fec9-41d8-80cd-361f3b8b1fa8": {cpu: 1, memoryGiB: 1, diskGiB: 4},
  },
};
const defaults: Record<string, ProvisionedAllocation> = {
  e2b: {cpu: 2, memoryGiB: 0.5},
  daytona: {cpu: 1, memoryGiB: 1, diskGiB: 3},
  upstash: {cpu: 2, memoryGiB: 4, diskGiB: 5},
  boat: {cpu: 4, memoryGiB: 8, diskGiB: 50},
  boxd: {cpu: 2, memoryGiB: 8, diskGiB: 100},
  freestyle: {cpu: 4, memoryGiB: 8, diskGiB: 32},
  superserve: {cpu: 1, memoryGiB: 1, diskGiB: 4},
};
export function provisionedAllocation(provider: string, template: string | null) {
  return (template ? templates[provider]?.[template] : defaults[provider]) ?? null;
}
