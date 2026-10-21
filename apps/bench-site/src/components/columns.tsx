import type { CSSProperties } from "react";

import { fillStyle } from "@/lib/dither";
import type { FillVariant } from "@/lib/dither";
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

const segmentStyle = (s: Segment): CSSProperties =>
  s.variant === "gradient"
    ? fillStyle("gradient", { color: s.color, edge: "top", length: 34, to: 0.2 })
    : fillStyle(s.variant, { color: s.color });

function Name({ column, rotated }: { column: Column; rotated: boolean }) {
  const text = (
    <>
      {providerName(column.provider)}
      {column.mark === undefined ? null : <sup className="ml-px text-[9px] text-[var(--muted)]">{column.mark}</sup>}
    </>
  );
  return rotated ? (
    <span
      className="absolute top-1.5 right-1/2 origin-top-right -rotate-40 text-[11px] font-medium whitespace-nowrap"
      style={{ color: providerColor(column.provider) }}
    >
      {text}
    </span>
  ) : (
    <span
      className="block text-center text-[12px] leading-tight font-medium"
      style={{ color: providerColor(column.provider) }}
    >
      {text}
    </span>
  );
}

/**
 * Vertical columns in the order given, one per provider, as Artificial
 * Analysis draws them: value on top, name underneath, dotted guides behind.
 * Each column is a dithered fade that is densest at its top edge.
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
  const max = Math.max(...columns.map(total), Number.EPSILON);
  const plot = compact ? "h-[170px]" : "h-[210px] sm:h-[260px]";
  const width = compact ? "w-[min(38px,68%)]" : "w-[min(60px,66%)]";
  return (
    <figure aria-label={label} className="relative">
      <div className={`relative ${plot} pt-6 max-[440px]:pt-9`}>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-6 bottom-0 flex flex-col justify-between max-[440px]:top-9">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="border-t border-dotted border-[var(--grid)]" />
          ))}
        </div>
        <div className="relative flex h-full items-end border-b border-[var(--axis)]">
          {columns.map((column, index) => {
            const share = total(column) / max;
            // Keep the hover card inside the chart: edge columns anchor it inward.
            const anchor =
              index < 2 ? "left-0" : index >= columns.length - 2 ? "right-0" : "left-1/2 -translate-x-1/2";
            return (
              <div
                key={column.provider}
                tabIndex={0}
                aria-label={`${providerName(column.provider)}: ${column.detail.join(", ")}`}
                className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end outline-none"
              >
                <span
                  className={`mb-1.5 shrink-0 font-mono whitespace-nowrap text-[var(--foreground)] tabular-nums ${
                    compact ? "text-[10px] min-[400px]:text-[11px]" : "text-[10px] min-[400px]:text-[11px] sm:text-[12px]"
                  } ${
                    // Eight slots are too narrow for side-by-side prices on a phone, so every other label sits higher.
                    index % 2 === 1 ? (compact ? "max-[440px]:-translate-y-3.5" : "max-[440px]:-translate-y-3.5 sm:translate-y-0") : ""
                  }`}
                >
                  {column.label}
                </span>
                <div
                  className={`relative flex ${width} shrink-0 flex-col-reverse`}
                  style={{ height: `${share * 100}%`, minHeight: 2 }}
                >
                  {column.segments.map((s, i) => (
                    <div
                      key={i}
                      aria-hidden
                      className="w-full"
                      style={{ height: `${(s.value / total(column)) * 100}%`, ...segmentStyle(s) }}
                    />
                  ))}
                  {column.segments.length === 1 ? (
                    <div
                      aria-hidden
                      className="absolute inset-x-0 top-0 h-[3px]"
                      style={{ backgroundColor: column.segments[0].color }}
                    />
                  ) : null}
                </div>
                <div
                  role="presentation"
                  style={{ bottom: `calc(${share * 100}% + 1.9rem)` }}
                  className={`pointer-events-none absolute ${anchor} z-10 w-max max-w-[220px] rounded-md border border-[var(--line)] bg-[var(--popover)] px-2.5 py-2 text-left text-[12px] leading-snug opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none`}
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
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-1 -bottom-px h-px opacity-0 group-focus-visible:opacity-100"
                  style={{ backgroundColor: providerColor(column.provider) }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div aria-hidden className={`flex ${compact ? "h-16" : "h-16 sm:h-auto sm:pt-2.5"}`}>
        {columns.map((column) => (
          <div key={column.provider} className="relative min-w-0 flex-1 px-0.5">
            {compact ? (
              <Name column={column} rotated />
            ) : (
              <>
                <span className="sm:hidden">
                  <Name column={column} rotated />
                </span>
                <span className="hidden sm:block">
                  <Name column={column} rotated={false} />
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </figure>
  );
}
