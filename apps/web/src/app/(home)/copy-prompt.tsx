"use client";

import { useCallback, useState } from "react";

import styles from "./paper.module.css";

/** The 1.0 quickstart as Markdown, for agents. Update when the 1.0 docs move to sandbox-sdk.app. */
const QUICKSTART_MD = "https://sandbox-sdk.app/docs/getting-started/quickstart.md";

/** What a coding agent needs to add Sandbox SDK to a project, ready to paste. */
const AGENT_PROMPT = `Add Sandbox SDK (@opencoredev/sandbox-sdk) to this project so it can run code in isolated sandboxes.

1. Install it with the project's package manager, for example \`npm install @opencoredev/sandbox-sdk\`. Install a provider's own SDK only for the providers you use, such as \`e2b\`.
2. Read the quickstart before writing code: ${QUICKSTART_MD}
3. Create sandboxes with \`await using box = await createSandbox(provider)\` so they are cleaned up when the scope ends.
4. A command that exits non-zero resolves with \`ok: false\`; check \`result.ok\` instead of catching errors.
5. Use the \`memory()\` provider from \`@opencoredev/sandbox-sdk/memory\` in tests: no network and no API key.
6. Keep provider API keys on the server. Never send them to the browser.`;

/**
 * The async clipboard API exists only in secure contexts and can be refused.
 * Either way, fall back to a hidden textarea and execCommand, then hand focus back.
 */
async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);

    return;
  } catch {
    // no async clipboard here (plain HTTP) or it was refused: use the textarea route
  }

  const focused = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();

  if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });

  if (!ok) throw new Error("copy was refused");
}

const AGENTS = ["claude", "chatgpt", "grok", "cursor"] as const;

/** Copies a ready-made prompt for Claude Code, Codex, Grok or Cursor, with their marks stacked in front. */
export function CopyPrompt() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = useCallback(async () => {
    try {
      await writeClipboard(AGENT_PROMPT);
      setState("copied");
    } catch {
      setState("failed");
    }

    window.setTimeout(() => setState("idle"), 1800);
  }, []);

  return (
    <>
      <button
        type="button"
        className={styles.prompt}
        data-copied={state === "copied" || undefined}
        onClick={copy}
        aria-label="Copy quick start prompt for your agent"
      >
        <span className={styles.agents} aria-hidden="true">
          {AGENTS.map((a) => (
            <i key={a} className={`${styles.agent} ${styles[a]}`} />
          ))}
        </span>
        <span className={styles.promptLabel}>
          <span>{state === "failed" ? "Couldn't copy, try again" : "Copy quick start prompt"}</span>
          <span className={styles.promptDone}>Copied to clipboard</span>
        </span>
      </button>
      <span className={styles.srOnly} role="status">
        {state === "copied"
          ? "Prompt copied to clipboard"
          : state === "failed"
            ? "Copy failed"
            : ""}
      </span>
    </>
  );
}
