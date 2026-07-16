import { capabilityNames } from "@opencoredev/sandbox-sdk";
import { providers } from "@opencoredev/sandbox-sdk/metadata";

export const metadata = {
  title: "Compatibility",
  description: "Generated Sandbox SDK provider capability matrix.",
  alternates: { canonical: "/compatibility" },
};

export default function CompatibilityPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-16 md:py-24">
      <div className="max-w-3xl">
        <p className="text-sm font-medium text-fd-primary">Compatibility</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          Claims tied to code.
        </h1>
        <p className="mt-5 text-lg leading-8 text-fd-muted-foreground">
          This matrix renders the same capability declarations used by the SDK. Live-test status
          stays separate from provider review and commercial sponsorship.
        </p>
      </div>

      <div className="mt-8 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border bg-fd-card px-3 py-1.5">
          Supported = adapter + contract tests
        </span>
        <span className="rounded-full border bg-fd-card px-3 py-1.5">
          Live tested = recent real-provider pass
        </span>
        <span className="rounded-full border bg-fd-card px-3 py-1.5">
          Sponsor = commercial only
        </span>
      </div>

      <div className="mt-10 overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b bg-fd-muted/50 text-left">
              <th className="px-4 py-3 font-medium">Capability</th>
              {providers.map((provider) => (
                <th className="px-4 py-3 font-medium" key={provider.id}>
                  {provider.displayName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {capabilityNames.map((capability) => (
              <tr className="border-b last:border-0" key={capability}>
                <td className="px-4 py-3 font-mono text-xs">{capability}</td>
                {providers.map((provider) => (
                  <td className="px-4 py-3 text-fd-muted-foreground" key={provider.id}>
                    {provider.capabilities[capability] || "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
