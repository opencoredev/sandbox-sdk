import { CodeChip } from "./code";
import { Label, Rail } from "./primitives";

const steps = [
  {
    label: "Install",
    code: "bun add @opencoredev/sandbox-sdk",
    caption: "One package, every adapter included",
  },
  {
    label: "Create",
    code: "await using sandbox = await e2b().create()",
    caption: "Stops itself when the scope exits",
  },
  {
    label: "Run",
    code: "await sandbox.$`bun test`",
    caption: "Commands, files, and git inside the VM",
  },
] as const;

/** Cell widths follow the artboard: 339 / 399 / 412 inside the 1152 rail. */
export function LandingSteps() {
  return (
    <Rail className="border-t border-[var(--landing-line)]">
      {/* Three columns only at the full 1152 rail: the CREATE command needs 332px
          of a 343px cell, so a fluid rail below 1200 cannot show it in full. */}
      <div className="grid grid-cols-1 divide-y divide-[var(--landing-line)] min-[1200px]:grid-cols-[339fr_399fr_412fr] min-[1200px]:divide-x min-[1200px]:divide-y-0">
        {steps.map((step) => (
          <div className="flex min-h-[190px] min-w-0 flex-col justify-between p-7" key={step.label}>
            <Label>{step.label}</Label>
            <div>
              <CodeChip className="h-10 px-4 text-[12px]">{step.code}</CodeChip>
              <p className="mt-4 font-pixel text-[13px] leading-none text-[var(--landing-muted)]">
                {step.caption}
              </p>
            </div>
          </div>
        ))}
      </div>
    </Rail>
  );
}
