---
title: OpenAI Agents SDK sandbox in TypeScript
description: Two ways to give an OpenAI Agents SDK agent a sandbox in TypeScript, SandboxAgent with a sandbox client or sandbox tools on a regular Agent, and which to use.
published: 2026-11-19
updated: 2026-11-26
---

The OpenAI Agents SDK for TypeScript gives an agent a sandbox in two ways. The first is the SDK's own `SandboxAgent`, which runs its shell and file tools through a sandbox client: local processes, Docker, or a hosted provider such as E2B, Daytona, Modal or Vercel Sandbox. The second is a regular `Agent` with function tools that act on a sandbox you created yourself, such as `sandboxTools(box)` from [Sandbox SDK](/) (`@opencoredev/sandbox-sdk`).

Both run the model's commands in a sandbox instead of on your server. They differ in which providers you can use, who owns the sandbox's lifecycle, and how you test. This post shows each one with code, then says when to pick which.

## SandboxAgent and sandbox clients

`SandboxAgent` comes from `@openai/agents/sandbox`. You define the agent once and choose where it runs when you call `run`, through the `sandbox.client` option. This one runs in a Docker container on your machine:

```ts
import { run } from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import { DockerSandboxClient } from "@openai/agents/sandbox/local";

const agent = new SandboxAgent({
  name: "Coder",
  instructions: "Inspect the workspace before answering.",
});

const result = await run(agent, "List the files in the workspace.", {
  sandbox: { client: new DockerSandboxClient({ image: "node:22-bookworm-slim" }) },
});
console.log(result.finalOutput);
```

What to know about it, from the `@openai/agents` 0.20 types and OpenAI's [sandbox clients guide](https://openai.github.io/openai-agents-js/guides/sandbox-agents/clients) (checked November 2026):

- **Capabilities decide the tools.** A `SandboxAgent` gets `filesystem()`, `shell()` and `compaction()` by default. Its `capabilities` option also takes `skills()` and an agent-memory capability, also called `memory()` but unrelated to Sandbox SDK's `memory()` provider below.
- **A manifest describes the workspace.** `Manifest` entries such as `file`, `dir`, `localDir` and `gitRepo` are prepared before the agent runs, and mount entries attach S3, GCS, R2 or Azure Blob storage where the client supports it.
- **Two local clients.** `UnixLocalSandboxClient` runs commands as host processes and, in OpenAI's words, adds no OS-level filesystem or network isolation. `DockerSandboxClient` runs them in a container, and `networkMode: "none"` turns its network off. For untrusted commands, OpenAI's guide points you at Docker or a hosted client.
- **Hosted clients live in a second package.** `@openai/agents-extensions` 0.22 has clients for Blaxel, Cloudflare, Daytona, E2B, Modal and Vercel Sandbox (0.20 also had Runloop; 0.21 removed it), each under its own subpath (for example `E2BSandboxClient` from `@openai/agents-extensions/sandbox/e2b`), and each needs that provider's own npm package, except Cloudflare, which talks to a bridge Worker you deploy.
- **The runner can own the sandbox.** Pass `{ client }` and the runner creates the sandbox and closes it when the run ends. Pass `{ session }` from `client.create()` and you close it yourself, which lets several runs share one workspace. Sessions can be serialized, resumed and snapshotted.

## Sandbox tools on a regular Agent

The other route skips `SandboxAgent`. You create the sandbox with Sandbox SDK and hand its tools to a plain `Agent`:

```bash
npm install @opencoredev/sandbox-sdk @openai/agents zod
```

```ts
import { Agent, run } from "@openai/agents";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";
import { sandboxTools } from "@opencoredev/sandbox-sdk/openai";

await using box = await createSandbox(e2b());

const coder = new Agent({
  name: "Coder",
  instructions: "You work inside a Linux sandbox. Verify every change by running it.",
  tools: sandboxTools(box),
});

const result = await run(coder, "List the files in /workspace.");
console.log(result.finalOutput);
```

`sandboxTools` is not a `SandboxAgent` client. It returns ordinary function tools, so the agent is a regular `Agent` and your code owns the sandbox:

- **Seven tools by default:** `run`, `read_file`, `write_file`, `edit_file`, `start_process`, `process_logs` and `stop_process`. `search`, `list_files`, `changes` and `preview` are opt-in through `allow`, and `deny` removes tools. Each is a strict function tool with a Zod schema, and aborting the run aborts the command in the sandbox.
- **`await using` cleans up.** The sandbox is destroyed when the block ends, including when the run throws. Give `createSandbox` a `key` instead and later runs find the same sandbox again, which is how you keep [one sandbox per user](/docs/guides/per-user-sandboxes).
- **It needs `@openai/agents` 0.20.** That's the peer range of `@opencoredev/sandbox-sdk` 1.1.0, and the install command above resolves to it.

The [OpenAI Agents integration page](/docs/integrations/openai-agents) has the reference for options and output, and [Give your agent a sandbox](/docs/guides/give-your-agent-a-sandbox) covers limiting the tools.

## Run the same agent on another provider

With Sandbox SDK, the provider is the factory you pass to `createSandbox`. The agent and its tools don't change:

```ts
import { Agent, run } from "@openai/agents";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";
import { freestyle } from "@opencoredev/sandbox-sdk/freestyle";
import { local } from "@opencoredev/sandbox-sdk/local";
import { sandboxTools } from "@opencoredev/sandbox-sdk/openai";

const providers = { docker: local, e2b, freestyle };
const choice = (process.env.SANDBOX ?? "docker") as keyof typeof providers;

await using box = await createSandbox(providers[choice]());

const coder = new Agent({
  name: "Coder",
  instructions: "Your project is in /workspace. Run the tests before you answer.",
  tools: sandboxTools(box),
});

const result = await run(coder, "Run the tests and summarize any failures.");
console.log(result.finalOutput);
```

`local()` is Docker on your machine. Beyond E2B, Daytona, Modal and Vercel Sandbox, which both routes reach, Sandbox SDK also runs on Upstash Box, Railway, Baseten, Boat, Sandboxer, Luxor, Superserve, boxd, Freestyle, Instabox, Archil, Maritime, Microsandbox, Styne and agentOS. OpenAI's clients reach Blaxel and Cloudflare, which Sandbox SDK doesn't.

Providers don't all do the same things. On Vercel Sandbox and Local, a dev server's port must be listed in `ports` when you create the sandbox, and agentOS has no background processes or previews, so `start_process` fails there. An option a provider can't enforce fails with an `unsupported` error instead of being ignored. The [capability matrix](/docs/reference/capabilities) lists the differences.

## Test the tools without a model or a cloud

`memory()` is a fake provider that runs in your test process. The tools from `sandboxTools` are normal OpenAI function tools, so a test can call one directly with `invoke`, with no OpenAI key and no sandbox account:

```ts
import { RunContext } from "@openai/agents";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { sandboxTools } from "@opencoredev/sandbox-sdk/openai";

const provider = memory({
  handlers: {
    npm: async ({ args, stdout }) => {
      stdout(`npm ${args.join(" ")}: 3 passing\n`);
      return 0;
    },
  },
});

await using box = await createSandbox(provider);
const runTool = sandboxTools(box).find((tool) => tool.name === "run");
if (!runTool) throw new Error("run tool missing");

const output = await runTool.invoke(new RunContext(), JSON.stringify({ command: "npm test" }));
console.log(output);
```

It prints what the model would see:

```text
OK exit=0 0.0s cwd=/workspace
output:
npm test: 3 passing
```

[Testing with memory()](/docs/guides/testing-with-memory) covers the handler API. Code that uses `SandboxAgent` tests against `UnixLocalSandboxClient` or `DockerSandboxClient` instead, which run real commands on your machine.

## Which one to use

- **`SandboxAgent`** if your provider has an OpenAI client and you want what the harness adds: manifests that check out a repository or mount a bucket, serialized sessions and snapshots, skills and agent memory, and compaction for long runs.
- **`sandboxTools` on a regular `Agent`** if your provider isn't on OpenAI's list, if you want a sandbox per user found by `key`, or if you want unit tests that never start a machine. The same tools exist for the AI SDK (`/ai`) and Mastra (`/mastra`), so the sandbox code stays the same if you change frameworks.

Both keep provider keys on your server. Neither makes a sandbox safer than the provider behind it: the isolation comes from Docker, the microVM or the hosted service.

## Common questions

**Does the OpenAI Agents SDK have a sandbox?** Yes. `@openai/agents` exports `SandboxAgent` from `@openai/agents/sandbox` and two local clients from `@openai/agents/sandbox/local`. Hosted clients are in `@openai/agents-extensions`.

**Which sandbox providers does the OpenAI Agents SDK support in TypeScript?** In `@openai/agents-extensions` 0.22: Blaxel, Cloudflare, Daytona, E2B, Modal and Vercel Sandbox (Runloop was removed in 0.21), plus the Unix-local and Docker clients in `@openai/agents` itself.

**Can I use E2B with the OpenAI Agents SDK?** Two ways: `E2BSandboxClient` from `@openai/agents-extensions/sandbox/e2b` with a `SandboxAgent`, or `createSandbox(e2b())` with `sandboxTools(box)` on a regular `Agent`. The [E2B SDK and API guide](/blog/e2b-sdk-api-typescript) shows E2B's own package.

**Is `UnixLocalSandboxClient` safe for untrusted code?** No. OpenAI's guide says it runs host processes and adds no OS-level filesystem or network isolation. Use Docker or a hosted sandbox for commands a model or a user wrote.

**Can a `SandboxAgent` use a Sandbox SDK sandbox?** Not as its client. `sandboxTools` returns function tools for a regular `Agent`, and switching providers there means changing the factory passed to `createSandbox`.

## Next steps

- [OpenAI Agents integration](/docs/integrations/openai-agents): options, output and keeping a sandbox across runs.
- [Give your agent a sandbox](/docs/guides/give-your-agent-a-sandbox): the tools, how to limit them, and per-provider caveats.
- [Docker sandbox for AI agents in TypeScript](/blog/docker-sandbox-for-ai-agents): run the agent's commands in a container on your machine first.
- [Capability matrix](/docs/reference/capabilities): what each provider supports.
