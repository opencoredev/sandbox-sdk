---
title: Docker sandbox for AI agents in TypeScript
description: Run your agent's shell commands and file edits in a Docker container from TypeScript, lock the container down, then move the same code to a cloud sandbox by changing one import.
published: 2026-11-01
---

If you are building an agent that runs shell commands, those commands need somewhere to run that isn't your laptop or your server. A Docker container is the closest isolated machine you already have. This guide shows how to start one from TypeScript, hand it to an agent as tools, tighten what the container can do, and later move the same code to a cloud sandbox.

The short version:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";

await using box = await createSandbox(local());
const result = await box.run("uname -a && whoami && pwd");
console.log(result.stdout);
```

`local()` creates a container through the Docker Engine API, `box.run` executes a command inside it, and `await using` removes the container when the block ends.

## Docker Sandboxes or a container from your own code?

Search for "docker sandbox" and most results are about [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/), Docker's product for running coding agents such as Claude Code in isolated environments, managed with the `sbx` CLI. If you want to run an existing coding agent on your machine without letting it touch the rest of your files, that is the tool to read about.

This guide covers a different job: you are writing the agent, or an app that runs code for users, and your TypeScript code needs to create a sandbox, run commands in it, read the results and throw it away. For that you call the Docker Engine from your own code. Sandbox SDK's `local()` provider does this over the Docker socket. It needs no Docker CLI and installs nothing in the container.

## What you need

- Node 22 or later, or Bun 1.3 or later. The SDK is server-side only.
- A running Docker Engine. Docker Desktop, OrbStack and Colima all work. `DOCKER_HOST` is optional, but it has to be a local `unix://` socket; remote `tcp://` engines are rejected.

```bash
npm install @opencoredev/sandbox-sdk
```

The first `createSandbox(local())` pulls `node:22-bookworm`, which already has Node, Python 3 and git. Pass `local({ image: "..." })` to use another image; it needs `node`, `git`, `tar`, `setsid`, `nohup`, `mkfifo` and GNU `sed`.

## Run commands and write files

Relative paths resolve against `/workspace` inside the container.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";

await using box = await createSandbox(local());

await box.files.write("hello.py", 'print("hello from the container")\n');
const result = await box.run("python3 hello.py");

console.log(result.ok, result.exitCode, result.stdout);
// true 0 hello from the container
```

A command that exits non-zero comes back as `ok: false` with its `exitCode`. It doesn't throw, which matters for agents: a failing test is information for the model, not an exception for your code. To stream output while a command runs, iterate the result instead of awaiting it:

```ts
for await (const chunk of box.run("npm install")) {
  process.stdout.write(chunk.text);
}
```

## Give the agent the container as tools

`sandboxTools(box)` turns the sandbox into ready-made tools for your agent framework. The AI SDK version comes from `@opencoredev/sandbox-sdk/ai`. Mastra and the OpenAI Agents SDK have their own subpaths (`/mastra` and `/openai`) with the same tools.

```bash
npm install @opencoredev/sandbox-sdk ai zod
```

```ts
import { generateText, stepCountIs } from "ai";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";
import { sandboxTools } from "@opencoredev/sandbox-sdk/ai";

await using box = await createSandbox(local());
await box.git.clone("https://github.com/acme/web.git", { dir: "app", depth: 1 });

const { text } = await generateText({
  model: "anthropic/claude-opus-5-5",
  tools: sandboxTools(box, { root: "/workspace/app" }),
  stopWhen: stepCountIs(30),
  prompt: "Run the tests in /workspace/app and fix the first failure.",
});

console.log(text);
```

The model gets seven tools by default: `run`, `read_file`, `write_file`, `edit_file`, `start_process`, `process_logs` and `stop_process`. It runs the tests with `run`, reads the failure with `read_file`, and changes the code with `edit_file`, all inside the container. `stopWhen` caps the number of steps so a confused model can't loop forever.

`root` keeps the file paths the model passes inside one directory. It is a convenience, not a security boundary: a shell command can still `cd` out. The container is the boundary, so the next step is to make it a tighter one.

## Lock the container down

A default container has outbound network access, no CPU or memory limit, and root inside the container. For agent code you usually want less.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";

const provider = local({
  pidsLimit: 256,
  capDrop: ["ALL"],
  securityOpt: ["no-new-privileges"],
});

await using box = await createSandbox(provider, {
  size: "small",
  network: "none",
  timeoutMs: 30 * 60_000,
});
```

What each option does:

- `network: "none"` cuts the container off from the network. A `fetch` from inside it fails. It also turns off preview URLs, so leave it out if the agent needs to run a dev server you open in a browser.
- `size: "small"` caps the container at 1 CPU and 1024 MiB of memory. `medium` is 2 CPUs and 4096 MiB, `large` is 4 and 8192, or pass `{ cpu, memoryMb }`. Without `size`, Docker sets no limit.
- `pidsLimit` stops a fork bomb from taking the host down with it.
- `capDrop` and `securityOpt` pass straight through to Docker. Dropping all capabilities and setting `no-new-privileges` removes most of what root can do inside the container.
- `timeoutMs` and `idleTimeoutMs` set a lifetime. Docker has no timer of its own, so they are enforced when a client reconnects or when `reapSandboxes` runs. Schedule a reaper if nothing reconnects.

`local()` can't do everything a cloud sandbox can. It has no host allow lists (only `"none"`), no disk size, and no terminals. Asking for one of those fails with an `unsupported` error instead of quietly creating a looser sandbox. The [Local provider page](/docs/providers/local) lists every option and limit.

### How isolated is a container?

A container shares the host's kernel. That is fine for running your own agent against your own repositories during development and in CI. It is not the boundary you want for code from strangers on a machine that holds secrets. You have two ways to raise it:

- Set an OCI runtime such as gVisor: `local({ runtime: "runsc" })`, if your Docker daemon has it registered.
- Run the same code on a cloud provider that gives each sandbox its own microVM, such as E2B or Vercel Sandbox.

The [security reference](/docs/reference/security) covers trust boundaries, secrets redaction and network policy in more detail.

## Move the same code to the cloud

Every provider takes the same calls. To run the agent above on E2B instead of Docker, change the import and the factory:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using box = await createSandbox(e2b()); // reads E2B_API_KEY
```

`box.run`, `box.files`, `box.git` and `sandboxTools(box)` stay as they are. The same goes for `vercel()`, `daytona()`, `upstash()` and the other providers. Some need their own SDK installed next to this one, such as `@vercel/sandbox` for Vercel. [Choose a provider](/docs/getting-started/choose-a-provider) helps you pick.

Options differ by provider. Allow lists, disk size, pause and snapshots aren't available everywhere, and a provider that can't enforce an option fails with `unsupported` rather than ignoring it. Check the [capability matrix](/docs/reference/capabilities) before you rely on one. For speed and price numbers across providers, see [AI Sandbox Bench](https://aisandboxbench.com).

A common setup is Docker on your machine and a cloud provider in production, chosen by environment:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

const provider = process.env.NODE_ENV === "production" ? e2b() : local();
await using box = await createSandbox(provider);
```

## Test without Docker

Unit tests shouldn't start containers. `memory()` is a provider that runs inside your test process: files live in a map, and commands are answered by handlers you write.

```ts
import { createSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

async function runTests(box: Sandbox) {
  const result = await box.run("npm test");
  return result.ok;
}

const provider = memory({
  handlers: {
    npm: async ({ stdout }) => {
      stdout("1 passing\n");
      return 0;
    },
  },
});

await using box = await createSandbox(provider);
console.log(await runTests(box)); // true
```

Code that takes a `Sandbox` runs the same against `memory()`, `local()` and every cloud provider. [Testing with memory()](/docs/guides/testing-with-memory) shows the full handler API.

## Clean up

`await using` destroys the container when the scope exits, including when your code throws. If you need a sandbox to outlive one request, give it a `key` and find it again later, or call `box.close()` to disconnect and leave it running. Containers the SDK creates carry the label `sandbox-sdk=1`, so a scheduled `reapSandboxes` call can remove forgotten ones. [Lifecycle and cleanup](/docs/concepts/lifecycle-and-cleanup) has the details.

## Common questions

**Do I need the Docker CLI?** No. `local()` talks to the Docker Engine API over its Unix socket.

**Does it work in CI?** Yes, on any runner with a Docker Engine. Use `memory()` for unit tests and `local()` for the integration tests that need a real shell.

**Can the agent run a dev server and open it?** Yes. Declare the port with `createSandbox(local(), { ports: [3000] })`, start the server with `box.start`, and `box.preview(3000)` returns a `http://127.0.0.1` URL on the Docker host. It is reachable only from that machine. [Dev servers and previews](/docs/guides/dev-servers-and-previews) shows the full flow.

**Is there a way to run commands locally without Docker?** [agentOS](/docs/providers/agentos) runs command and file tasks on your machine without Docker.

## Next steps

- [Quickstart](/docs/getting-started/quickstart): run your first sandbox in memory, then in Docker, then in the cloud.
- [Give your agent a sandbox](/docs/guides/give-your-agent-a-sandbox): every tool, what the model gets back, and how to limit it.
- [Local provider reference](/docs/providers/local): every `local()` option.
