---
title: E2B SDK and API in TypeScript, with examples
description: How the e2b npm package and E2B's REST API fit together, the same file-and-Python task in each, and how to keep that code portable to Daytona or Docker.
published: 2026-11-03
---

E2B gives you two ways in. The [`e2b`](https://www.npmjs.com/package/e2b) npm package is the TypeScript SDK: it creates sandboxes, runs commands and reads and writes files. The [REST API](https://e2b.dev/docs/api-reference) at `https://api.e2b.app` manages sandboxes and templates: create, list, pause, set a timeout, delete. Commands and files don't go through the REST API at all. They go to envd, a daemon inside each sandbox, which the SDK talks to for you.

This guide shows the same task three ways: with the `e2b` package, with the REST API, and with [Sandbox SDK](/) (`@opencoredev/sandbox-sdk`), which runs the same code on E2B, Daytona, Vercel Sandbox, Docker and other providers. The task is the common one for AI agents: upload a Python file into a sandbox, run it, read the output, and clean up.

## The E2B SDK in TypeScript

Install the package and set `E2B_API_KEY` from your E2B dashboard on the server:

```bash
npm install e2b
```

`Sandbox.create()` starts a microVM from E2B's `base` template. `files` and `commands` work inside it:

```ts
import { Sandbox } from "e2b";

const sandbox = await Sandbox.create({ timeoutMs: 5 * 60_000 });

try {
  await sandbox.files.write("/home/user/main.py", 'print("hello from E2B")\n');
  const result = await sandbox.commands.run("python3 /home/user/main.py");
  console.log(result.stdout);
} finally {
  await sandbox.kill();
}
```

What to know about it, from the package's types (`e2b` 2.62.1, checked November 2026):

- `commands.run` resolves with `{ exitCode, stdout, stderr }` when the command succeeds and throws `CommandExitError` when it exits non-zero. Catch it if a failing command is a normal outcome for you, as it usually is for an agent.
- Pass `{ background: true }` to `commands.run` for a long-running process, and `sandbox.getHost(port)` gives the host name for a port inside the sandbox.
- `Sandbox.connect(sandboxId)` reattaches to a running sandbox from another process, and resumes a paused one. `sandbox.pause()` keeps memory and files.
- `sandbox.kill()` deletes the sandbox. If your code never reaches it, the sandbox runs until its `timeoutMs` passes.
- For notebook-style code execution with charts and rich results, E2B also ships [`@e2b/code-interpreter`](https://www.npmjs.com/package/@e2b/code-interpreter), whose `Sandbox` adds `runCode()`.

## The E2B REST API

The REST API is for managing sandboxes from anywhere that can send HTTP, including languages without an E2B SDK. Every request carries your key in the `X-API-Key` header:

```bash
curl https://api.e2b.app/v2/sandboxes \
  --header "X-API-Key: $E2B_API_KEY"
```

E2B's [API reference](https://e2b.dev/docs/api-reference) lists the endpoints. The sandbox ones cover create (`POST /v2/sandboxes` with a `templateID`), list, get, delete, pause, connect, set timeout, metrics, logs and snapshots. The template ones create, list, build and delete templates.

There is no REST endpoint that runs a command or writes a file. Those go to envd on port 49983 of each sandbox, over [Connect](https://connectrpc.com) RPC and a plain-HTTP `/files` route, with the per-sandbox access token that the create call returns. That's the part the SDK saves you from writing. If you call the REST API directly, plan to use an SDK for anything inside the sandbox.

## The same task with Sandbox SDK

Sandbox SDK's `e2b()` provider speaks both of E2B's interfaces itself, the REST API for the lifecycle and envd for commands and files, so you don't install the `e2b` package:

```bash
npm install @opencoredev/sandbox-sdk
```

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using box = await createSandbox(e2b(), { timeoutMs: 5 * 60_000 });

await box.files.write("main.py", 'print("hello from E2B")\n');
const result = await box.run("python3 main.py");
console.log(result.ok, result.stdout);
```

It reads the same `E2B_API_KEY`. Three things behave differently from the `e2b` package:

- **A failing command is a result, not an exception.** `box.run` resolves with `exitCode`, `ok`, `stdout`, `stderr` and `output` whatever the exit code, and throws only when the sandbox or the provider fails. [Running commands](/docs/concepts/running-commands) covers timeouts and streaming.
- **Cleanup is part of the syntax.** `await using` destroys the sandbox when the block ends, including when your code throws. [Lifecycle and cleanup](/docs/concepts/lifecycle-and-cleanup) covers `close`, `destroy` and the reaper for sandboxes your app forgot.
- **Relative paths resolve against `/workspace`**, the same on every provider, and on E2B commands run as root. The `e2b` package defaults to the `user` account and `/home/user`.

Pause, resume, snapshots, templates, a PTY terminal, file watching and metrics are all there for E2B. The [E2B provider page](/docs/providers/e2b) lists every option and limit.

### When you need something the wrapper doesn't cover

`box.native` reaches E2B directly with the provider's credentials. `request` calls any REST endpoint, with `{sandboxId}` filled in for you. `sdk` hands you the `e2b` package's own `Sandbox` for the same sandbox, if you install `e2b`:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using box = await createSandbox(e2b());

const info = await box.native.request<{ state: string; endAt: string }>(
  "GET",
  "/sandboxes/{sandboxId}",
);
console.log(info.state, info.endAt);

const sandbox = await box.native.sdk(() => import("e2b"));
console.log((await sandbox.commands.run("echo from the e2b package")).stdout);
```

## Switch the same code to Daytona or Docker

The reason to put a layer between your code and E2B is that the provider becomes one line. Moving the task above from E2B to Daytona changes the import and the factory, and nothing else:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { daytona } from "@opencoredev/sandbox-sdk/daytona";

await using box = await createSandbox(daytona(), { timeoutMs: 5 * 60_000 });

await box.files.write("main.py", 'print("hello from Daytona")\n');
const result = await box.run("python3 main.py");
console.log(result.ok, result.stdout);
```

`local()` runs it in a Docker container on your machine the same way. What doesn't carry over is anything a provider can't do. Daytona has no pause or resume, and its previews need a token header. E2B has no idle timeout or exact machine size. An option a provider can't enforce fails with an `unsupported` error instead of being ignored, so check the [capability matrix](/docs/reference/capabilities) before you rely on one, and [Choose a provider](/docs/getting-started/choose-a-provider) if you are still deciding. For speed and price comparisons between providers, see [AI Sandbox Bench](https://aisandboxbench.com).

## Test without E2B

Unit tests shouldn't create real sandboxes. `memory()` is a fake provider that runs in your test process, with commands answered by handlers you write, so the same `box.run` and `box.files` code runs with no key and no network:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

const provider = memory({
  handlers: {
    python3: async ({ stdout }) => {
      stdout("hello from E2B\n");
      return 0;
    },
  },
});

await using box = await createSandbox(provider);
await box.files.write("main.py", 'print("hello from E2B")\n');
console.log((await box.run("python3 main.py")).stdout); // hello from E2B
```

[Testing with memory()](/docs/guides/testing-with-memory) covers the handler API.

## Which one to use

- **The `e2b` package** if you only use E2B and want every feature it has, including Code Interpreter's `runCode` and E2B Desktop.
- **The REST API** to manage sandboxes from a language or tool with no E2B SDK. You still need an SDK for commands and files.
- **Sandbox SDK's `e2b()`** if you want E2B today and the option to move to Daytona, Vercel Sandbox or Docker later. The same package gives you `sandboxTools` for the AI SDK, Mastra and the OpenAI Agents SDK, and `memory()` for unit tests without an E2B account.

They mix, too: `box.native.sdk` gives you the `e2b` package's `Sandbox` whenever you need a feature the portable API doesn't have.

## Common questions

**Is there an official E2B SDK for TypeScript?** Yes, the `e2b` package on npm, from [e2b-dev/E2B](https://github.com/e2b-dev/E2B). Version 2.62.1 declares Node.js 22.19 or newer. Python has its own `e2b` package.

**Does E2B have a REST API?** Yes, at `https://api.e2b.app`, authenticated with `X-API-Key`. It manages sandboxes, snapshots and templates. Running commands and moving files happen inside the sandbox through envd, which the SDKs wrap.

**Where do I get an E2B API key?** From your E2B dashboard. Keep it on your server as `E2B_API_KEY` and out of browser bundles. Both the `e2b` package and Sandbox SDK's `e2b()` read that variable.

**Can I give an AI agent an E2B sandbox as tools?** With Sandbox SDK, `sandboxTools(box)` from `@opencoredev/sandbox-sdk/ai`, `/mastra` or `/openai` turns a sandbox into tools for that framework. [Give your agent a sandbox](/docs/guides/give-your-agent-a-sandbox) walks through it.

**Can I run E2B on my own servers?** Yes, with E2B Embed on one Linux machine with KVM. [E2B self-hosted](/blog/e2b-self-hosted) covers what it needs and how to point both SDKs at it.

## Next steps

- [Quickstart](/docs/getting-started/quickstart): your first sandbox in memory, then in Docker, then in the cloud.
- [E2B provider reference](/docs/providers/e2b): every option, capability and limit.
- [Daytona provider reference](/docs/providers/daytona): what changes when you switch.
- [Write a provider](/docs/providers/custom): wrap any other sandbox backend in the same API.
