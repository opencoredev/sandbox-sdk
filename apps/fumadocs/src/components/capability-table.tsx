import { capabilityNames, type CapabilityMap } from "@opencoredev/sandbox-sdk";
import { providers } from "@opencoredev/sandbox-sdk/metadata";

export function CapabilityTable({ capabilities }: { capabilities: CapabilityMap }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-fd-muted/50 text-left">
            <th className="px-4 py-3 font-medium">Capability</th>
            <th className="px-4 py-3 font-medium">Support</th>
            <th className="px-4 py-3 font-medium">Mode</th>
          </tr>
        </thead>
        <tbody>
          {capabilityNames.map((capability) => {
            const mode = capabilities[capability];
            return (
              <tr key={capability} className="border-b last:border-0">
                <td className="px-4 py-3 font-mono text-xs">{capability}</td>
                <td className="px-4 py-3">{mode === false ? "Unsupported" : "Supported"}</td>
                <td className="px-4 py-3 text-fd-muted-foreground">{mode || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ProviderCapabilityMatrix() {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-4xl text-sm">
        <thead>
          <tr className="border-b bg-fd-muted/50 text-left">
            <th className="sticky left-0 bg-fd-muted px-4 py-3 font-medium">Capability</th>
            {providers.map((provider) => (
              <th key={provider.id} className="px-4 py-3 font-medium whitespace-nowrap">
                {provider.displayName}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {capabilityNames.map((capability) => (
            <tr key={capability} className="border-b last:border-0">
              <td className="sticky left-0 bg-fd-background px-4 py-3 font-mono text-xs whitespace-nowrap">
                {capability}
              </td>
              {providers.map((provider) => {
                const mode = provider.capabilities[capability];
                return (
                  <td
                    key={provider.id}
                    className="px-4 py-3 text-fd-muted-foreground whitespace-nowrap"
                  >
                    {mode || "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
