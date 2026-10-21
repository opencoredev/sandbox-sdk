import type { Provider } from "@/lib/data";
import { formatGiB, formatMoney } from "@/lib/format";
import { usdPrice } from "@/lib/fx";
import { providerColor, providerName } from "@/lib/providers";
import { sizeOf } from "@/lib/sizes";

/** Shorter forms for city names too long for a card. */
const shortPlace = (place: string) => place.replace("Frankfurt am Main", "Frankfurt");

/**
 * Every provider at a glance, four fixed lines each: name, where its
 * sandboxes ran, default size and hourly price.
 */
export function ProviderStrip({ providers }: { providers: readonly Provider[] }) {
  return (
    <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4 lg:grid-cols-8">
      {providers.map((p) => {
        const size = sizeOf(p);
        const price = usdPrice(p, "hourly");
        const place = p.hardware?.location[0]?.value;
        return (
          <li key={p.id} className="min-w-0 bg-[var(--surface)] px-4 py-3">
            <p className="truncate text-[13.5px] font-medium" style={{ color: providerColor(p.id) }}>
              {providerName(p.id)}
            </p>
            <p className="mt-0.5 truncate text-[12.5px]" title={place}>
              {place ? shortPlace(place) : <span className="text-[var(--muted)]">Region not shown</span>}
            </p>
            <p className="mt-1.5 font-mono text-[11.5px] whitespace-nowrap text-[var(--muted)] tabular-nums">
              {size.vcpu ?? "?"} vCPU · {size.memoryGiB === null ? "?" : formatGiB(size.memoryGiB)}
            </p>
            <p className="font-mono text-[11.5px] whitespace-nowrap tabular-nums">{price ? `${formatMoney(price.usd, "USD")} / hour` : "—"}</p>
          </li>
        );
      })}
    </ul>
  );
}
