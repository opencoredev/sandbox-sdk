import { AdapterCarousel, type AdapterSlide } from "@/components/landing/adapter-carousel";
import { Rail } from "./primitives";

const slides: AdapterSlide[] = [
  {
    id: "local",
    name: "Local",
    headline: "Development and CI on the machine you have.",
    palette: "teal",
    variant: "drift",
    seed: 4,
  },
  {
    id: "e2b",
    name: "E2B",
    headline: "Isolated Linux sandboxes for coding agents.",
    palette: "ember",
    variant: "bloom",
    seed: 1,
  },
  {
    id: "daytona",
    name: "Daytona",
    headline: "Persistent workspaces and GPU targets.",
    palette: "indigo",
    variant: "ring",
    seed: 6,
  },
  {
    id: "vercel",
    name: "Vercel Sandbox",
    headline: "Hosted Linux sandboxes on Vercel.",
    palette: "slate",
    variant: "drift",
    seed: 7,
  },
  {
    id: "upstash",
    name: "Upstash Box",
    headline: "Durable containers for serverless agents.",
    palette: "moss",
    variant: "drift",
    seed: 4,
  },
  {
    id: "box",
    name: "Ascii Box",
    headline: "Full cloud VMs with protected previews.",
    palette: "gold",
    variant: "ring",
    seed: 6,
  },
  {
    id: "railway",
    name: "Railway",
    headline: "Ephemeral VMs with private networking.",
    palette: "violet",
    variant: "drift",
    seed: 9,
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    headline: "Sandboxes bound to a Worker.",
    palette: "crimson",
    variant: "bloom",
    seed: 8,
  },
  {
    id: "memory",
    name: "Memory",
    headline: "In-process runs for unit tests.",
    palette: "magma",
    variant: "bloom",
    seed: 2,
  },
];

export function LandingAdaptersHeader() {
  return (
    <Rail>
      <div className="px-6 pt-[72px] min-[900px]:px-16">
        <div className="inline-flex h-[26px] items-center gap-2 border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.03)] px-2.5">
          <span aria-hidden="true" className="block size-1.5 bg-[var(--landing-accent)]" />
          <span className="font-pixel text-[11px] tracking-[0.14em] text-[var(--landing-muted)]">
            ADAPTERS
          </span>
        </div>

        <h2 className="mt-2 font-pixel text-[30px] leading-[38px] text-[var(--landing-ink)] min-[700px]:text-[40px] min-[700px]:leading-[48px]">
          Local, cloud, or in-memory.
        </h2>

        <p className="mt-[14px] max-w-[620px] font-pixel text-[16px] leading-[22.5px] text-[var(--landing-muted)]">
          Develop on your machine, test in memory, ship to E2B, Daytona, Vercel, Upstash, Railway,
          or Cloudflare. The API stays the same.
        </p>
      </div>
    </Rail>
  );
}

export function LandingAdapterCarousel() {
  return (
    <Rail crosses={false}>
      <AdapterCarousel slides={slides} />
    </Rail>
  );
}
