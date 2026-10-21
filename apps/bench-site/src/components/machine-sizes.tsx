import { Columns } from "@/components/columns";
import type { Column } from "@/components/columns";
import type { Provider } from "@/lib/data";
import { formatGiB } from "@/lib/format";
import { providerColor } from "@/lib/providers";
import { advertised } from "@/lib/sizes";

type Part = "vcpu" | "memoryGiB" | "diskGiB";

const parts = [
  { key: "vcpu", title: "vCPU", format: (v: number) => String(v) },
  { key: "memoryGiB", title: "RAM", format: formatGiB },
  { key: "diskGiB", title: "Disk", format: formatGiB },
] as const satisfies readonly { key: Part; title: string; format: (v: number) => string }[];

const measured = (p: Provider, key: Part) =>
  key === "vcpu" ? p.hardware?.vcpu : key === "memoryGiB" ? p.hardware?.memoryGiB : p.hardware?.diskGiB;

/**
 * Who gives you the biggest machine by default: advertised vCPU, RAM and
 * disk side by side, biggest first. Hover shows what we measured inside.
 */
export function MachineSizes({ providers }: { providers: readonly Provider[] }) {
  return (
    <div className="grid gap-x-6 gap-y-8 md:grid-cols-3">
      {parts.map((part) => {
        const columns: Column[] = providers
          .flatMap((p) => {
            const inside = measured(p, part.key);
            // Disk is the one size a provider may not advertise; fall back to what we measured.
            const value = advertised[p.id][part.key] ?? inside;
            return value == null ? [] : [{ p, value, inside }];
          })
          .sort((a, b) => b.value - a.value)
          .map(({ p, value, inside }) => ({
            provider: p.id,
            label: part.format(value),
            segments: [{ value, color: providerColor(p.id), variant: "gradient" }],
            detail: [
              advertised[p.id][part.key] == null ? "not advertised; measured" : `advertised ${part.format(value)}`,
              ...(inside == null ? [] : [`measured inside ${part.format(inside)}`]),
            ],
          }));
        return (
          <div key={part.key}>
            <h4 className="text-[14px] font-medium">{part.title}</h4>
            <p className="mt-0.5 mb-2 text-[12px] text-[var(--muted)]">Default sandbox · Higher is better</p>
            <Columns columns={columns} label={`${part.title} by provider`} compact />
          </div>
        );
      })}
    </div>
  );
}
