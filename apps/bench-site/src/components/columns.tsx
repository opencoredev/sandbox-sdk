import type { CSSProperties } from "react";

import { fillStyle } from "@/lib/dither";
import type { FillEdge, FillVariant } from "@/lib/dither";
import { providerColor, providerName } from "@/lib/providers";
import type { ProviderId } from "@/lib/providers";

export interface Segment {
  value: number;
  color: string;
  variant: FillVariant;
}

export interface Column {
  provider: ProviderId;
  /** Stacked from the baseline up. One segment for a plain column. */
  segments: readonly [Segment, ...Segment[]];
  /** Printed above the column. */
  label: string;
  /** Lines of the hover and focus card. */
  detail: readonly string[];
  /** Footnote number shown beside the provider name. */
  mark?: number;
}

const total = (c: Column) => c.segments.reduce((sum, s) => sum + s.value, 0);

/** An outlier this many times the runner-up would flatten every other column. */
const OUTLIER = 4;
/** When one is found, the axis ends this far above the runner-up instead. */
const HEADROOM = 1.3;

/** The value at the end of the axis: the largest total, or less when that total is an outlier. */
function axisMax(columns: readonly Column[]) {
  const [first = 0, second = 0] = columns.map(total).sort((a, b) => b - a);
  return second > 0 && first > OUTLIER * second ? second * HEADROOM : Math.max(first, Number.EPSILON);
}

interface Bar {
  /** Share of the axis each segment covers, baseline first. */
  shares: readonly number[];
  /** Share of the axis the whole bar covers. */
  length: number;
  /** The segment cut short to fit, if the bar runs past the axis. */
  broken: number | null;
}

/**
 * Lays a column out against the axis. A bar past the end is drawn to the
 * end: its largest segment absorbs the cut so the others keep their scale.
 */
function layout(column: Column, max: number): Bar {
  const shares = column.segments.map((s) => s.value / max);
  if (total(column) <= max) return { shares, length: total(column) / max, broken: null };
  const broken = shares.indexOf(Math.max(...shares));
  const others = shares.reduce((sum, s, i) => (i === broken ? sum : sum + s), 0);
  return {
    shares: shares.map((s, i) => (i === broken ? Math.max(1 - others, 0.25) : s)),
    length: 1,
    broken,
  };
}

const segmentStyle = (s: Segment, edge: FillEdge, length: number): CSSProperties =>
  s.variant === "gradient"
    ? fillStyle("gradient", { color: s.color, edge, length, to: 0.2 })
    : fillStyle(s.variant, { color: s.color });

const describe = (column: Column, bar: Bar) =>
  `${providerName(column.provider)}: ${column.detail.join(", ")}${bar.broken === null ? "" : ". Bar shortened, not to scale"}`;

/**
 * The axis break: a slanted gap through the bar, edged in its colour, so a
 * shortened bar reads as cut rather than as its true length.
 */
function Break({ color, along }: { color: string; along: "x" | "y" }) {
  return (
    <span
      aria-hidden
      className={`absolute bg-[var(--surface)] ${
        along === "y"
          ? "-inset-x-1.5 top-3 h-[11px] -skew-y-[14deg] border-y-2"
          : "-inset-y-1 right-3 w-[10px] -skew-x-[20deg] border-x-2"
      }`}
      style={{ borderColor: color }}
    />
  );
}

const Mark = ({ column }: { column: Column }) =>
  column.mark === undefined ? null : <sup className="ml-px text-[9px] text-[var(--muted)]">{column.mark}</sup>;

const Card = ({ column, className, style }: { column: Column; className: string; style?: CSSProperties }) => (
  <div
    role="presentation"
    style={style}
    className={`pointer-events-none absolute z-10 w-max max-w-[220px] rounded-md border border-[var(--line)] bg-[var(--popover)] px-2.5 py-2 text-left text-[12px] leading-snug opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100 motion-reduce:transition-none ${className}`}
  >
    <span className="block font-medium" style={{ color: providerColor(column.provider) }}>
      {providerName(column.provider)}
    </span>
    {column.detail.map((line) => (
      <span key={line} className="block font-mono text-[11px] text-[var(--muted)] tabular-nums">
        {line}
      </span>
    ))}
  </div>
);

/**
 * Vertical columns in the order given, one per provider, as Artificial
 * Analysis draws them: value on top, name underneath. Each column is a
 * dithered fade that is densest at its top edge.
 */
function Vertical({ columns, max }: { columns: readonly Column[]; max: number }) {
  return (
    <>
      <div className="relative flex h-[260px] items-end border-b border-[var(--axis)] pt-6">
        {columns.map((column, index) => {
          const bar = layout(column, max);
          const color = providerColor(column.provider);
          // Keep the hover card inside the chart: edge columns anchor it inward.
          const anchor =
            index < 2 ? "left-0" : index >= columns.length - 2 ? "right-0" : "left-1/2 -translate-x-1/2";
          return (
            <div
              key={column.provider}
              tabIndex={0}
              aria-label={describe(column, bar)}
              className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end outline-none"
            >
              <span className="mb-1.5 shrink-0 font-mono text-[12px] whitespace-nowrap text-[var(--foreground)] tabular-nums">
                {column.label}
              </span>
              <div
                className="relative flex w-[min(60px,66%)] shrink-0 flex-col-reverse"
                style={{ height: `${bar.length * 100}%`, minHeight: 2 }}
              >
                {column.segments.map((s, i) => (
                  <div
                    key={i}
                    aria-hidden
                    className="relative w-full"
                    style={{ height: `${((bar.shares[i] ?? 0) / bar.length) * 100}%`, ...segmentStyle(s, "top", 34) }}
                  >
                    {bar.broken === i ? <Break color={s.color} along="y" /> : null}
                  </div>
                ))}
                {column.segments.length === 1 ? (
                  <div aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: color }} />
                ) : null}
              </div>
              <Card column={column} className={anchor} style={{ bottom: `calc(${bar.length * 100}% + 1.9rem)` }} />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-1 -bottom-px h-px opacity-0 group-focus-visible:opacity-100"
                style={{ backgroundColor: color }}
              />
            </div>
          );
        })}
      </div>
      <div aria-hidden className="flex pt-2.5">
        {columns.map((column) => (
          <span
            key={column.provider}
            className="block min-w-0 flex-1 px-0.5 text-center text-[12px] leading-tight font-medium"
            style={{ color: providerColor(column.provider) }}
          >
            {providerName(column.provider)}
            <Mark column={column} />
          </span>
        ))}
      </div>
    </>
  );
}

/**
 * The same data as horizontal bars, one row per provider, so every name
 * reads level however narrow the card. Used for compact charts and phones.
 */
function Horizontal({ columns, max }: { columns: readonly Column[]; max: number }) {
  // Values sit in one right-aligned column wide enough for the longest label.
  const valueWidth = `${Math.max(...columns.map((c) => c.label.length), 3) + 0.5}ch`;
  return (
    <div className="flex flex-col gap-1">
      {columns.map((column) => {
        const bar = layout(column, max);
        const color = providerColor(column.provider);
        return (
          <div
            key={column.provider}
            tabIndex={0}
            aria-label={describe(column, bar)}
            className="group relative grid h-8 grid-cols-[5.25rem_1fr_auto] items-center gap-x-2.5 rounded-[3px] outline-none focus:bg-[var(--band)] sm:h-[22px] sm:grid-cols-[4.75rem_1fr_auto]"
          >
            <span aria-hidden className="truncate text-[13px] leading-none font-medium sm:text-[12px]" style={{ color }}>
              {providerName(column.provider)}
              <Mark column={column} />
            </span>
            <div aria-hidden className="relative flex h-3.5 items-stretch border-l border-[var(--axis)] sm:h-3">
              <div className="relative flex" style={{ width: `${bar.length * 100}%`, minWidth: 2 }}>
                {column.segments.map((s, i) => (
                  <div key={i} className="relative h-full" style={{ width: `${((bar.shares[i] ?? 0) / bar.length) * 100}%` }}>
                    {/* Phones get a solid bar: at this size the dither fade reads as a dotted line. */}
                    <div
                      className={`absolute inset-0 ${s.variant === "gradient" ? "hidden sm:block" : ""}`}
                      style={segmentStyle(s, "right", 20)}
                    />
                    {s.variant === "gradient" ? (
                      <div className="absolute inset-0 rounded-r-[2px] sm:hidden" style={{ backgroundColor: s.color }} />
                    ) : null}
                    {bar.broken === i ? <Break color={s.color} along="x" /> : null}
                  </div>
                ))}
                {column.segments.length === 1 ? (
                  <div className="absolute inset-y-0 right-0 w-[3px]" style={{ backgroundColor: color }} />
                ) : null}
              </div>
            </div>
            <span
              aria-hidden
              className="text-right font-mono text-[12px] text-[var(--foreground)] tabular-nums sm:text-[11px]"
              style={{ width: valueWidth }}
            >
              {column.label}
            </span>
            <Card column={column} className="top-full right-0 mt-1" />
          </div>
        );
      })}
    </div>
  );
}

/**
 * One value per provider in the order given. Wide screens get columns;
 * compact charts and phones get horizontal bars, so names never rotate.
 * A single outlier is cut short with a break mark instead of flattening the rest.
 */
export function Columns({
  columns,
  label,
  compact = false,
}: {
  columns: readonly Column[];
  label: string;
  compact?: boolean;
}) {
  const max = axisMax(columns);
  const cut = columns.some((c) => total(c) > max);
  return (
    <figure aria-label={cut ? `${label}. One bar is shortened to fit and marked with a break.` : label} className="relative">
      {compact ? (
        <Horizontal columns={columns} max={max} />
      ) : (
        <>
          <div className="sm:hidden">
            <Horizontal columns={columns} max={max} />
          </div>
          <div className="hidden sm:block">
            <Vertical columns={columns} max={max} />
          </div>
        </>
      )}
    </figure>
  );
}
