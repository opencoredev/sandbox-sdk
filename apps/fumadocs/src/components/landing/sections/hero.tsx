import { ArrowRight, Rail, ReadDocsButton } from "./primitives";

export function LandingHero() {
  return (
    <Rail>
      <div className="flex flex-col items-center px-6 pt-[100px] pb-[92px] text-center min-[900px]:px-16">
        <div className="inline-flex h-[34px] items-center gap-3 border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.03)] px-4">
          <span aria-hidden="true" className="block size-1.5 bg-[var(--landing-accent)]" />
          <span className="font-pixel text-[13px] text-[var(--landing-body)]">
            Introducing Sandbox SDK
          </span>
          <ArrowRight className="text-[var(--landing-dim)]" size={14} />
        </div>

        <h1 className="mt-[18px] max-w-[900px] font-pixel text-[38px] leading-[46px] text-balance text-[var(--landing-ink)] min-[700px]:text-[62px] min-[700px]:leading-[70px]">
          Give your agent a sandbox.
        </h1>

        <p className="mt-[26px] max-w-[520px] font-pixel text-[17px] leading-[24.5px] text-[var(--landing-muted)]">
          Add an isolated sandbox to your app in one import. Commands, files, and git, on nine
          providers.
        </p>

        <ReadDocsButton className="mt-10" />
      </div>
    </Rail>
  );
}
