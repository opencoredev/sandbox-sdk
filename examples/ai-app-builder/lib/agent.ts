import { isStepCount, streamText, type ModelMessage } from "ai";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { sandboxTools } from "@opencoredev/sandbox-sdk/ai";
import type { ModelChoice } from "./model";
import { previewPort } from "./sandbox";
import { buildScript } from "./build-script";
import { scriptedModel } from "./scripted";

const instructions = `You build small web apps inside a Linux sandbox (Node 22, git, npm).
Put the app in /workspace/app. Prefer plain HTML, CSS and JavaScript served by a
zero-dependency Node server (server.js using node:http) unless the user asks for a framework.
The server must listen on 0.0.0.0 port ${previewPort}.
The preview is served under a sub-path, so reference assets with relative URLs ("style.css", not "/style.css").
Start the server with start_process (name "dev", cwd "app", port ${previewPort}). To apply changes to
server code, stop_process then start_process again; static files are picked up on reload.
Keep the design clean and responsive. Finish with one or two sentences on what you built.`;

async function isServing(box: Sandbox): Promise<boolean> {
  return (await box.processes()).some(
    (process) => process.name === "dev" && process.status === "running",
  );
}

/** The one agent code path. The chat route streams it to the browser; the dry run consumes it headless. */
export async function buildApp(options: {
  box: Sandbox;
  model: ModelChoice;
  messages: ModelMessage[];
  prompt: string;
  abortSignal?: AbortSignal;
}) {
  const model =
    options.model.kind === "scripted"
      ? scriptedModel(
          buildScript({ prompt: options.prompt, restart: await isServing(options.box) }),
          `Built a small app for "${options.prompt}". It's running on port ${previewPort}.`,
        )
      : options.model.model;
  return streamText({
    model,
    instructions,
    messages: options.messages,
    tools: sandboxTools(options.box, { root: "/workspace" }),
    stopWhen: isStepCount(30),
    abortSignal: options.abortSignal,
  });
}
