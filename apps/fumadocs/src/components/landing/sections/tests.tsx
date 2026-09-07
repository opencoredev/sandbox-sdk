import { CheckMark, PanelBrackets, Rail } from "./primitives";

const claims = [
  "The full sandbox API, not a mock",
  "No API key and no network in CI",
  "The same code paths as the cloud adapters",
];

const results = [
  "creates a sandbox in-process",
  "files round-trip",
  "$ throws on a non-zero exit",
];

export function LandingTests() {
  return (
    <Rail className="border-t border-[var(--landing-line)]">
      <div className="grid grid-cols-1 divide-y divide-[var(--landing-line)] min-[900px]:grid-cols-2 min-[900px]:divide-x min-[900px]:divide-y-0">
        <div className="min-w-0 px-6 pt-[65px] pb-[93.5px] min-[900px]:px-16">
          <h2 className="font-pixel text-[30px] leading-[38px] text-[var(--landing-ink)] min-[700px]:text-[40px] min-[700px]:leading-[48px]">
            Tests run in-process.
          </h2>

          <p className="mt-[15px] max-w-[410px] font-pixel text-[16px] leading-[23.5px] text-[var(--landing-muted)]">
            memory() is a real adapter that keeps the whole sandbox API inside your test process.
            Nothing to boot, nothing to pay for.
          </p>

          <ul className="mt-[33px] flex flex-col gap-[20.5px]">
            {claims.map((claim) => (
              <li className="flex items-center gap-3" key={claim}>
                <span className="flex size-[18px] shrink-0 items-center justify-center bg-[var(--landing-accent)] text-[var(--landing-accent-ink)]">
                  <CheckMark />
                </span>
                <span className="font-pixel text-[15px] leading-none text-[var(--landing-body)]">
                  {claim}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex min-w-0 items-start justify-center px-6 pt-[84px] pb-[72px]">
          <div className="relative h-fit w-full max-w-[427px] border border-[var(--landing-line)] bg-[#101114]">
            <PanelBrackets />
            <div className="flex h-10 items-center border-b border-[var(--landing-line)] px-5 font-mono text-[12px] text-[var(--landing-dim)]">
              bun test
            </div>
            <div className="overflow-x-auto px-5 py-4 font-mono text-[13px] leading-[27px]">
              {results.map((result) => (
                <div className="flex items-center gap-2" key={result}>
                  <CheckMark className="text-[var(--landing-body)]" size={11} />
                  <span className="text-[var(--landing-body)]">{result}</span>
                </div>
              ))}
              <p className="mt-2 text-[var(--landing-dim)]">
                3 pass, 0 fail on the memory adapter
              </p>
            </div>
          </div>
        </div>
      </div>
    </Rail>
  );
}
