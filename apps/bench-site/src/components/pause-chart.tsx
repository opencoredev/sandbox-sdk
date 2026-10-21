import { Columns } from "@/components/columns";
import type { Column } from "@/components/columns";
import { ChartHead, Footnotes, MetricChart, Who } from "@/components/metric-chart";
import { fillStyle } from "@/lib/dither";
import { metric, providers } from "@/lib/data";
import type { Provider } from "@/lib/data";
import { formatShort, formatValue } from "@/lib/format";
import { providerColor } from "@/lib/providers";
import type { ProviderId } from "@/lib/providers";

const what = "Pause, resume, then run a command";

const list = (ps: readonly { id: ProviderId }[]) =>
  ps.map((p, i) => (
    <span key={p.id}>
      {i > 0 ? ", " : ""}
      <Who id={p.id} />
    </span>
  ));

/**
 * Pause and resume as two parts of one column: hatched resume at the
 * bottom, dithered pause on top, so a slow pause and a slow resume look
 * different. Falls back to the single total until the data records them apart.
 */
export function PauseChart() {
  const m = metric("pause-resume");
  if (!providers.some((p) => p.pauseSplit)) return <MetricChart metric={m} what={what} />;

  // Providers with the split get two parts; any with only a total keep one column.
  const columns: Column[] = providers
    .flatMap((p): { p: Provider; sum: number; split: Provider["pauseSplit"] }[] => {
      const total = m.values.find((v) => v.provider === p.id)?.p50 ?? null;
      if (p.pauseSplit) return [{ p, sum: p.pauseSplit.pause + p.pauseSplit.resume, split: p.pauseSplit }];
      return total === null ? [] : [{ p, sum: total, split: null }];
    })
    .sort((a, b) => a.sum - b.sum)
    .map(({ p, sum, split: parts }) => ({
      provider: p.id,
      label: formatShort(sum, "s"),
      segments: parts
        ? [
            { value: parts.resume, color: providerColor(p.id), variant: "hatched" },
            { value: parts.pause, color: providerColor(p.id), variant: "gradient" },
          ]
        : [{ value: sum, color: providerColor(p.id), variant: "gradient" }],
      detail: parts
        ? [`pause ${formatValue(parts.pause, "s")}`, `resume ${formatValue(parts.resume, "s")}`, `${parts.n} attempts`]
        : [`median ${formatValue(sum, "s")}`, "pause and resume not recorded apart"],
    }));
  const unsupported = providers.filter((p) => !p.pauseSplit && !m.values.some((v) => v.provider === p.id && v.p50 !== null));
  const whole = providers.filter((p) => !p.pauseSplit && !unsupported.includes(p));

  return (
    <>
      <ChartHead title="Pause + resume" sub={`${what} · Median of each part, seconds · Lower is better`} />
      <div className="mb-5 flex gap-5 text-[12px] text-[var(--muted)]">
        <span className="flex items-center gap-2">
          <span aria-hidden className="inline-block size-3" style={fillStyle("solid", { color: "var(--muted)" })} />
          Pause
        </span>
        <span className="flex items-center gap-2">
          <span aria-hidden className="inline-block size-3" style={fillStyle("hatched", { color: "var(--muted)" })} />
          Resume until a command runs
        </span>
      </div>
      <Columns columns={columns} label="Pause and resume by provider" />
      <Footnotes
        items={[
          ...(whole.length > 0
            ? [{ text: <>{list(whole)}: pause and resume were not recorded apart, so the column is the total.</> }]
            : []),
          ...(unsupported.length > 0 ? [{ text: <>No result for {list(unsupported)} (no pause support).</> }] : []),
        ]}
      />
    </>
  );
}

const partText = {
  pause: { title: "Pause", what: "Pause a running sandbox until the provider confirms" },
  resume: { title: "Resume", what: "Resume a paused sandbox until a command runs" },
} as const;

/** One part on its own scale, so fast providers are not flattened by a slow one. */
export function PausePart({ part }: { part: keyof typeof partText }) {
  const columns: Column[] = providers
    .flatMap((p) => (p.pauseSplit ? [{ p, value: p.pauseSplit[part], n: p.pauseSplit.n }] : []))
    .sort((a, b) => a.value - b.value)
    .map(({ p, value, n }) => ({
      provider: p.id,
      label: formatShort(value, "s"),
      segments: [{ value, color: providerColor(p.id), variant: "gradient" }],
      detail: [`median ${formatValue(value, "s")}`, `${n} attempts`],
    }));
  const hasTotal = (p: Provider) => metric("pause-resume").values.some((v) => v.provider === p.id && v.p50 !== null);
  const unsupported = providers.filter((p) => !p.pauseSplit && !hasTotal(p));
  const unsplit = providers.filter((p) => !p.pauseSplit && hasTotal(p));
  return (
    <>
      <ChartHead title={partText[part].title} sub={`${partText[part].what} · Median seconds · Lower is better`} />
      <Columns columns={columns} label={`${partText[part].title} by provider`} />
      <Footnotes
        items={[
          ...(unsplit.length > 0 ? [{ text: <>No result for {list(unsplit)}: pause and resume were not recorded apart.</> }] : []),
          ...(unsupported.length > 0 ? [{ text: <>No result for {list(unsupported)} (no pause support).</> }] : []),
        ]}
      />
    </>
  );
}
