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

/** The size every price comparison uses, so providers are priced on the same machine. */
export const commonSize = { vcpu: 2, memoryGiB: 4, label: "2 vCPU, 4 GB" } as const;

/**
 * What a 2 vCPU, 4 GB sandbox costs per hour at each provider's published
 * rates, in dollars. A provider that sells one fixed machine (Boat) is priced
 * at that machine, and `fixed` says which.
 */
export function commonPrice(p: Provider) {
  const r = p.rates;
  if (!r) return null;
  const toUsd = (v: number) => (p.currency === "EUR" ? v * eurUsd.rate : v);
  if (r.fixed && r.fixedHour !== null) {
    return { usd: toUsd(r.fixedHour), fixed: `${r.fixed.cpu} vCPU, ${r.fixed.memoryGiB} GB` };
  }
  return { usd: toUsd(commonSize.vcpu * r.vcpuHour + commonSize.memoryGiB * r.memoryGiBHour), fixed: null };
}
