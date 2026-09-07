import { createFileRoute } from "@tanstack/react-router";
import { Callout } from "fumadocs-ui/components/callout";
import { docsOrigin } from "@/lib/shared";

export const Route = createFileRoute("/_marketing/partners")({
  component: PartnersPage,
  head: () => ({
    meta: [
      { title: "Provider partnerships" },
      {
        name: "description",
        content:
          "Fund adapter maintenance and credential-gated compatibility testing without influencing results.",
      },
    ],
    links: [{ rel: "canonical", href: new URL("/partners", docsOrigin).toString() }],
  }),
});

function PartnersPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-16 md:py-24">
      <div className="max-w-3xl">
        <p className="text-sm font-medium text-fd-primary">Provider partnerships</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          A consistent path to your platform.
        </h1>
        <p className="mt-5 text-lg leading-8 text-fd-muted-foreground">
          Sandbox SDK gives developers a consistent path to your platform. Partnerships fund adapter
          maintenance, documentation, and credential-gated compatibility testing.
        </p>
      </div>

      <Callout className="mt-8" title="Sponsorship never changes compatibility results">
        Technical status, provider review and commercial sponsorship are reported separately.
      </Callout>

      <article className="prose mt-12 max-w-3xl">
        <h2>What we maintain</h2>
        <p>
          OpenCore maintains Local, Memory, E2B, Daytona, Vercel Sandbox, Upstash Box, Ascii Box, and
          Railway. Memory is an in-process test double, not a security boundary. Local uses AgentOS.
          Files, commands, and cleanup are portable. Ports and snapshots stay adapter-specific.
        </p>

        <h2>Compatibility testing</h2>
        <p>
          Contract tests run on every change. Credential-gated live tests can exercise real provider
          infrastructure when credentials are available. Today every shipped adapter records
          liveTest: null. A provider counts as live tested only when Sandbox SDK retains a dated
          result. There is no published live-test schedule.
        </p>

        <h2>Why OpenCore</h2>
        <p>
          OpenCore builds developer infrastructure, including Email SDK. That work informs the same
          standards here: small APIs, typed provider boundaries, executable documentation and honest
          runtime limitations.
        </p>

        <h2>Founding Adapter Partner - $150/month</h2>
        <p>
          Credential-gated live testing, maintainer-owned adapter maintenance, dedicated provider
          documentation, priority compatibility fixes, reviewed badge after review, founding
          placement, release inclusion, referral tracking where practical, and credential/credit
          coordination.
        </p>

        <h2>Featured Founding Partner - $250/month</h2>
        <p>
          Everything above, plus labeled homepage sponsor placement, a dedicated integration
          example, launch collaboration, a priority communication channel, changelog visibility and
          measurable referral links where practical.
        </p>

        <h2>The line we do not cross</h2>
        <p>
          Sponsorship cannot buy better results, hidden limitations, automatic recommendations,
          competitor suppression or misleading comparisons. Paying providers are not ranked above
          non-sponsors.
        </p>

        <h2>Talk with us</h2>
        <p>
          Email <a href="mailto:hello@opencore.dev">hello@opencore.dev</a> with your provider SDK
          owner, testing credentials or credits, review contact and preferred tier.
        </p>
      </article>
    </main>
  );
}
