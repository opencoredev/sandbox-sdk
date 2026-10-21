import type { Provider } from "@/lib/data";
import { providerColor, providerName } from "@/lib/providers";
import { advertised } from "@/lib/sizes";

const isolationName: Record<string, string> = {
  kvm: "Virtual machine",
  docker: "Container",
  unreported: "Not reported",
};

/** What each default sandbox ran on, read from inside it. Sizes are in MachineSizes. */
export function SpecSheet({ providers }: { providers: readonly Provider[] }) {
  return (
    <div role="region" aria-label="Sandbox details by provider" tabIndex={0} className="relative -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[620px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-[var(--line)] text-[12px] text-[var(--muted)]">
            {["Provider", "CPU", "Runs as", "Ran in"].map((h) => (
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
            const note = advertised[p.id].note;
            return (
              <tr key={p.id} className="border-b border-[var(--line)] align-top">
                <th scope="row" className="py-3 pr-5 font-medium" style={{ color: providerColor(p.id) }}>
                  {providerName(p.id)}
                </th>
                <td className="py-3 pr-5">
                  {hw.cpuModels[0]?.value ?? `${hw.vendor}, model hidden`}
                  {note ? <span className="mt-1 block max-w-[52ch] text-[11.5px] text-[var(--muted)]">{note}</span> : null}
                </td>
                <td className="py-3 pr-5 whitespace-nowrap">{isolationName[hw.isolation] ?? hw.isolation}</td>
                <td className="py-3 pr-5 whitespace-nowrap">{hw.location[0]?.value ?? "Not reported"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
