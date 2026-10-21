import { Columns } from "@/components/columns";
import type { Column } from "@/components/columns";
import { ChartHead, Footnotes, MetricChart, Who } from "@/components/metric-chart";
import { fillStyle } from "@/lib/dither";
import { metric, providers } from "@/lib/data";
import { formatShort, formatValue } from "@/lib/format";
import { providerColor } from "@/lib/providers";

const what = "Pause, resume, then run a command";

/**
 * Pause and resume as two parts of one column: hatched resume at the
 * bottom, dithered pause on top, so a slow pause and a slow resume look
 * different. Falls back to the single total until the data records them apart.
 */
export function PauseChart() {
  const m = metric("pause-resume");
  const split = providers.flatMap((p) => (p.pauseSplit ? [{ p, ...p.pauseSplit }] : []));
  if (split.length === 0) return <MetricChart metric={m} what={what} />;

  const columns: Column[] = split
    .sort((a, b) => a.pause + a.resume - (b.pause + b.resume))
    .map(({ p, pause, resume, n }) => ({
      provider: p.id,
      label: formatShort(pause + resume, "s"),
      segments: [
        { value: resume, color: providerColor(p.id), variant: "hatched" },
        { value: pause, color: providerColor(p.id), variant: "gradient" },
      ],
      detail: [`pause ${formatValue(pause, "s")}`, `resume ${formatValue(resume, "s")}`, `${n} attempts`],
    }));
  const missing = providers.filter((p) => !p.pauseSplit);

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
        items={
          missing.length > 0
            ? [
                {
                  text: (
                    <>
                      No result for{" "}
                      {missing.map((p, i) => (
                        <span key={p.id}>
                          {i > 0 ? ", " : ""}
                          <Who id={p.id} />
                        </span>
                      ))}{" "}
                      (no pause support).
                    </>
                  ),
                },
              ]
            : []
        }
      />
    </>
  );
}
