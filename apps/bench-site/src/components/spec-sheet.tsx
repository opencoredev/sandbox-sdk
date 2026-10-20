import type { Provider } from "@/lib/data";
import { formatGiB } from "@/lib/format";
import { providerColor, providerName } from "@/lib/providers";

const isolationName: Record<string, string> = {
  kvm: "VM (KVM)",
  docker: "Container",
  unreported: "Not reported",
};

/** One row per provider: what its default sandbox actually was, read from inside it. */
export function SpecSheet({ providers }: { providers: readonly Provider[] }) {
  const headers = ["Provider", "vCPU", "RAM", "Disk", "CPU", "Runs as", "Ran in"];
  return (
    <div
      role="region"
      aria-label="Sandbox hardware by provider"
      tabIndex={0}
      className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0"
    >
      <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-[var(--line)] text-[12px] text-[var(--muted)]">
            {headers.map((h) => (
              <th key={h} scope="col" className="py-2.5 pr-5 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => {
            const hw = p.hardware;
            if (!hw) return null;
            const cpu = hw.cpuModels[0]?.value ?? `${hw.vendor} (model hidden)`;
            const extraCpus = hw.cpuModels.length - 1;
            const host = hw.host && /\d/.test(hw.host) ? hw.host : null;
            return (
              <tr key={p.id} className="border-b border-[var(--line)] align-top">
                <th scope="row" className="py-3 pr-5 font-medium" style={{ color: providerColor(p.id) }}>
                  {providerName(p.id)}
                </th>
                <td className="py-3 pr-5 font-mono tabular-nums">
                  {hw.vcpu}
                  {hw.visibleCpus.some((n) => n !== hw.vcpu) ? (
                    <span className="block text-[11px] text-[var(--muted)]">
                      sees {hw.visibleCpus.join("/")} host cores
                    </span>
                  ) : null}
                </td>
                <td className="py-3 pr-5 font-mono whitespace-nowrap tabular-nums">{formatGiB(hw.memoryGiB)}</td>
                <td className="py-3 pr-5 font-mono whitespace-nowrap tabular-nums">{formatGiB(hw.diskGiB)}</td>
                <td className="py-3 pr-5">
                  {cpu}
                  <span className="block text-[11px] text-[var(--muted)]">
                    {hw.arch}
                    {extraCpus > 0 ? `, plus ${extraCpus} other model${extraCpus > 1 ? "s" : ""}` : ""}
                    {host ? `, ${host}` : ""}
                  </span>
                </td>
                <td className="py-3 pr-5">{isolationName[hw.isolation] ?? hw.isolation}</td>
                <td className="py-3 pr-5">
                  {hw.location[0]?.value ?? "Not reported"}
                  {hw.network[0] ? (
                    <span className="block text-[11px] text-[var(--muted)]">
                      {hw.network[0].value.replace(/^AS\d+\s*/, "")}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
