import { DitherField } from "@/components/landing/dither-field";
import { CodeChip } from "./code";
import { ReadDocsButton } from "./primitives";

export function LandingCta() {
  return (
    <section className="relative h-[500px] overflow-hidden">
      <DitherField
        animate
        cell={10}
        className="absolute inset-0 size-full"
        fade="edges"
        level={0.82}
        palette="ember"
        variant="bloom"
      />
      <span aria-hidden="true" className="absolute inset-0 block bg-[rgba(5,6,8,0.42)]" />

      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="mx-auto h-full w-full max-w-[1200px] px-6">
          <div className="h-full border-x border-[var(--landing-line)]" />
        </div>
      </div>

      {/* pb offsets the H2 line box so the cap block centres on the band, as drawn. */}
      <div className="relative flex h-full flex-col items-center justify-center px-6 pb-[18px] text-center">
        <h2 className="font-pixel text-[32px] leading-[40px] text-white min-[700px]:text-[44px] min-[700px]:leading-[52px]">
          Start in one install.
        </h2>

        <CodeChip className="mt-[14px] h-[46px] max-w-full border-[rgba(255,255,255,0.18)] bg-[rgba(5,6,8,0.72)] px-5 text-[14px]">
          bun add @opencoredev/sandbox-sdk
        </CodeChip>

        <ReadDocsButton className="mt-[25px]" />
      </div>
    </section>
  );
}
