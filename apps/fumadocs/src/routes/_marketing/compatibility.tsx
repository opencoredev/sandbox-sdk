import { capabilityNames } from "@opencoredev/sandbox-sdk";
import { providers } from "@opencoredev/sandbox-sdk/metadata";
import { createFileRoute } from "@tanstack/react-router";
import { docsOrigin } from "@/lib/shared";

export const Route = createFileRoute("/_marketing/compatibility")({
  component: CompatibilityPage,
  head: () => ({
    meta: [
      { title: "Compatibility" },
      { name: "description", content: "Generated Sandbox SDK provider capability matrix." },
    ],
    links: [{ rel: "canonical", href: new URL("/compatibility", docsOrigin).toString() }],
  }),
});

function CompatibilityPage() {
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
          Live tested = dated metadata.liveTest row only
        </span>
        <span className="rounded-full border bg-fd-card px-3 py-1.5">
          Sponsor = commercial only
        </span>
      </div>

      <h2 className="mt-14 text-xl font-semibold">Live tests</h2>
      <p className="mt-2 max-w-3xl text-sm text-fd-muted-foreground">
        A blank date means <code>liveTest: null</code>. This page does not invent passing runs.
      </p>
      <div className="mt-4 overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b bg-fd-muted/50 text-left">
              <th className="px-4 py-3 font-medium">Adapter</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Tested at</th>
              <th className="px-4 py-3 font-medium">Adapter / SDK</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr className="border-b last:border-0" key={provider.id}>
                <td className="px-4 py-3">{provider.displayName}</td>
                <td className="px-4 py-3 text-fd-muted-foreground">
                  {provider.liveTest ? "dated run" : "not live-tested"}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-fd-muted-foreground">
                  {provider.liveTest?.testedAt ?? "—"}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-fd-muted-foreground">
                  {provider.liveTest
                    ? `${provider.liveTest.adapterVersion} / ${provider.liveTest.providerSdkVersion}`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-14 text-xl font-semibold">Capabilities</h2>
      <div className="mt-4 overflow-x-auto rounded-xl border">
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
