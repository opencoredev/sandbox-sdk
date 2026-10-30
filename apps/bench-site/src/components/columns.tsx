import { DitherFill } from "@/lib/dither";
import type { FillEdge, FillStyleOptions, FillVariant } from "@/lib/dither";
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

  return second > 0 && first > OUTLIER * second
    ? second * HEADROOM
    : Math.max(first, Number.EPSILON);
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

/** How a segment is filled: a gradient fades from `edge` over `length` cells; other variants tile evenly. */
const segmentFill = (s: Segment, edge: FillEdge, length: number): FillStyleOptions =>
  s.variant === "gradient" ? { color: s.color, edge, length, to: 0.2 } : { color: s.color };

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
      className={`absolute border-(--break) bg-surface ${
        along === "y"
          ? "-inset-x-1.5 top-3 h-2.75 -skew-y-14 border-y-2"
          : "-inset-y-1 right-3 w-2.5 -skew-x-20 border-x-2"
      }`}
      style={{ "--break": color }}
    />
  );
}

const Mark = ({ column }: { column: Column }) =>
  column.mark === undefined ? null : (
    <sup className="ml-px text-footnote text-muted">{column.mark}</sup>
  );

/** Where the detail card sits against its column or row. */
const CARD_ANCHOR = {
  start: "left-0",
  end: "right-0",
  center: "left-1/2 -translate-x-1/2",
  below: "top-full right-0 mt-1",
} as const;

/** The hover and focus card. `bottom` is a CSS length that lifts it above the column's top. */
const DetailCard = ({
  column,
  anchor,
  bottom,
}: {
  column: Column;
  anchor: keyof typeof CARD_ANCHOR;
  bottom?: string;
}) => (
  <div
    role="presentation"
    style={{ "--card-bottom": bottom }}
    className={`pointer-events-none absolute z-10 w-max max-w-55 rounded-md border border-line bg-popover px-2.5 py-2 text-left text-caption leading-snug opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100 motion-reduce:transition-none ${CARD_ANCHOR[anchor]} ${bottom === undefined ? "" : "bottom-(--card-bottom)"}`}
  >
    <span
      className="block font-medium text-(--provider)"
      style={{ "--provider": providerColor(column.provider) }}
    >
      {providerName(column.provider)}
    </span>
    {column.detail.map((line) => (
      <span key={line} className="block font-mono text-tick text-muted tabular-nums">
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
      <div className="relative flex h-65 items-end border-b border-chart-axis pt-6">
        {columns.map((column, index) => {
          const bar = layout(column, max);
          const color = providerColor(column.provider);

          // Keep the hover card inside the chart: edge columns anchor it inward.
          const anchor = index < 2 ? "start" : index >= columns.length - 2 ? "end" : "center";

          return (
            <div
              key={column.provider}
              tabIndex={0}
              aria-label={describe(column, bar)}
              className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end outline-none"
            >
              <span className="mb-1.5 shrink-0 font-mono text-caption whitespace-nowrap text-foreground tabular-nums">
                {column.label}
              </span>
              <div
                className="relative flex h-(--bar) min-h-0.5 w-bar shrink-0 flex-col-reverse"
                style={{ "--bar": `${bar.length * 100}%` }}
              >
                {column.segments.map((s, i) => (
                  <DitherFill
                    key={i}
                    variant={s.variant}
                    {...segmentFill(s, "top", 34)}
                    aria-hidden
                    className="relative h-(--segment) w-full"
                    style={{ "--segment": `${((bar.shares[i] ?? 0) / bar.length) * 100}%` }}
                  >
                    {bar.broken === i ? <Break color={s.color} along="y" /> : null}
                  </DitherFill>
                ))}
                {column.segments.length === 1 ? (
                  <div
                    aria-hidden
                    className="absolute inset-x-0 top-0 h-0.75 bg-(--provider)"
                    style={{ "--provider": color }}
                  />
                ) : null}
              </div>
              <DetailCard
                column={column}
                anchor={anchor}
                bottom={`calc(${bar.length * 100}% + 1.9rem)`}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-1 -bottom-px h-px bg-(--provider) opacity-0 group-focus-visible:opacity-100"
                style={{ "--provider": color }}
              />
            </div>
          );
        })}
      </div>
      <div aria-hidden className="flex pt-2.5">
        {columns.map((column) => (
          <span
            key={column.provider}
            className="block min-w-0 flex-1 px-0.5 text-center text-caption leading-tight font-medium text-(--provider)"
            style={{ "--provider": providerColor(column.provider) }}
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
            className="group relative grid h-8 grid-cols-bar-row items-center gap-x-2.5 rounded-tag outline-none focus:bg-band sm:h-5.5 sm:grid-cols-bar-row-compact"
          >
            <span
              aria-hidden
              className="truncate text-control leading-none font-medium text-(--provider) sm:text-caption"
              style={{ "--provider": color }}
            >
              {providerName(column.provider)}
              <Mark column={column} />
            </span>
            <div
              aria-hidden
              className="relative flex h-3.5 items-stretch border-l border-chart-axis sm:h-3"
            >
              <div
                className="relative flex w-(--bar) min-w-0.5"
                style={{ "--bar": `${bar.length * 100}%` }}
              >
                {column.segments.map((s, i) => (
                  <div
                    key={i}
                    className="relative h-full w-(--segment)"
                    style={{ "--segment": `${((bar.shares[i] ?? 0) / bar.length) * 100}%` }}
                  >
                    {/* Phones get a solid bar: at this size the dither fade reads as a dotted line. */}
                    <DitherFill
                      variant={s.variant}
                      {...segmentFill(s, "right", 20)}
                      className={`absolute inset-0 ${s.variant === "gradient" ? "hidden sm:block" : ""}`}
                    />
                    {s.variant === "gradient" ? (
                      <div
                        className="absolute inset-0 rounded-r-xs bg-(--segment-color) sm:hidden"
                        style={{ "--segment-color": s.color }}
                      />
                    ) : null}
                    {bar.broken === i ? <Break color={s.color} along="x" /> : null}
                  </div>
                ))}
                {column.segments.length === 1 ? (
                  <div
                    className="absolute inset-y-0 right-0 w-0.75 bg-(--provider)"
                    style={{ "--provider": color }}
                  />
                ) : null}
              </div>
            </div>
            <span
              aria-hidden
              className="w-(--value-width) text-right font-mono text-caption text-foreground tabular-nums sm:text-tick"
              style={{ "--value-width": valueWidth }}
            >
              {column.label}
            </span>
            <DetailCard column={column} anchor="below" />
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
    <figure
      aria-label={cut ? `${label}. One bar is shortened to fit and marked with a break.` : label}
      className="relative"
    >
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
