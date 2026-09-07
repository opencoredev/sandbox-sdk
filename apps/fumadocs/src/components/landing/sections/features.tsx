import { Rail } from "./primitives";

const INK = "#E6EAF0";
const DIM = "#697180";
const RED = "#A96F6F";
const AMBER = "var(--landing-accent)";

type Part = readonly [string, string];

const features = [
  {
    title: "Run commands",
    body: "Tagged-template shell with safe interpolation. Streamed output, timeouts, and a typed error when the exit code is not zero.",
    lines: [
      [
        ["$", AMBER],
        [" sandbox.$`bun run build`", INK],
      ],
      [["build finished", DIM]],
      [["exit 0", INK]],
      [
        ["$", AMBER],
        [" sandbox.$`exit 1`", INK],
      ],
      [["throws CommandFailedError", RED]],
    ],
  },
  {
    title: "Move files and repos",
    body: "Read, write, watch, upload, download. Clone with token redaction, then pull, checkout, and status on every adapter.",
    lines: [
      [
        ["files.write(", INK],
        ['"src/app.ts"', AMBER],
        [", code)", INK],
      ],
      [
        ["files.watch(", INK],
        ['"src"', AMBER],
        [", onChange)", INK],
      ],
      [["git.clone(url, { auth })", INK]],
      [["token redacted in logs", DIM]],
      [
        ["git.checkout(", INK],
        ['"main"', AMBER],
        [")", INK],
      ],
    ],
  },
  {
    title: "Control the lifecycle",
    body: "Create, reconnect by id, list what is running, extend timeouts, stop or destroy. Capabilities are declared per adapter.",
    lines: [
      [
        ["connectSandbox({ id: ", INK],
        ['"sb_7f2"', AMBER],
        [" })", INK],
      ],
      [["sandbox.extendTimeout(60_000)", INK]],
      [
        ["listSandboxes(", INK],
        ['"e2b"', AMBER],
        [")", INK],
      ],
      [["sandbox.destroy()", INK]],
      [["gated by capabilities", DIM]],
    ],
  },
] as const satisfies readonly {
  title: string;
  body: string;
  lines: readonly (readonly Part[])[];
}[];

export function LandingFeatures() {
  return (
    <Rail className="border-t border-[var(--landing-line)]">
      <div className="grid grid-cols-1 grid-rows-[auto_auto] divide-y divide-[var(--landing-line)] min-[900px]:grid-cols-3 min-[900px]:divide-x min-[900px]:divide-y-0">
        {features.map((feature) => (
          <div
            className="row-span-2 grid min-w-0 grid-rows-subgrid gap-0 px-8 pt-8 pb-[33.5px]"
            key={feature.title}
          >
            <h3 className="font-pixel text-[18px] leading-[25px] text-[var(--landing-ink)]">
              {feature.title}
            </h3>
            <p className="mt-[13px] max-w-[305px] font-pixel text-[14px] leading-[20.5px] text-[var(--landing-muted)]">
              {feature.body}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 divide-y divide-[var(--landing-line)] border-t border-[var(--landing-line)] min-[900px]:grid-cols-3 min-[900px]:divide-x min-[900px]:divide-y-0">
        {features.map((feature) => (
          <div
            className="flex min-h-[250px] min-w-0 flex-col justify-center overflow-x-auto px-10 py-8 font-mono text-[13px] leading-[27px]"
            key={feature.title}
          >
            {feature.lines.map((line) => (
              <span className="block whitespace-pre" key={line.map((part) => part[0]).join("")}>
                {line.map((part) => (
                  <span key={part[0]} style={{ color: part[1] }}>
                    {part[0]}
                  </span>
                ))}
              </span>
            ))}
          </div>
        ))}
      </div>
    </Rail>
  );
}
