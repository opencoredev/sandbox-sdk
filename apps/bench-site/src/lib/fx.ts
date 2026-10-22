import type { Provider } from "@/lib/data";
import { formatMoney } from "@/lib/format";

/** ECB euro reference rate used to put euro prices on the dollar charts. */
export const eurUsd = {
  rate: 1.1234,
  date: "October 21, 2026",
  source: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
} as const;

export type PriceKey = "hourly" | "perVcpuHour";

/** A provider's price in dollars, converted from euros where it bills in euros. */
export function usdPrice(p: Provider, key: PriceKey) {
  const value = p[key];
  if (value === null) return null;
  return p.currency === "EUR"
    ? { usd: value * eurUsd.rate, converted: true, original: formatMoney(value, "EUR") }
    : { usd: value, converted: false, original: formatMoney(value, p.currency) };
}

/** The footnote for a converted price. */
export const conversionNote = (original: string, per: string) =>
  `bills in euros, ${original} ${per}, converted at the ECB rate of ${eurUsd.rate} dollars per euro on ${eurUsd.date}.`;

/**
 * The size every price comparison uses, so providers are priced on the same
 * machine. It is Boat's only machine, the one size every provider can be
 * priced at without guessing.
 */
export const commonSize = { vcpu: 4, memoryGiB: 8, label: "4 vCPU, 8 GB" } as const;

/**
 * What a 4 vCPU, 8 GB sandbox costs per hour at each provider's published
 * rates, in dollars. A provider that sells one fixed machine is priced at
 * that machine, and `fixed` names it when it differs from the common size.
 */
export function commonPrice(p: Provider) {
  const r = p.rates;
  if (!r) return null;
  const toUsd = (v: number) => (p.currency === "EUR" ? v * eurUsd.rate : v);
  if (r.fixed && r.fixedHour !== null) {
    const same = r.fixed.cpu === commonSize.vcpu && r.fixed.memoryGiB === commonSize.memoryGiB;
    return { usd: toUsd(r.fixedHour), fixed: same ? null : `${r.fixed.cpu} vCPU, ${r.fixed.memoryGiB} GB` };
  }
  return { usd: toUsd(commonSize.vcpu * r.vcpuHour + commonSize.memoryGiB * r.memoryGiBHour), fixed: null };
}
