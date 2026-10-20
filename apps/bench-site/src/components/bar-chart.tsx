import { fillStyle } from "@/lib/dither";
import type { Metric, MetricValue } from "@/lib/data";
import { formatCount, formatValue } from "@/lib/format";
import { providerColor, providerName } from "@/lib/providers";

export type RowNotes = Partial<Record<string, string>>;

type Row =
  | { provider: string; kind: "value"; value: MetricValue & { p50: number } }
  | { provider: string; kind: "missing"; reason: string };

function rows(metric: Metric, providers: readonly string[]): Row[] {
  const measured: Row[] = [];
  const missing: Row[] = [];
  for (const provider of providers) {
    const value = metric.values.find((v) => v.provider === provider);
    if (value && value.p50 !== null) {
      measured.push({ provider, kind: "value", value: { ...value, p50: value.p50 } });
    } else if (value && value.limitFailures > 0) {
      missing.push({ provider, kind: "missing", reason: "Stopped by an account limit" });
    } else if (value && value.failures > 0) {
      missing.push({ provider, kind: "missing", reason: "Failed every attempt" });
    } else {
      missing.push({ provider, kind: "missing", reason: "Not supported" });
    }
  }
  const sign = metric.better === "lower" ? 1 : -1;
  measured.sort((a, b) =>
    a.kind === "value" && b.kind === "value" ? sign * (a.value.p50 - b.value.p50) : 0,
  );
  return [...measured, ...missing];
}

/**
 * Horizontal bars, one per provider, sorted best first. The bar is the median;
 * the 95th percentile is printed beside it.
 */
export function BarChart({
  metric,
  providers,
  notes = {},
  showP95 = true,
}: {
  metric: Metric;
  providers: readonly string[];
  notes?: RowNotes;
  showP95?: boolean;
}) {
  const list = rows(metric, providers);
  const max = Math.max(
    ...list.flatMap((r) => (r.kind === "value" ? [r.value.p50] : [])),
    Number.EPSILON,
  );
  const width = (v: number) => `calc(${v / max} * var(--longest) * 100%)`;
  return (
    <figure className="bars flex flex-col gap-2.5">
      {list.map((row) => {
        const color = providerColor(row.provider);
        const note = notes[row.provider];
        return (
          <div
            key={row.provider}
            className="grid grid-cols-[7.5rem_1fr] items-center gap-x-4 gap-y-1 sm:grid-cols-[9rem_1fr]"
          >
            <span className="truncate text-[13px] font-medium" style={{ color }}>
              {providerName(row.provider)}
            </span>
            {row.kind === "value" ? (
              <div className="flex h-5 items-center">
                <div
                  className="relative h-full shrink-0"
                  style={{ width: width(row.value.p50), minWidth: 3 }}
                >
                  <div
                    aria-hidden
                    className="absolute inset-0"
                    style={fillStyle("gradient", { color, edge: "right", length: 28, to: 0.12 })}
                  />
                  <div
                    aria-hidden
                    className="absolute inset-y-0 right-0 w-[3px]"
                    style={{ backgroundColor: color }}
                  />
                </div>
                <span className="ml-2.5 font-mono text-[13px] whitespace-nowrap tabular-nums">
                  {formatValue(row.value.p50, metric.unit)}
                  {showP95 && metric.better === "lower" && row.value.p95 !== null ? (
                    <span className="ml-2 text-[11px] text-[var(--muted)]">
                      p95 {formatValue(row.value.p95, metric.unit)}
                    </span>
                  ) : null}
                </span>
                <span className="sr-only">
                  {providerName(row.provider)}: median {formatValue(row.value.p50, metric.unit)},{" "}
                  {formatCount(row.value.n)} runs
                </span>
              </div>
            ) : (
              <span className="text-[13px] text-[var(--muted)]">{row.reason}</span>
            )}
            {note ? (
              <p className="col-start-2 max-w-prose text-[12px] leading-snug text-[var(--muted)]">
                {note}
              </p>
            ) : null}
          </div>
        );
      })}
    </figure>
  );
}
