import { createFileRoute } from "@tanstack/react-router";
import {
  LandingAdapterCarousel,
  LandingAdaptersHeader,
} from "@/components/landing/sections/adapters";
import { LandingCta } from "@/components/landing/sections/cta";
import { LandingFeatures } from "@/components/landing/sections/features";
import { LandingFooter } from "@/components/landing/sections/footer";
import { LandingHero } from "@/components/landing/sections/hero";
import { LandingNav } from "@/components/landing/sections/nav";
import { HatchDivider } from "@/components/landing/sections/primitives";
import { LandingSteps } from "@/components/landing/sections/steps";
import { LandingSwap } from "@/components/landing/sections/swap";
import { LandingTests } from "@/components/landing/sections/tests";
import { appName, docsOrigin, socialImage } from "@/lib/shared";

const title = `${appName}: give your agent a sandbox`;
const description =
  "Add an isolated sandbox to your app in one import. Commands, files, and git, on nine providers, behind one TypeScript API.";

export const Route = createFileRoute("/")({
  component: LandingPage,
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: docsOrigin },
      { property: "og:image", content: socialImage.url },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: socialImage.url },
    ],
    links: [{ rel: "canonical", href: docsOrigin }],
  }),
});

function LandingPage() {
  return (
    <div
      className="landing-root flex-1 bg-[var(--landing-bg)] text-[var(--landing-body)] antialiased min-h-[100dvh]"
      style={{ colorScheme: "dark" }}
    >
      <LandingNav />
      <main>
        <LandingHero />
        <LandingSteps />
        <HatchDivider />
        <LandingAdaptersHeader />
        <LandingAdapterCarousel />
        <LandingSwap />
        <LandingFeatures />
        <LandingTests />
        <HatchDivider />
        <LandingCta />
      </main>
      <LandingFooter />
    </div>
  );
}
