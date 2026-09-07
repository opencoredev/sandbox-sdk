import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Token colors for the two swap panels. */
const tokenColor = {
  kw: "#8C97A8",
  str: "#D6A86C",
  id: "#E6EAF0",
  punc: "#AEB6C2",
} as const;

export type TokenKind = keyof typeof tokenColor;
export type Token = readonly [TokenKind, string];

/** A whole-line tone overrides token colors. */
const lineColor = {
  removed: "#A96F6F",
  added: "#8FBF8A",
  dim: "#697180",
} as const;

export type LineTone = keyof typeof lineColor;

export interface CodeLine {
  tokens?: readonly Token[];
  text?: string;
  tone?: LineTone;
}

function LineBody({ line }: { line: CodeLine }) {
  if (line.tone) {
    return (
      <span style={{ color: lineColor[line.tone] }}>
        {line.text ?? line.tokens?.map((token) => token[1]).join("") ?? ""}
      </span>
    );
  }

  if (!line.tokens) return <span style={{ color: tokenColor.id }}>{line.text ?? ""}</span>;

  return (
    <>
      {line.tokens.map((token, index) => (
        <span key={`${token[0]}-${index}`} style={{ color: tokenColor[token[0]] }}>
          {token[1]}
        </span>
      ))}
    </>
  );
}

export function CodePanel({
  filename,
  lines,
  className,
}: {
  filename: string;
  lines: readonly CodeLine[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "w-full border border-[var(--landing-line)] bg-[var(--landing-surface)]",
        className,
      )}
    >
      <div className="flex h-10 items-center border-b border-[var(--landing-line)] px-5 font-pixel text-[12px] text-[var(--landing-dim)]">
        {filename}
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-[22px]">
        <code>
          {lines.map((line, index) =>
            line.text === "" && !line.tokens ? (
              // Blank lines are 16px in the artboard, not a full 22px line box.
              <span className="block h-4" key={`line-${index}`} />
            ) : (
              <span className="block whitespace-pre" key={`line-${index}`}>
                <LineBody line={line} />
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}

/** Single-line mono chip used by the steps band and the CTA band. */
export function CodeChip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-fit max-w-full items-center border border-[rgba(255,255,255,0.12)] bg-[var(--landing-chip)] font-mono text-[#E6EAF0]",
        className,
      )}
    >
      <span className="truncate">{children}</span>
    </div>
  );
}
