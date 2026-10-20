import { fillStyle } from "@/lib/dither";
import { providerColor, providerName } from "@/lib/providers";

export interface SimpleBar {
  provider: string;
  value: number;
  label: string;
  note?: string;
  /** In another currency: listed after the ranked bars, without a bar. */
  unranked?: boolean;
}

/** Bars for values that are not a latency distribution, such as prices. Sorted smallest first. */
export function SimpleBars({ bars, label }: { bars: SimpleBar[]; label: string }) {
  const ranked = bars.filter((b) => !b.unranked).sort((a, b) => a.value - b.value);
  const sorted = [...ranked, ...bars.filter((b) => b.unranked)];
  const max = Math.max(...ranked.map((b) => b.value), Number.EPSILON);
  return (
    <figure aria-label={label} className="bars flex flex-col gap-2.5">
      {sorted.map((bar) => {
        const color = providerColor(bar.provider);
        return (
          <div
            key={bar.provider}
            className="grid grid-cols-[7.5rem_1fr] items-center gap-x-4 gap-y-1 sm:grid-cols-[9rem_1fr]"
          >
            <span className="truncate text-[13px] font-medium" style={{ color }}>
              {providerName(bar.provider)}
            </span>
            <div className="flex h-5 items-center">
              {bar.unranked ? null : (
                <div
                  className="relative mr-2.5 h-full shrink-0"
                  style={{ width: `calc(${bar.value / max} * var(--longest) * 100%)`, minWidth: 3 }}
                >
                  <div
                    aria-hidden
                    className="absolute inset-0"
                    style={fillStyle("gradient", { color, edge: "right", length: 28, to: 0.12 })}
                  />
                  <div aria-hidden className="absolute inset-y-0 right-0 w-[3px]" style={{ backgroundColor: color }} />
                </div>
              )}
              <span className="font-mono text-[13px] whitespace-nowrap tabular-nums">{bar.label}</span>
            </div>
            {bar.note ? (
              <p className="col-start-2 max-w-prose text-[12px] leading-snug text-[var(--muted)]">{bar.note}</p>
            ) : null}
          </div>
        );
      })}
    </figure>
  );
}
