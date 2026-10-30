import { stripVTControlCharacters } from "node:util";
import type { Redactor } from "./errors.js";
import type { OutputChunk, SandboxBase } from "./types.js";
import { chunkRedactor } from "./run.js";

const redactors = new WeakMap<SandboxBase<unknown>, Redactor>();

export function registerToolRedactor(box: SandboxBase<unknown>, redactor: Redactor) {
  redactors.set(box, redactor);
}

function redactorOf(box: SandboxBase<unknown>) {
  const redactor = redactors.get(box);

  if (!redactor)
    throw new Error(
      "Unknown sandbox handle. Secret redaction cannot be guaranteed. Use createSandbox or connectSandbox.",
    );

  return redactor;
}

export function redactToolText(box: SandboxBase<unknown>, text: string) {
  return redactorOf(box).text(stripVTControlCharacters(text));
}

/** ANSI sequences and secrets can both cross transport boundaries. Normalize before redacting. */
export function toolOutputFilter(box: SandboxBase<unknown>, emit: (chunk: OutputChunk) => void) {
  type State = "plain" | "escape" | "csi" | "string" | "string_escape";

  const states: Record<OutputChunk["stream"], State> = { stdout: "plain", stderr: "plain" };
  const filter = chunkRedactor(redactorOf(box), emit, true);

  return {
    push(chunk: OutputChunk) {
      let state = states[chunk.stream],
        text = "";

      for (const char of chunk.text) {
        switch (state) {
          case "plain":
            if (char === "\x1b") state = "escape";
            else if (char === "\x9b") state = "csi";
            else if ("\x90\x98\x9d\x9e\x9f".includes(char)) state = "string";
            else text += char;
            break;
          case "escape":
            state =
              char === "["
                ? "csi"
                : "]PX^_".includes(char)
                  ? "string"
                  : char >= " " && char <= "/"
                    ? "escape"
                    : "plain";
            break;
          case "csi":
            if (char >= "@" && char <= "~") state = "plain";
            break;
          case "string":
            if (char === "\x07" || char === "\x9c") state = "plain";
            else if (char === "\x1b") state = "string_escape";
            break;
          case "string_escape":
            state = char === "\\" ? "plain" : "string";
            break;
          default: {
            const exhaustive: never = state;

            return exhaustive;
          }
        }
      }

      states[chunk.stream] = state;

      if (text) filter.push({ stream: chunk.stream, text });
    },
    flush() {
      filter.flush();
    },
  };
}
