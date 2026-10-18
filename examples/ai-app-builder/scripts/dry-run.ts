/**
 * Headless check of the whole sandbox side, with no model and no API key:
 * the scripted model drives the same buildApp() the chat route uses, then this
 * fetches the preview and destroys the sandbox. Run: bun run dry-run "a todo app"
 */
import { buildApp } from "../lib/agent";
import { destroySessionSandbox, previewPort, providerName, sessionSandbox } from "../lib/sandbox";
import { newSessionId } from "../lib/session";

const prompt = process.argv.slice(2).join(" ").trim() || "A counter app";
const session = newSessionId();
console.log(`provider=${providerName} session=${session}`);

try {
  const box = await sessionSandbox(session);
  const result = await buildApp({
    box,
    model: { kind: "scripted" },
    messages: [{ role: "user", content: prompt }],
    prompt,
  });
  for await (const part of result.fullStream) {
    if (part.type === "tool-call") console.log(`→ ${part.toolName}`);
    if (part.type === "tool-result" && !part.preliminary)
      console.log(`  ${JSON.stringify(part.output).slice(0, 140)}`);
    if (part.type === "tool-error") throw part.error;
    if (part.type === "error") throw part.error;
  }

  const preview = await box.preview(previewPort, { waitMs: 10_000 });
  const html = await (await fetch(preview.url, { headers: preview.headers })).text();
  const css = await fetch(new URL("style.css", preview.url), { headers: preview.headers });
  if (!html.includes(prompt) || !css.ok)
    throw new Error(`Preview did not serve the built app:\n${html.slice(0, 400)}`);
  console.log(`PASS preview ${preview.url} served "${prompt}" and style.css (${css.status})`);
} finally {
  if (process.env.KEEP !== "1") await destroySessionSandbox(session);
}
