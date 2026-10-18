"use client";

import { useChat } from "@ai-sdk/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

const examples = [
  "A pomodoro timer with a big start button",
  "A tip calculator that splits the bill",
  "A habit tracker for the current week",
];

type ToolPart = ReturnType<typeof toolParts>[number];

function toolParts(message: UIMessage) {
  return message.parts.filter(isToolUIPart);
}

/** sandboxTools results are `{ text }`; UI messages type tool output as unknown. */
function outputText(output: unknown): string {
  return typeof output === "object" &&
    output !== null &&
    "text" in output &&
    typeof output.text === "string"
    ? output.text
    : "";
}

/** The one argument worth showing on the activity line. */
function summary(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  for (const key of ["command", "path", "name", "query"] as const) {
    if (key in input) {
      const value: unknown = Reflect.get(input, key);
      if (typeof value === "string") return value.split("\n")[0] ?? "";
    }
  }
  return "";
}

type Verdict =
  | { kind: "running" }
  | { kind: "ok"; detail: string }
  | { kind: "failed"; detail: string };

function verdictOf(part: ToolPart): Verdict {
  switch (part.state) {
    case "output-available": {
      if (part.preliminary) return { kind: "running" };
      const [line = ""] = outputText(part.output).split("\n");
      const detail = line
        .replace(/^(OK|FAILED)\s*/, "")
        .replace(/cwd=\S+/, "")
        .trim();
      return line.startsWith("FAILED") ? { kind: "failed", detail } : { kind: "ok", detail };
    }
    case "output-error":
      return { kind: "failed", detail: "error" };
    case "output-denied":
      return { kind: "failed", detail: "denied" };
    default:
      return { kind: "running" };
  }
}

function ToolLine({ part }: { part: ToolPart }) {
  const verdict = verdictOf(part);
  const body =
    part.state === "output-error"
      ? part.errorText
      : part.state === "output-available"
        ? outputText(part.output)
        : "";
  return (
    <details className="tool" data-verdict={verdict.kind}>
      <summary>
        <span className="dot" aria-hidden />
        <span className="tool-name">{getToolName(part)}</span>
        <span className="tool-arg">{summary(part.input)}</span>
        <span className="tool-verdict">
          {verdict.kind === "running"
            ? "running"
            : verdict.kind === "ok"
              ? verdict.detail || "ok"
              : verdict.detail || "failed"}
        </span>
      </summary>
      {body ? <pre>{body}</pre> : null}
    </details>
  );
}

function Message({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    return <p className="msg-user">{text}</p>;
  }
  return (
    <div className="msg-agent">
      {message.parts.map((part, index) => {
        if (part.type === "text") return part.text.trim() ? <p key={index}>{part.text}</p> : null;
        if (isToolUIPart(part)) return <ToolLine key={part.toolCallId} part={part} />;
        return null;
      })}
    </div>
  );
}

/** Ready once a start_process call reports ready=true; bumps on every later file change. */
function usePreview(messages: UIMessage[]) {
  return useMemo(() => {
    let ready = false;
    let revision = 0;
    for (const part of messages.flatMap(toolParts)) {
      if (part.state !== "output-available" || part.preliminary) continue;
      const name = getToolName(part);
      if (name === "start_process" && outputText(part.output).includes("ready=true")) ready = true;
      if (["start_process", "write_file", "edit_file"].includes(name)) revision++;
    }
    return { ready, revision };
  }, [messages]);
}

export function Builder({ provider, model }: { provider: string; model: string }) {
  const { messages, sendMessage, status, stop, error, setMessages } = useChat();
  const [input, setInput] = useState("");
  const [reloads, setReloads] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const preview = usePreview(messages);
  const busy = status === "submitted" || status === "streaming";
  const src = `/preview/?v=${preview.revision}.${reloads}`;

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    void sendMessage({ text });
    setInput("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  }

  async function reset() {
    stop();
    await fetch("/api/sandbox", { method: "DELETE" });
    setMessages([]);
  }

  return (
    <div className="shell">
      <header className="bar">
        <span className="brand">
          <span className="mark" aria-hidden />
          Sandbox SDK <span className="muted">/ app builder</span>
        </span>
        <span className="meta">
          <span>{provider}</span>
          <span>{model}</span>
          <button type="button" className="ghost" onClick={reset} disabled={messages.length === 0}>
            New sandbox
          </button>
        </span>
      </header>

      <section className="chat" aria-label="Agent">
        <div className="log" ref={log}>
          {messages.length === 0 ? (
            <div className="empty">
              <h1>Describe an app.</h1>
              <p>
                An agent writes it inside a sandbox, starts the server, and the preview shows up on
                the right.
              </p>
              <ul>
                {examples.map((example) => (
                  <li key={example}>
                    <button type="button" onClick={() => setInput(example)}>
                      {example}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            messages.map((message) => <Message key={message.id} message={message} />)
          )}
          {status === "submitted" ? <p className="thinking">Starting sandbox…</p> : null}
          {error ? <p className="error">{error.message}</p> : null}
        </div>
        <form className="composer" onSubmit={submit}>
          <label htmlFor="prompt" className="sr-only">
            What should the agent build?
          </label>
          <textarea
            id="prompt"
            rows={3}
            value={input}
            placeholder="What should the agent build?"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="composer-row">
            <span className="hint">Enter to build · Shift+Enter for a new line</span>
            {busy ? (
              <button type="button" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()}>
                Build
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="preview" aria-label="Preview">
        <div className="chrome">
          <span className="url">
            <span className={preview.ready ? "live" : "idle"} aria-hidden />
            {preview.ready ? `sandbox :3000` : "no server yet"}
          </span>
          <span className="chrome-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => setReloads((n) => n + 1)}
              disabled={!preview.ready}
            >
              Reload
            </button>
            {preview.ready ? (
              <a className="ghost" href="/preview/" target="_blank" rel="noreferrer">
                Open
              </a>
            ) : null}
          </span>
        </div>
        {preview.ready ? (
          <iframe
            key={src}
            src={src}
            title="App preview"
            sandbox="allow-scripts allow-forms allow-same-origin"
          />
        ) : (
          <div className="placeholder">
            <p>The preview appears here once the agent starts a server on port 3000.</p>
          </div>
        )}
      </section>
    </div>
  );
}
