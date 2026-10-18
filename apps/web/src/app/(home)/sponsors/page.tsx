import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";
import Link from "next/link";

export const metadata = {
  title: "Sponsors",
  description: "How sponsorship funds Sandbox SDK maintenance.",
  alternates: { canonical: "/sponsors" },
};

export default function SponsorsPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-16 md:py-24">
      <div className="max-w-3xl">
        <p className="text-sm font-medium text-fd-primary">Open-source sustainability</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          Fund the maintenance loop.
        </h1>
        <p className="mt-5 text-lg leading-8 text-fd-muted-foreground">
          Sponsorship pays for continuous live tests, provider SDK updates, adapter maintenance,
          documentation, examples, faster compatibility fixes and open-source support.
        </p>
      </div>

      <Cards className="mt-10">
        <Card
          title="Founding Adapter Partner"
          description="$150/month · Maintainer-owned integration, continuous tests, docs and priority compatibility fixes."
        />
        <Card
          title="Featured Founding Partner"
          description="$250/month · Adds clearly labeled placement, a dedicated example and launch collaboration."
        />
      </Cards>

      <Callout
        type="warn"
        className="mt-8"
        title="Commercial support does not affect technical status"
      >
        Money never changes test results, rankings, limitations or recommendations.
      </Callout>

      <Link
        href="/partners"
        className="mt-8 inline-flex rounded-[6px] bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground"
      >
        View partnership details
      </Link>
    </main>
  );
}
