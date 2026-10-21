import type { ReactNode } from "react";

import { Columns } from "@/components/columns";
import type { Column } from "@/components/columns";
import { providers } from "@/lib/data";
import type { Metric, MetricValue } from "@/lib/data";
import { formatCount, formatShort, formatValue, unitName } from "@/lib/format";
import { providerColor, providerName } from "@/lib/providers";
import type { ProviderId } from "@/lib/providers";

export type Notes = Partial<Record<ProviderId, string>>;

/** A chart's title and its one-line "what and which way" subtitle, as Artificial Analysis writes them. */
export function ChartHead({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-[17px] font-medium tracking-tight">{title}</h3>
      <p className="mt-1 text-[12.5px] text-[var(--muted)]">{sub}</p>
    </div>
  );
}

export function Footnotes({ items }: { items: readonly { mark?: number; text: ReactNode }[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-5 flex flex-col gap-1.5 border-t border-[var(--line)] pt-4 text-[12px] leading-snug text-[var(--muted)]">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          {item.mark === undefined ? null : <span className="w-3 shrink-0 font-mono">{item.mark}</span>}
          <span className="max-w-[90ch]">{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

type Measured = MetricValue & { p50: number };
const isMeasured = (v: MetricValue): v is Measured => v.p50 !== null;

const missingReason = (v: MetricValue | undefined) =>
  !v ? "not supported" : v.limitFailures > 0 ? "stopped by our plan's limit" : v.failures > 0 ? "failed every attempt" : "not supported";

/** "100 attempts" or "30 attempts, 1 failed": every attempt counts, failed ones included. */
export const attemptsLine = (v: Pick<MetricValue, "n" | "failures">) => {
  const attempts = v.n + v.failures;
  return `${formatCount(attempts)} ${attempts === 1 ? "attempt" : "attempts"}${v.failures ? `, ${formatCount(v.failures)} failed` : ""}`;
};

const better = (m: Metric) => (m.better === "lower" ? "Lower is better" : "Higher is better");

export const metricSubtitle = (m: Metric, what: string) => `${what} · Median ${unitName[m.unit]} · ${better(m)}`;

/**
 * Median of one metric per provider, best first, with p95 and sample size on
 * hover. `compact` drops the title and footnotes for a headline card.
 */
export function MetricChart({
  metric,
  title = metric.label,
  what,
  notes = {},
  only,
  compact = false,
}: {
  metric: Metric;
  title?: string;
  /** What was timed, ahead of the unit and direction. */
  what: string;
  notes?: Notes;
  /** Limit the chart to these providers. */
  only?: readonly ProviderId[];
  compact?: boolean;
}) {
  const ids = only ?? providers.map((p) => p.id);
  const values = ids.map((id) => ({ id, value: metric.values.find((v) => v.provider === id) }));
  const sign = metric.better === "lower" ? 1 : -1;
  const measured = values
    .flatMap(({ value }) => (value && isMeasured(value) ? [value] : []))
    .sort((a, b) => sign * (a.p50 - b.p50));
  const missing = values.filter(({ value }) => !value || !isMeasured(value));
  // Providers left out of this chart on purpose still get their note.
  const leftOut = only ? providers.flatMap((p) => (only.includes(p.id) || !notes[p.id] ? [] : [p.id])) : [];

  let next = 0;
  const marks = new Map<ProviderId, number>();
  for (const v of measured) if (notes[v.provider]) marks.set(v.provider, ++next);

  const columns: Column[] = measured.map((v) => ({
    provider: v.provider,
    label: formatShort(v.p50, metric.unit),
    mark: marks.get(v.provider),
    segments: [{ value: v.p50, color: providerColor(v.provider), variant: "gradient" }],
    detail: [
      `median ${formatValue(v.p50, metric.unit)}`,
      ...(v.p95 === null ? [] : [`p95 ${formatValue(v.p95, metric.unit)}`]),
      ...(v.ciLow === null || v.ciHigh === null ? [] : [`95% CI ${formatValue(v.ciLow, metric.unit)}–${formatValue(v.ciHigh, metric.unit)}`]),
      attemptsLine(v),
    ],
  }));

  return (
    <>
      {compact ? null : <ChartHead title={title} sub={metricSubtitle(metric, what)} />}
      <Columns columns={columns} label={title} compact={compact} />
      {compact ? null : (
        <Footnotes
          items={[
            ...measured.flatMap((v) => {
              const note = notes[v.provider];
              return note ? [{ mark: marks.get(v.provider), text: <><Who id={v.provider} />: {note}</> }] : [];
            }),
            ...leftOut.map((id) => ({ text: <><Who id={id} />: {notes[id]}.</> })),
            ...(missing.length > 0
              ? [
                  {
                    text: (
                      <>
                        No result for{" "}
                        {missing.map(({ id, value }, i) => (
                          <span key={id}>
                            {i > 0 ? "; " : ""}
                            <Who id={id} /> ({notes[id] ?? missingReason(value)})
                          </span>
                        ))}
                        .
                      </>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
    </>
  );
}

export const Who = ({ id }: { id: ProviderId }) => (
  <span className="font-medium" style={{ color: providerColor(id) }}>
    {providerName(id)}
  </span>
);
