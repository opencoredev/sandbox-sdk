import { fillStyle } from "@/lib/dither";
import type { Provider } from "@/lib/data";
import { formatCount, formatPercent } from "@/lib/format";
import { providerColor, providerName } from "@/lib/providers";

const parts = [
  { key: "provider", label: "Operation failed", color: "oklch(0.68 0.2 25)", variant: "gradient" },
  { key: "accountLimit", label: "Hit our plan's limit", color: "oklch(0.7 0 0)", variant: "hatched" },
  { key: "clientNetwork", label: "Our speed-test host blocked us", color: "oklch(0.7 0 0)", variant: "dotted" },
] as const;

/**
 * Failures per 1,000 operations, split by class. Operation failures set the
 * order; account limits and the blocked test host are shown so nothing is hidden.
 */
export function Failures({ providers }: { providers: readonly Provider[] }) {
  const rows = providers
    .map((p) => {
      const total = p.reliability.successes + p.reliability.failures;
      const per = (n: number) => (n / total) * 1000;
      return { p, total, values: parts.map((part) => per(p.reliability[part.key])) };
    })
    .sort((a, b) => (a.values[0] ?? 0) - (b.values[0] ?? 0));
  const max = Math.max(...rows.map((r) => r.values.reduce((a, b) => a + b, 0)), 1);
  return (
    <figure className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-[var(--muted)]">
        {parts.map((part) => (
          <span key={part.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block size-3"
              style={fillStyle(part.variant, { color: part.color, edge: "right", length: 6, to: 0.4 })}
            />
            {part.label}
          </span>
        ))}
      </div>
      <div className="bars flex flex-col gap-3">
        {rows.map(({ p, total, values }) => (
          <div key={p.id} className="grid grid-cols-[7.5rem_1fr] items-center gap-x-4 gap-y-1 sm:grid-cols-[9rem_1fr]">
            <span className="truncate text-[13px] font-medium" style={{ color: providerColor(p.id) }}>
              {providerName(p.id)}
            </span>
            <div className="flex h-5 items-center">
              {values.map((v, i) => {
                const part = parts[i];
                if (!part || v === 0) return null;
                return (
                  <div
                    key={part.key}
                    aria-hidden
                    className="h-full shrink-0"
                    style={{
                      width: `calc(${v / max} * var(--longest) * 100%)`,
                      minWidth: 3,
                      ...fillStyle(part.variant, { color: part.color, edge: "right", length: 20, to: 0.25 }),
                    }}
                  />
                );
              })}
              <span className="ml-2.5 font-mono text-[13px] whitespace-nowrap tabular-nums">
                {(values[0] ?? 0).toFixed(1)}
                <span className="text-[var(--muted)]"> / {values.reduce((a, b) => a + b, 0).toFixed(1)}</span>
              </span>
            </div>
            <p className="col-start-2 text-[12px] text-[var(--muted)]">
              Per 1,000: {(values[0] ?? 0).toFixed(1)} operation failures,{" "}
              {values.reduce((a, b) => a + b, 0).toFixed(1)} in all. Success rate{" "}
              {formatPercent(p.reliability.adjusted ?? 0, 2)} leaving out our limits and test host,{" "}
              {formatPercent(p.reliability.raw ?? 0, 2)} counting everything, over {formatCount(total)} operations.
            </p>
          </div>
        ))}
      </div>
    </figure>
  );
}
