import { Callout } from "fumadocs-ui/components/callout";

export const metadata = {
  title: "Provider partnerships",
  description:
    "Fund continuous testing and adapter maintenance without influencing compatibility results.",
  alternates: { canonical: "/partners" },
};

export default function PartnersPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-16 md:py-24">
      <div className="max-w-3xl">
        <p className="text-sm font-medium text-fd-primary">Provider partnerships</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          A consistent path to your platform.
        </h1>
        <p className="mt-5 text-lg leading-8 text-fd-muted-foreground">
          Sandbox SDK gives developers a consistent path to your platform. Partnerships fund
          continuous testing, maintenance and documentation.
        </p>
      </div>

      <Callout className="mt-8" title="Sponsorship never changes compatibility results">
        Technical status, provider review and commercial sponsorship are reported separately.
      </Callout>

      <article className="prose mt-12 max-w-3xl">
        <h2>What we maintain</h2>
        <p>
          OpenCore maintains integrations for Local, E2B, Daytona, Vercel Sandbox, Upstash Box, and
          Railway.
          Local is powered by AgentOS under the hood. The unified API covers files, commands,
          processes, ports, capabilities, errors, cleanup and typed native access.
        </p>

        <h2>Continuous compatibility testing</h2>
        <p>
          Contract tests run on every change. Credential-gated live tests exercise real provider
          infrastructure on a schedule, record package versions and timestamps, and feed the public
          matrix. Partners provide test credentials or credits so coverage stays current.
        </p>

        <h2>Why OpenCore</h2>
        <p>
          OpenCore builds developer infrastructure, including Email SDK. That work informs the same
          standards here: small APIs, typed provider boundaries, executable documentation and honest
          runtime limitations.
        </p>

        <h2>Founding Adapter Partner — $150/month</h2>
        <p>
          Continuous live testing, maintainer-owned adapter maintenance, dedicated provider
          documentation, priority compatibility fixes, reviewed badge after review, founding
          placement, release inclusion, referral tracking where practical, and credential/credit
          coordination.
        </p>

        <h2>Featured Founding Partner — $250/month</h2>
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
