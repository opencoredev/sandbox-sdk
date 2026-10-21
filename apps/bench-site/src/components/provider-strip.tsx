import type { Provider } from "@/lib/data";
import { formatGiB, formatMoney } from "@/lib/format";
import { usdPrice } from "@/lib/fx";
import { providerColor, providerName } from "@/lib/providers";
import { sizeOf } from "@/lib/sizes";

/**
 * Every provider at a glance: where its sandboxes ran, how big the default
 * machine is and what an hour costs. Region matters because every call
 * started in Florida.
 */
export function ProviderStrip({ providers }: { providers: readonly Provider[] }) {
  return (
    <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4 lg:grid-cols-8">
      {providers.map((p) => {
        const size = sizeOf(p);
        const price = usdPrice(p, "hourly");
        return (
          <li key={p.id} className="bg-[var(--surface)] px-4 py-3.5">
            <p className="text-[13.5px] font-medium" style={{ color: providerColor(p.id) }}>
              {providerName(p.id)}
            </p>
            <p className="mt-1 text-[12.5px] leading-snug">{p.hardware?.location[0]?.value ?? "Region not reported"}</p>
            <p className="mt-0.5 font-mono text-[11.5px] text-[var(--muted)] tabular-nums">
              {size.vcpu ?? "?"} vCPU · {size.memoryGiB === null ? "?" : formatGiB(size.memoryGiB)}
              {price ? ` · ${formatMoney(price.usd, "USD")}/h` : ""}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
