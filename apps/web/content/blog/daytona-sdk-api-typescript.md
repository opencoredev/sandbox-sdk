---
title: Daytona SDK and API in TypeScript, with examples
description: How Daytona's TypeScript SDK, REST API and toolbox API fit together, one upload-and-run-Python task in TypeScript, and how to move it from E2B or to Docker.
published: 2026-11-12
---

Daytona gives you three ways in. The TypeScript SDK is [`@daytona/sdk`](https://www.npmjs.com/package/@daytona/sdk), the package that used to be called `@daytonaio/sdk`. The REST API at `https://app.daytona.io/api` manages sandboxes, snapshots, volumes and preview links. Commands and files go through a third API, the toolbox, which every sandbox serves behind Daytona's toolbox proxy. The SDK talks to the REST API and the toolbox for you.

This guide runs one task with `@daytona/sdk` and with [Sandbox SDK](/) (`@opencoredev/sandbox-sdk`), which runs the same code on Daytona, E2B, Vercel Sandbox, Docker and other providers. The task is the common one for AI agents: upload a Python file into a sandbox, run it, read the output, and clean up. It also covers where the REST API fits and what changes when you move code from E2B to Daytona.

## The Daytona SDK in TypeScript

Install the package and set `DAYTONA_API_KEY` from the Daytona Dashboard on your server:

```bash
npm install @daytona/sdk
```

`daytona.create()` starts a sandbox from Daytona's default snapshot. `fs` and `process` work inside it:

```ts
import { Daytona } from "@daytona/sdk";

const daytona = new Daytona();
const sandbox = await daytona.create();

try {
  await sandbox.fs.uploadFile(Buffer.from('print("hello from Daytona")\n'), "/tmp/main.py");
  const result = await sandbox.process.executeCommand("python3 /tmp/main.py");
  console.log(result.exitCode, result.result);
} finally {
  await sandbox.delete();
}
```

What to know about it, from the package's types (`@daytona/sdk` 0.231.1, checked November 2026):

- `new Daytona()` reads `DAYTONA_API_KEY`, `DAYTONA_API_URL` and `DAYTONA_TARGET` from the environment. A JWT needs `DAYTONA_JWT_TOKEN` and `DAYTONA_ORGANIZATION_ID` instead of the key.
- `process.executeCommand(command, cwd?, env?, timeout?)` resolves with `exitCode` and `result`, the command's output. Its `timeout` is in seconds, and the call returns only when the command finishes.
- For a server or another long-running process, start a session with `process.createSession` and run the command in it with `runAsync: true`, or redirect its output and background it with `&`.
- `sandbox.getPreviewLink(port)` returns a `url` and a `token`. Private sandboxes need that token in an `X-Daytona-Preview-Token` header, which a browser iframe can't send; `sandbox.setPublic(true)` drops the requirement.
- `sandbox.delete()` deletes the sandbox. If your code never reaches it, the sandbox stops after its auto-stop interval, 15 idle minutes by default (sandbox classes that can pause auto-pause after 60 instead), and a stopped sandbox keeps its disk until Daytona archives it.
- The `Sandbox` object also has `git`, `codeRun` for Python, TypeScript and JavaScript snippets, LSP servers, snapshots, `fork` and, in recent versions, `pause()`.

The old `@daytonaio/sdk` name still gets releases, with a README that points to `@daytona/sdk`. Daytona says only the name changed, so switching is the install and the import.

## The Daytona REST API

The REST API is for managing sandboxes from anywhere that can send HTTP. Every request carries your key as a bearer token:

```bash
curl https://app.daytona.io/api/sandbox \
  --header "Authorization: Bearer $DAYTONA_API_KEY"
```

With a JWT, send it the same way plus an `X-Daytona-Organization-ID` header. The sandbox endpoints include create (`POST /sandbox`), list (`GET /sandbox`), get and delete (`/sandbox/{sandboxId}`), `start` and `stop`, a snapshot of a running sandbox, and `GET /sandbox/{sandboxId}/ports/{port}/preview-url` for preview links. Daytona's [API reference](https://www.daytona.io/docs/en/tools/api/) lists the rest, including snapshots and volumes.

Running a command or writing a file is not a REST endpoint. Those go to the sandbox's toolbox: ask for its proxy URL with `GET /sandbox/{sandboxId}/toolbox-proxy-url`, then call paths such as `/process/execute` and `/files/bulk-upload` under `<proxy URL>/<sandboxId>` with the same bearer token. That's the part the SDK saves you from writing.

## The same task with Sandbox SDK

Sandbox SDK's `daytona()` provider calls the REST API and the toolbox directly, so you don't install `@daytona/sdk`:

```bash
npm install @opencoredev/sandbox-sdk
```

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { daytona } from "@opencoredev/sandbox-sdk/daytona";

await using box = await createSandbox(daytona(), { timeoutMs: 5 * 60_000 });

await box.files.write("main.py", 'print("hello from Daytona")\n');
const result = await box.run("python3 main.py");
console.log(result.ok, result.stdout);
```

It reads the same `DAYTONA_API_KEY`. What's different from `@daytona/sdk`:

- **Output comes back split.** `box.run` resolves with `exitCode`, `ok`, `stdout`, `stderr` and `output`, and you can iterate it to stream output while the command runs. It throws only when the sandbox or the provider fails, never for a non-zero exit. [Running commands](/docs/concepts/running-commands) covers timeouts and streaming.
- **Long-running processes have their own call.** `box.start("npm run dev", { name: "web", ready: { port: 3000 } })` starts a process in the background and waits for its port, and `box.preview(3000)` returns the URL with the token header already filled in.
- **Cleanup is part of the syntax.** `await using` deletes the sandbox when the block ends, including when your code throws. [Lifecycle and cleanup](/docs/concepts/lifecycle-and-cleanup) covers `close`, `destroy` and the reaper.
- **Limits are options.** `timeoutMs` and `idleTimeoutMs` set a hard lifetime and an idle stop, both in whole minutes on Daytona. `size` takes presets or exact CPU, memory and disk, and `network` takes a host allow list.
- **Relative paths resolve against `/workspace`**, the same on every provider.

The [Daytona provider page](/docs/providers/daytona) lists every option, the snapshot and volume support, and the limits.

### When you need something the wrapper doesn't cover

`box.native` reaches Daytona directly with the provider's credentials. `request` calls any REST endpoint, with `{sandboxId}` filled in for you, and `{ plane: "toolbox" }` sends the call to the sandbox's toolbox instead. `sdk` hands you the official SDK's `Sandbox` for the same sandbox, if you install `@daytona/sdk`:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { daytona } from "@opencoredev/sandbox-sdk/daytona";

await using box = await createSandbox(daytona());

const info = await box.native.request<{ state: string; cpu: number; memory: number }>(
  "GET",
  "/sandbox/{sandboxId}",
);
console.log(info.state, info.cpu, info.memory);

const sandbox = await box.native.sdk(() => import("@daytona/sdk"));
const status = await sandbox.git.status("/workspace");
console.log(status.currentBranch);
```

## Move the same code from E2B to Daytona

If your code is on E2B today and written against Sandbox SDK, switching to Daytona changes the import and the factory, and nothing else:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using box = await createSandbox(e2b(), { timeoutMs: 5 * 60_000 });

await box.files.write("main.py", 'print("hello from E2B")\n');
const result = await box.run("python3 main.py");
console.log(result.ok, result.stdout);
```

Swap `e2b` for `daytona` in both places and the task above runs on Daytona. `local()` runs it in a Docker container on your own machine the same way. If your code calls the `e2b` package directly, the [E2B SDK and API guide](/blog/e2b-sdk-api-typescript) shows the same task in both shapes, which is the rewrite you'd do once.

What doesn't carry over is anything a provider can't do through this API. Sandbox SDK's `daytona()` has no pause or resume and no terminal, keys are found by label search instead of exactly, and previews need the token header unless you create the sandbox with `daytona({ public: true })`. E2B has no idle timeout or exact machine size. An option a provider can't enforce fails with an `unsupported` error instead of being ignored, so check the [capability matrix](/docs/reference/capabilities) before you rely on one. For speed and price comparisons between Daytona and E2B, see [AI Sandbox Bench](https://aisandboxbench.com).

## Test without Daytona

Unit tests shouldn't create real sandboxes. `memory()` is a fake provider that runs in your test process: commands are answered by handlers you write, so the code above runs with no key and no network.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

const provider = memory({
  handlers: {
    python3: async ({ stdout }) => {
      stdout("hello from Daytona\n");
      return 0;
    },
  },
});

await using box = await createSandbox(provider);
await box.files.write("main.py", 'print("hello from Daytona")\n');
const result = await box.run("python3 main.py");
console.log(result.ok, result.stdout); // true hello from Daytona
```

[Testing with memory()](/docs/guides/testing-with-memory) covers the handler API.

## Which one to use

- **`@daytona/sdk`** if you only use Daytona and want everything it has, including `codeRun`, LSP servers, computer use, forks and pause.
- **The REST API** to manage sandboxes from a language or tool without a Daytona SDK. Commands and files still go through the toolbox.
- **Sandbox SDK's `daytona()`** if you want Daytona today and the option to move to E2B, Vercel Sandbox or Docker later, or to run the same code on several. The same package gives you `sandboxTools` for the AI SDK, Mastra and the OpenAI Agents SDK, and `memory()` for tests without a Daytona account.

They mix: `box.native.sdk` gives you the official SDK's `Sandbox` whenever you need a feature the portable API doesn't have.

## Common questions

**What is the Daytona SDK for TypeScript called?** `@daytona/sdk` on npm, from the [daytona/clients](https://github.com/daytona/clients) repository, under the Apache 2.0 license. It was published as `@daytonaio/sdk` before, and that name still gets releases.

**Does Daytona have a REST API?** Yes, at `https://app.daytona.io/api`, authenticated with `Authorization: Bearer <key>`. It manages sandboxes, snapshots, volumes and preview links. Commands and files go through each sandbox's toolbox API, which the SDKs wrap.

**Where do I get a Daytona API key?** From the Daytona Dashboard. Keep it on your server as `DAYTONA_API_KEY` and out of browser bundles. Both `@daytona/sdk` and Sandbox SDK's `daytona()` read it. Your organization also needs a default region, which you set in the Dashboard.

**Can I give an AI agent a Daytona sandbox as tools?** With Sandbox SDK, `sandboxTools(box)` from `@opencoredev/sandbox-sdk/ai`, `/mastra` or `/openai` turns a Daytona sandbox into tools for that framework. [Give your agent a sandbox](/docs/guides/give-your-agent-a-sandbox) walks through it.

**Can I switch from E2B to Daytona without rewriting my code?** Yes, if the code uses Sandbox SDK: change `createSandbox(e2b())` to `createSandbox(daytona())`. Code that calls the `e2b` package directly needs one move to the portable API first, and features Daytona's adapter lacks, such as pause, fail with `unsupported`.

## Next steps

- [Quickstart](/docs/getting-started/quickstart): your first sandbox in memory, then in Docker, then in the cloud.
- [Daytona provider reference](/docs/providers/daytona): every option, capability and limit.
- [E2B SDK and API in TypeScript](/blog/e2b-sdk-api-typescript): the same task on E2B, and how E2B's REST API differs.
- [Processes and previews](/docs/concepts/processes-and-previews): dev servers and preview URLs on every provider.
