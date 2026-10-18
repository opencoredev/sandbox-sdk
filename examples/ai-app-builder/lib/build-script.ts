import type { ScriptedStep } from "./scripted";

const server = `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const root = new URL("./public/", import.meta.url).pathname;

createServer(async (request, response) => {
  const path = normalize(new URL(request.url, "http://x").pathname).replace(/^\\/+/, "") || "index.html";
  try {
    const body = await readFile(join(root, path));
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(3000, "0.0.0.0", () => console.log("Listening on http://0.0.0.0:3000"));
`;

const escape = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char,
  );

const page = (prompt: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(prompt)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <p class="eyebrow">Built in a sandbox</p>
    <h1>${escape(prompt)}</h1>
    <p class="lede">A scripted dry run wrote these files, started <code>node server.js</code>, and is serving it on port 3000.</p>
    <div class="counter">
      <button id="minus" aria-label="Decrease">−</button>
      <output id="count">0</output>
      <button id="plus" aria-label="Increase">+</button>
    </div>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

const style = `:root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f1ea; color: #1b1a17; }
main { width: min(560px, calc(100vw - 48px)); }
.eyebrow { margin: 0 0 12px; font: 600 12px/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; color: #9a6a1f; }
h1 { margin: 0; font-size: clamp(32px, 7vw, 56px); line-height: 1.02; letter-spacing: -.03em; text-wrap: balance; }
.lede { margin: 16px 0 32px; color: #5d5a52; line-height: 1.55; }
code { font-size: .92em; }
.counter { display: inline-flex; align-items: center; gap: 20px; padding: 10px; border: 1px solid #ddd6c8; border-radius: 14px; background: #fff; }
button { width: 44px; height: 44px; border: 0; border-radius: 10px; background: #1b1a17; color: #fff; font-size: 22px; cursor: pointer; }
button:active { transform: scale(.96); }
output { min-width: 3ch; text-align: center; font: 600 28px/1 ui-monospace, monospace; font-variant-numeric: tabular-nums; }
`;

const script = `let count = 0;
const output = document.getElementById("count");
const set = (next) => { count = next; output.textContent = String(count); };
document.getElementById("plus").addEventListener("click", () => set(count + 1));
document.getElementById("minus").addEventListener("click", () => set(count - 1));
`;

/** What AI_MODEL=scripted "decides": write a tiny app, serve it, confirm it answers. */
export function buildScript(options: { prompt: string; restart: boolean }): ScriptedStep[] {
  return [
    {
      say: "Writing a small static app and a zero-dependency server.",
      calls: [
        { tool: "write_file", input: { path: "app/server.js", content: server } },
        {
          tool: "write_file",
          input: { path: "app/public/index.html", content: page(options.prompt) },
        },
        { tool: "write_file", input: { path: "app/public/style.css", content: style } },
        { tool: "write_file", input: { path: "app/public/app.js", content: script } },
        {
          tool: "write_file",
          input: { path: "app/package.json", content: '{ "type": "module" }\n' },
        },
      ],
    },
    ...(options.restart
      ? [{ calls: [{ tool: "stop_process", input: { name: "dev" } }] } satisfies ScriptedStep]
      : []),
    {
      say: "Starting the server.",
      calls: [
        {
          tool: "start_process",
          input: { name: "dev", command: "node server.js", cwd: "app", port: 3000 },
        },
      ],
    },
    {
      calls: [
        { tool: "run", input: { command: "curl -s localhost:3000 | head -n 5", cwd: "app" } },
      ],
    },
  ];
}
