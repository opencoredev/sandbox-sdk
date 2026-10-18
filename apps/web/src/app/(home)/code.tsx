import { Fragment, type ReactNode } from "react";

import styles from "./landing.module.css";

const TOKEN =
  /(\/\/.*$)|("[^"]*"|`[^`]*`)|\b(import|from|await|using|const|for|of|if|new)\b|(\b\d[\d_]*\b)/g;

/** Colours a line of TypeScript: comments, strings, keywords, numbers. */
function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(line.slice(last, at));
    const cls = m[1]
      ? styles.tkComment
      : m[2]
        ? styles.tkString
        : m[3]
          ? styles.tkKeyword
          : styles.tkNumber;
    out.push(
      <span key={at} className={cls}>
        {m[0]}
      </span>,
    );
    last = at + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/** A read-only code listing. Lines starting with "+ " or "- " render as a diff; "" is a blank spacer. */
export function Code({ lines, muted = [] }: { lines: string[]; muted?: number[] }) {
  return (
    <pre className={styles.code}>
      <code>
        {lines.map((line, i) => {
          if (line === "") return <span key={i} className={styles.codeGap} />;
          const diff = line.startsWith("+ ")
            ? styles.codeAdd
            : line.startsWith("- ")
              ? styles.codeDel
              : "";
          const body = diff ? line.slice(2) : line;
          return (
            <Fragment key={i}>
              <span
                className={`${styles.codeLine} ${diff} ${muted.includes(i) ? styles.codeMuted : ""}`}
              >
                {diff && <span className={styles.codeSign}>{line[0]}</span>}
                {diff ? body : highlight(body)}
              </span>
            </Fragment>
          );
        })}
      </code>
    </pre>
  );
}
