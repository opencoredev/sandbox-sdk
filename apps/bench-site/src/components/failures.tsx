import { Columns } from "@/components/columns";
import type { Column, Segment } from "@/components/columns";
import { fillStyle } from "@/lib/dither";
import type { Provider } from "@/lib/data";
import { formatCount, formatPercent } from "@/lib/format";

const causes = [
  { key: "provider", label: "Operation failed", color: "oklch(0.68 0.2 25)", variant: "gradient" },
  { key: "accountLimit", label: "Hit our plan's limit", color: "oklch(0.72 0 0)", variant: "hatched" },
  { key: "clientNetwork", label: "Our speed-test host blocked us", color: "oklch(0.72 0 0)", variant: "dotted" },
] as const satisfies readonly { key: string; label: string; color: string; variant: Segment["variant"] }[];

const perThousand = (p: Provider, n: number) => (n / (p.reliability.successes + p.reliability.failures)) * 1000;

const detail = (p: Provider) => {
  const total = p.reliability.successes + p.reliability.failures;
  return [
    ...causes.map((c) => `${c.label.toLowerCase()}: ${perThousand(p, p.reliability[c.key]).toFixed(1)}`),
    `${formatPercent(p.reliability.raw ?? 0, 2)} of ${formatCount(total)} succeeded`,
    `${formatPercent(p.reliability.adjusted ?? 0, 2)} without our limits and test host`,
  ];
};

/** Operation failures per 1,000 attempts, fewest first. */
export function OperationFailures({ providers }: { providers: readonly Provider[] }) {
  const columns: Column[] = providers
    .map((p) => ({ p, v: perThousand(p, p.reliability.provider) }))
    .sort((a, b) => a.v - b.v)
    .map(({ p, v }) => ({
      provider: p.id,
      label: v.toFixed(1),
      segments: [{ value: v, color: causes[0].color, variant: "gradient" }],
      detail: detail(p),
    }));
  return <Columns columns={columns} label="Operation failures per 1,000 attempts" />;
}

/** Every failure per 1,000 attempts, stacked by cause, so nothing is hidden. */
export function AllFailures({ providers }: { providers: readonly Provider[] }) {
  const columns: Column[] = providers
    .map((p) => {
      const parts = causes.map((c) => ({ value: perThousand(p, p.reliability[c.key]), color: c.color, variant: c.variant }));
      return { p, parts, sum: parts.reduce((a, s) => a + s.value, 0) };
    })
    .sort((a, b) => a.sum - b.sum)
    .map(({ p, parts, sum }) => {
      const [first, ...rest] = parts.filter((s) => s.value > 0);
      return {
        provider: p.id,
        label: sum.toFixed(1),
        segments: first ? [first, ...rest] : [{ value: 0, color: causes[0].color, variant: "solid" }],
        detail: detail(p),
      };
    });
  return (
    <>
      <div className="mb-5 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-[var(--muted)]">
        {causes.map((c) => (
          <span key={c.key} className="flex items-center gap-2">
            <span aria-hidden className="inline-block size-3" style={fillStyle(c.variant === "gradient" ? "solid" : c.variant, { color: c.color })} />
            {c.label}
          </span>
        ))}
      </div>
      <Columns columns={columns} label="Every failure per 1,000 attempts, by cause" />
    </>
  );
}
