import { FillPattern } from "@/lib/dither";
import { formatMoney, formatValue } from "@/lib/format";
import { providerColor, providerName } from "@/lib/providers";

export interface ScatterPoint {
  provider: string;
  x: number;
  y: number;
  currency: string | null;
}

const W = 1000;
const H = 520;
const PAD = { left: 64, right: 24, top: 20, bottom: 52 };
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

/**
 * Artificial Analysis-style scatter: log x, linear y, both lower is better, so
 * the attractive quadrant is bottom left, split at the medians.
 */
export function Scatter({
  points,
  xTicks,
  yTicks,
  xLabel,
  yLabel,
  quadrantLabel,
}: {
  points: ScatterPoint[];
  xTicks: number[];
  yTicks: number[];
  xLabel: string;
  yLabel: string;
  quadrantLabel: string;
}) {
  const [x0, x1] = [xTicks[0] ?? 1, xTicks.at(-1) ?? 10];
  const [y0, y1] = [yTicks[0] ?? 0, yTicks.at(-1) ?? 1];
  const px = (x: number) =>
    PAD.left + ((Math.log(x) - Math.log(x0)) / (Math.log(x1) - Math.log(x0))) * (W - PAD.left - PAD.right);
  const py = (y: number) => H - PAD.bottom - ((y - y0) / (y1 - y0)) * (H - PAD.top - PAD.bottom);
  const mx = px(median(points.map((p) => p.x)));
  const my = py(median(points.map((p) => p.y)));
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <figure
      role="region"
      aria-label={`${yLabel} against ${xLabel}`}
      tabIndex={0}
      className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:overflow-visible sm:px-0"
    >
      <div className="relative min-w-[620px]">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-label={`${yLabel} against ${xLabel}. ${points.map((p) => `${providerName(p.provider)}: ${formatValue(p.x, "s")}, ${formatMoney(p.y, p.currency)}`).join("; ")}.`}
      >
        <defs>
          <FillPattern id="quadrant" fill="gradient" color="oklch(0.8 0.17 152)" level={0.16} cell={3} />
        </defs>
        <rect x={PAD.left} y={my} width={mx - PAD.left} height={H - PAD.bottom - my} fill="url(#quadrant)" />
        {xTicks.map((t) => (
          <line key={`x${t}`} x1={px(t)} x2={px(t)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--line)" strokeDasharray="2 4" />
        ))}
        {yTicks.map((t) => (
          <line key={`y${t}`} x1={PAD.left} x2={W - PAD.right} y1={py(t)} y2={py(t)} stroke="var(--line)" strokeDasharray="2 4" />
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="var(--muted)" />
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--muted)" />
        {points.map((p) => (
          <circle
            key={p.provider}
            cx={px(p.x)}
            cy={py(p.y)}
            r={9}
            fill={providerColor(p.provider)}
          />
        ))}
      </svg>
      <div aria-hidden className="pointer-events-none absolute inset-0 font-mono text-[11px] text-[var(--muted)]">
        <span
          className="absolute bg-[var(--background)] px-1 font-sans text-[12px] text-[oklch(0.8_0.17_152)]"
          style={{ left: `calc(${pct(PAD.left, W)} + 10px)`, bottom: `calc(${pct(PAD.bottom, H)} + 8px)` }}
        >
          {quadrantLabel}
        </span>
        {xTicks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: pct(px(t), W), top: `calc(${pct(H - PAD.bottom, H)} + 6px)` }}>
            {t} s
          </span>
        ))}
        {yTicks.map((t) => (
          <span key={t} className="absolute -translate-x-full -translate-y-1/2 pr-2" style={{ left: pct(PAD.left, W), top: pct(py(t), H) }}>
            ${t.toFixed(2)}
          </span>
        ))}
        {points.map((p) => (
          <span
            key={p.provider}
            className="absolute -translate-y-1/2 pl-3 font-sans text-[12px] font-medium whitespace-nowrap sm:text-[13px]"
            style={{ left: pct(px(p.x), W), top: pct(py(p.y), H), color: providerColor(p.provider) }}
          >
            {providerName(p.provider)}
          </span>
        ))}
      </div>
      </div>
      <figcaption className="mt-10 flex min-w-[620px] sm:min-w-0 flex-col gap-1 text-[12px] text-[var(--muted)] sm:flex-row sm:justify-between">
        <span>{xLabel}</span>
        <span>{yLabel}</span>
      </figcaption>
    </figure>
  );
}
