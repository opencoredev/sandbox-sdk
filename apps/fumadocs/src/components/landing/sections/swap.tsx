import { type CodeLine, CodePanel } from "./code";
import { Rail } from "./primitives";

const quickstart: CodeLine[] = [
  {
    tokens: [
      ["kw", "import"],
      ["punc", " { "],
      ["id", "e2b"],
      ["punc", " } "],
      ["kw", "from"],
      ["punc", " "],
      ["str", '"@opencoredev/sandbox-sdk/e2b"'],
      ["punc", ";"],
    ],
  },
  { text: "" },
  {
    tokens: [
      ["kw", "await using"],
      ["punc", " "],
      ["id", "sandbox"],
      ["punc", " = "],
      ["kw", "await"],
      ["punc", " "],
      ["id", "e2b"],
      ["punc", "()."],
      ["id", "create"],
      ["punc", "();"],
    ],
  },
  { text: "" },
  {
    tokens: [
      ["kw", "const"],
      ["punc", " "],
      ["id", "result"],
      ["punc", " = "],
      ["kw", "await"],
      ["punc", " "],
      ["id", "sandbox"],
      ["punc", ".$"],
      ["str", "`node --version`"],
      ["punc", ";"],
    ],
  },
  {
    tokens: [
      ["id", "console"],
      ["punc", "."],
      ["id", "log"],
      ["punc", "("],
      ["id", "result"],
      ["punc", "."],
      ["id", "stdout"],
      ["punc", ");"],
    ],
  },
];

const swap: CodeLine[] = [
  { text: '- import { e2b } from "@opencoredev/sandbox-sdk/e2b";', tone: "removed" },
  { text: '+ import { vercel } from "@opencoredev/sandbox-sdk/vercel";', tone: "added" },
  { text: "" },
  { text: "- await using sandbox = await e2b().create();", tone: "removed" },
  { text: "+ await using sandbox = await vercel().create();", tone: "added" },
  { text: "" },
  { text: "const result = await sandbox.$`node --version`;", tone: "dim" },
  { text: "console.log(result.stdout);", tone: "dim" },
];

export function LandingSwap() {
  return (
    <Rail className="border-t border-[var(--landing-line)]">
      <div className="pt-[89px] pb-[97px]">
        <div className="px-6 min-[900px]:px-16">
          <h2 className="font-pixel text-[30px] leading-[38px] text-[var(--landing-ink)] min-[700px]:text-[40px] min-[700px]:leading-[48px]">
            Swap the adapter, keep the code.
          </h2>

          <p className="mt-3 max-w-[580px] font-pixel text-[16px] leading-[23.5px] text-[var(--landing-muted)]">
            Every adapter passes the same conformance suite. Moving providers is an import change,
            not a rewrite.
          </p>
        </div>

        {/* Panels run rail edge to rail edge: 560 + 32 gap + 560. */}
        <div className="mt-[37px] grid grid-cols-1 gap-8 px-6 min-[900px]:grid-cols-2 min-[900px]:px-0">
          <CodePanel className="min-w-0" filename="quickstart.ts" lines={quickstart} />
          <CodePanel className="min-w-0" filename="move to Vercel Sandbox" lines={swap} />
        </div>
      </div>
    </Rail>
  );
}
