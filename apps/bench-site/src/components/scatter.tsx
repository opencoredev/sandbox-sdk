import { formatMoney, formatValue } from "@/lib/format";
import { providerColor, providerName } from "@/lib/providers";
import type { ProviderId } from "@/lib/providers";

export interface ScatterPoint {
  provider: ProviderId;
  /** Seconds. */
  x: number;
  /** Price per hour. */
  y: number;
  currency: string;
  /** Extra context after the name, such as the machine the time was measured on. */
  tag?: string;
}

// The plot insets and quadrant colours are tokens in globals.css (`--plot-*`, `--quadrant`).

/** The x axis starts here instead of at the first tick when no point sits below it. */
const X_FLOOR = 2.5;

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);

  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

/** CSS position of a 0 to 1 fraction along the plot area. */
const along = (f: number, axis: "x" | "y") =>
  axis === "x"
    ? `calc(var(--plot-left) + (100% - (var(--plot-left) + var(--plot-right))) * ${f})`
    : `calc(var(--plot-top) + (100% - (var(--plot-top) + var(--plot-bottom))) * ${1 - f})`;

/**
 * Artificial Analysis-style scatter, built in HTML so text stays crisp at
 * any width: log seconds across, price up, both lower is better, so the
 * attractive quadrant is the bottom left, split at the medians.
 */
export function Scatter({
  points,
  xTicks,
  yTicks,
  xTitle,
  yTitle,
}: {
  points: readonly ScatterPoint[];
  xTicks: readonly [number, ...number[]];
  yTicks: readonly [number, ...number[]];
  xTitle: string;
  yTitle: string;
}) {
  // Empty room left of the fastest point only squeezes the rest together.
  const trim = xTicks[0] < X_FLOOR && points.every((p) => p.x >= X_FLOOR);
  // No tick at the floor itself: on a phone it would collide with the next one.
  const xs = trim ? xTicks.filter((t) => t > X_FLOOR) : xTicks;
  const x0 = trim ? X_FLOOR : xTicks[0];
  const x1 = xTicks.at(-1) ?? x0 * 10;
  const y0 = yTicks[0];
  const y1 = yTicks.at(-1) ?? y0 + 1;
  const fx = (x: number) => (Math.log(x) - Math.log(x0)) / (Math.log(x1) - Math.log(x0));
  const fy = (y: number) => (y - y0) / (y1 - y0);
  const mx = fx(median(points.map((p) => p.x)));
  const my = fy(median(points.map((p) => p.y)));

  const summary = points
    .map(
      (p) =>
        `${providerName(p.provider)}${p.tag ? ` (${p.tag})` : ""}: ${formatValue(p.x, "s")}, ${formatMoney(p.y, p.currency)} an hour`,
    )
    .join("; ");

  return (
    <figure aria-label={`${yTitle} against ${xTitle}. ${summary}.`}>
      <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-caption text-muted">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className="size-3 rounded-xs border border-quadrant-key-edge bg-quadrant-key"
          />
          Faster and cheaper than the median
        </span>
        {points.map((p) => (
          <span key={p.provider} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full bg-(--provider)"
              style={{ "--provider": providerColor(p.provider) }}
            />
            {providerName(p.provider)}
          </span>
        ))}
      </div>

      <div className="flex">
        <div className="relative w-5 shrink-0">
          <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-90 text-caption whitespace-nowrap text-muted">
            {yTitle}
          </span>
        </div>
        <div className="relative h-85 min-w-0 flex-1 sm:h-105" aria-hidden>
          <div
            className="absolute top-(--quadrant-top) bottom-plot-bottom left-plot-left w-(--quadrant-width) border-t border-r border-dashed border-quadrant-edge bg-quadrant"
            style={{
              "--quadrant-top": along(my, "y"),
              "--quadrant-width": `calc((100% - (var(--plot-left) + var(--plot-right))) * ${mx})`,
            }}
          />
          {yTicks.map((t) => (
            <div
              key={`y${t}`}
              className="absolute top-(--tick) right-plot-right left-plot-left border-t border-dotted border-chart-grid"
              style={{ "--tick": along(fy(t), "y") }}
            >
              <span className="absolute -left-2 -translate-x-full -translate-y-1/2 font-mono text-tick text-muted tabular-nums">
                ${t.toFixed(2)}
              </span>
            </div>
          ))}
          {xs.map((t) => (
            <div
              key={`x${t}`}
              className="absolute top-plot-top bottom-plot-bottom left-(--tick) border-l border-dotted border-chart-grid"
              style={{ "--tick": along(fx(t), "x") }}
            >
              <span className="absolute -bottom-6 -translate-x-1/2 font-mono whitespace-nowrap text-tick text-muted tabular-nums">
                {t} s
              </span>
            </div>
          ))}
          <div className="absolute right-plot-right bottom-plot-bottom left-plot-left border-t border-chart-axis" />
          <div className="absolute top-plot-top bottom-plot-bottom left-plot-left border-l border-chart-axis" />
          {points.map((p) => {
            const px = fx(p.x);
            // Labels point away from the right edge, and inside the quadrant toward the side
            // with more room, so they never run over its dashed edge.
            const inside = px < mx && fy(p.y) < my;
            const flip = px > 0.62 || (inside && mx - px < px);
            // Two points at nearly the same price print their labels on one line, and on a
            // narrow plot they collide whatever the gap: the dearer label moves above, the cheaper below,
            // so neither runs over the other's dot. At exactly one price the further-right one moves below.
            const twin = points.find((q) => q !== p && Math.abs(fy(q.y) - fy(p.y)) < 0.05);
            const above = twin && (twin.y === p.y ? fx(twin.x) > px : p.y > twin.y);
            const nudge = twin ? (above ? -15 : 15) : 0;

            return (
              <div
                key={p.provider}
                className="absolute top-(--point-y) left-(--point-x)"
                style={{
                  "--point-x": along(px, "x"),
                  "--point-y": along(fy(p.y), "y"),
                  "--provider": providerColor(p.provider),
                }}
              >
                <span className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--provider) ring-3 ring-surface" />
                <span
                  className={`absolute top-(--nudge) -translate-y-1/2 text-note leading-none font-medium whitespace-nowrap text-(--provider) ${flip ? "right-3" : "left-3"}`}
                  style={{ "--nudge": `${nudge}px` }}
                >
                  {providerName(p.provider)}
                  <span className="ml-1.5 hidden font-mono text-tick font-normal text-muted sm:inline">
                    {p.tag ? `${p.tag} · ` : ""}
                    {formatValue(p.x, "s")} · {formatMoney(p.y, p.currency)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-3 pl-5 text-center text-caption text-muted">{xTitle}</p>
    </figure>
  );
}
