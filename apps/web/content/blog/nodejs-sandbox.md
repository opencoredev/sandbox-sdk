---
title: Node.js sandbox: vm, isolated-vm, Docker or a microVM
description: Which Node.js sandbox holds up against untrusted code. node:vm, vm2, isolated-vm, QuickJS, the permission model, Docker and microVMs, with tested code.
published: 2026-11-24
---

A Node.js sandbox that holds up against untrusted code runs that code outside your process. `node:vm` and the permission model are not security boundaries, isolated-vm and QuickJS contain only JavaScript, and containers or microVMs contain whole programs.

The `node:vm`, isolated-vm, QuickJS, permission-model and `memory()` samples below ran on Node 24.22 in November 2026, and the output shown is what they printed. The Vercel Sandbox sample uses [Sandbox SDK by OpenCore](/) (`@opencoredev/sandbox-sdk`) to run code a model wrote in a microVM; it was typechecked against version 1.3.1, not run against a live account.

## The options at a glance

| Option                        | Where the code runs                          | What it can reach                             | Fit for untrusted code              |
| ----------------------------- | -------------------------------------------- | --------------------------------------------- | ----------------------------------- |
| `node:vm`                     | Your process, a new V8 context               | Your whole process, through one escape        | No                                  |
| vm2                           | Your process, wrapped `node:vm`              | Your process, whenever the wrapper has a gap  | Not for arbitrary submissions       |
| isolated-vm                   | A separate V8 isolate in a Node process      | Only values you pass in                       | JavaScript only, in its own process |
| QuickJS in WebAssembly        | A Wasm interpreter in a Node process         | Only values you pass in                       | JavaScript only, unaudited          |
| Permission model              | The Node process started with `--permission` | Selected APIs, as the `--allow-*` flags grant | No                                  |
| Docker container              | A separate process on the same kernel        | Its own files and network, your kernel        | Partly: the kernel is shared        |
| MicroVM (E2B, Vercel Sandbox) | Another machine with its own kernel          | Its own disk, and the network you allow       | Yes, any language or program        |

The first four run JavaScript only, inside a Node process. The last two run real programs, so the code can start a server, or install packages and run Python when the image has them and the network allows it.

## Is node:vm a sandbox?

No. Node's own [vm docs](https://nodejs.org/api/vm.html) say: "The node:vm module is not a security mechanism. Do not use it to run untrusted code."

One line of code shows why:

```js
import vm from "node:vm";

// Pretend a user wrote this string. The context gets no `process`.
const untrusted = `this.constructor.constructor("return process")().version`;

console.log(vm.runInNewContext(untrusted, {}));
```

```text
v24.22.1
```

The object you pass as the context was created in your realm. Its `constructor` is your `Object`, and that one's `constructor` is your `Function`, which compiles code with full access to `process`. From there the code can read your environment variables or spawn a shell. `node:vm` is for running code you trust in a separate global scope, such as a template engine or a REPL.

## Is vm2 safe to use?

Not for arbitrary user submissions. vm2 is maintained again (3.12.2 shipped in September 2026), and its [README](https://github.com/patriksimek/vm2#important-security-disclaimer) is direct about the limits: it sandboxes code inside your Node.js process through a network of proxies, new bypasses "will likely be discovered", and for "completely untrusted sources (e.g., arbitrary user submissions)" it recommends stronger isolation. The README called the project discontinued in 2023; releases resumed in October 2025 and that notice is gone.

Escapes keep being found. In January 2026 [Semgrep](https://semgrep.dev/blog/2026/calling-back-to-vm2-and-escaping-sandbox/) described one scored 9.8 on CVSS, fixed in 3.10.2. Every gap in the wrapper reaches your process, so vm2 fits code from vetted authors, kept up to date and paired with other layers.

## isolated-vm: a separate V8 isolate

[isolated-vm](https://github.com/laverdet/isolated-vm) runs JavaScript in its own V8 isolate, with its own heap and no Node APIs, and lets you cap memory and time:

```js
import ivm from "isolated-vm";

const isolate = new ivm.Isolate({ memoryLimit: 32 }); // MB
const context = await isolate.createContext();

console.log(await context.eval(`typeof process + " " + (6 * 7)`, { timeout: 100 }));

try {
  await context.eval(`while (true) {}`, { timeout: 100 });
} catch (error) {
  console.log(error.message);
}

isolate.dispose();
```

```text
undefined 42
Script execution timed out.
```

The isolate has no `process`, `require` or file system unless you hand it one. What to know before you rely on it, from its README (checked November 2026):

- **It's in maintenance mode.** The author supports it "for as long as is technically feasible" and is working on a new version in a separate branch.
- **Don't leak its objects.** Handing untrusted code a `Reference` or an `ExternalCopy` is "usually trivial" to turn into "complete control over a process", in the README's words.
- **Keep Node patched.** A V8 bug is an escape into your process, so V8 updates in Node point releases matter.
- **Run it in its own process.** The README suggests keeping isolates in a different Node process from other critical infrastructure, since plain JavaScript can still crash or hang a process.
- **`memoryLimit` is a guideline.** The README says a determined attacker can use 2 to 3 times the limit before the script is stopped.
- **It's a native addon matched to Node.** 7.x is for Node 26, 6.x or 5.x for Node 24, 5.x or 4.x for Node 22, and odd-numbered Node versions aren't supported.

It runs JavaScript only. Code that needs npm packages, a shell or another language doesn't fit.

## QuickJS in WebAssembly

[quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) runs the QuickJS engine compiled to WebAssembly. The code gets its own interpreter and only the values you expose:

```js
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

const QuickJS = await getQuickJS();

const result = QuickJS.evalCode(`typeof process + " " + (6 * 7)`, {
  shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 100),
  memoryLimitBytes: 16 * 1024 * 1024,
});
console.log(result);

try {
  QuickJS.evalCode(`while (true) {}`, {
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 100),
  });
} catch (error) {
  console.log(error.message);
}
```

```text
undefined 42
interrupted
```

It's a different engine from V8, and it needs no native build. Its README says the project "has not been audited" and asks for care in production. It suits formulas, rules and small plugins written in plain JavaScript, run in a process that holds nothing critical. Code that expects Node APIs or npm packages won't run in it.

## Does the Node.js permission model sandbox code?

No. The [permission model](https://nodejs.org/api/permissions.html), stable since Node 22.13 and 23.5, "does not protect against malicious code", and Node's docs say malicious code can bypass it. It's a seat belt that stops your own scripts from touching files or APIs by mistake.

It applies to the Node process you start with `--permission`, so your app has to launch the script as its own process. In that process, the restricted APIs work only where you allow them. This one tries to spawn a process:

```js
// job/main.mjs
import { execSync } from "node:child_process";
console.log(execSync("id -un").toString());
```

```bash
node --permission --allow-fs-read=./job job/main.mjs
```

```text
Error: Access to this API has been restricted. Use --allow-child-process to manage permissions.
```

The error's code is `ERR_ACCESS_DENIED`. Use the permission model to fence in code you wrote, and something below for code you didn't.

## Containers: a separate process, the same kernel

A Docker container gives the code its own file system, process tree and network namespace, and it can run any program. It shares your machine's kernel, so a kernel bug or a mount that exposes the host is a way out. [Docker sandbox for AI agents in TypeScript](/blog/docker-sandbox-for-ai-agents) shows how to start and lock down a container from TypeScript with `local()`.

Whether a container is enough depends on what the code is and what it can reach. An agent you wrote can still run instructions it read from untrusted input, and a machine with no secrets can still expose mounts or network services. A container fits code from your own team on a host you've locked down; for code from strangers, use a microVM.

## MicroVM sandboxes: another kernel, any language

To run untrusted programs safely, run them on another machine. E2B and Vercel Sandbox start each sandbox as a microVM with its own kernel and disk, and the code inside can run `node`, install npm packages or start a dev server without reaching your server.

Write the runner against the sandbox, not the provider:

```ts title="run-snippet.ts"
import type { Sandbox } from "@opencoredev/sandbox-sdk";

export async function runSnippet(box: Sandbox, code: string) {
  await box.files.write("snippet.mjs", code);
  const result = await box.run("node snippet.mjs", { timeoutMs: 10_000 });
  if (result.timedOut) return "timed out after 10 s";
  return result.ok ? result.stdout : `exit ${result.exitCode}: ${result.output}`;
}
```

Then call it with a real sandbox, network off. Install `@vercel/sandbox` next to the SDK and set the credentials from the [Vercel provider page](/docs/providers/vercel) first:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { vercel } from "@opencoredev/sandbox-sdk/vercel";
import { runSnippet } from "./run-snippet.ts";

const code = `console.log(process.version, 6 * 7)`; // what the model wrote

await using box = await createSandbox(vercel({ persistent: false }), {
  network: "none",
  timeoutMs: 5 * 60_000,
});
console.log(await runSnippet(box, code));
```

What this gives you:

- **`process` is the sandbox's, not yours.** The snippet sees the sandbox's environment and files, and no provider keys. Those stay on your server.
- **The network is off, or creation fails.** A provider that can't enforce `network: "none"` throws `unsupported` instead of creating an open sandbox. The [No network row of the provider table](/docs/reference/capabilities#matrix) lists which providers can.
- **Time limits on both levels.** A command that runs past its `timeoutMs` is killed and returns `timedOut: true`. The `timeoutMs` passed to `createSandbox` is the provider's hard limit: Vercel applies it to each session, some providers don't support it and fail with `unsupported`, and `local()` only stores it: Docker enforces it when a client reconnects or `reapSandboxes` runs.
- **Cleanup on throw.** This sandbox has no `key`, so `await using` destroys it when the block ends, even if your code throws. A keyed sandbox is meant to outlive the request, and `await using` only closes its handle. `persistent: false` makes Vercel discard the file system when the session stops, so no snapshot of the untrusted code's files outlives the sandbox; by default Vercel keeps that snapshot until it expires.

`runSnippet` takes any provider. Swap `vercel()` for `e2b()` or `daytona()` to run the same code on another one, as long as its image has Node.js and it supports the options you pass; check the provider table linked above before you rely on `network` or `timeoutMs`. The [security reference](/docs/reference/security) covers what the provider isolates and what the SDK adds for secrets.

## Test it without a cloud

`memory()` is a fake provider that runs in your test process. Register a handler for `node` and test `runSnippet` with no account and no machine:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { runSnippet } from "./run-snippet.ts";

const provider = memory({
  handlers: {
    node: async ({ args, files, stdout }) => {
      const code = await files.read(`/workspace/${args[0]}`);
      stdout(`ran ${args[0]} (${code.length} bytes)\n`);
      return 0;
    },
  },
});

await using box = await createSandbox(provider);
console.log(await runSnippet(box, "console.log(42)"));
```

```text
ran snippet.mjs (15 bytes)
```

The [memory() handler guide](/docs/guides/testing-with-memory) covers the rest of its API. `memory()` runs handlers in your process with your privileges, so it's for tests only.

## Which Node.js sandbox should I use?

- **A formula, a rule or a small plugin in plain JavaScript:** isolated-vm or QuickJS, in a worker process that holds no secrets. Pass in data only, set memory and time limits, and treat them as a first layer, not the only one.
- **Anything a model or a stranger wrote that may use npm, a shell, files or another language:** a microVM sandbox.
- **Your own scripts that you want to keep away from files and APIs:** the permission model.
- **Your own team's code on a host you've locked down:** a Docker container.
- **Untrusted code of any kind:** not `node:vm`, and not vm2 on its own.

## Common questions

**What is the best Node.js sandbox library?** For JavaScript that needs no Node APIs, isolated-vm or quickjs-emscripten, run in a separate process with limits. For untrusted programs, no library that runs in your process is enough: run them in a container or microVM and drive it from Node, for example with `@opencoredev/sandbox-sdk`.

**Is vm2 deprecated?** Not anymore. It was marked discontinued in 2023 and is maintained again, with releases through 2026 that patch escapes. Its README still recommends stronger isolation for arbitrary user submissions.

**Can I run Python from Node.js in a sandbox?** Yes, in a container or microVM whose image has `python3`. Write the file with `box.files.write("main.py", code)` and run `box.run("python3 main.py")`. [Files and git](/docs/concepts/files-and-git) has the details.

**How do I limit time and memory?** isolated-vm takes `memoryLimit` on the isolate and `timeout` on each `eval`. QuickJS takes `memoryLimitBytes` and a `shouldInterrupt` deadline. With Sandbox SDK, `timeoutMs` on `box.run` limits one command, `timeoutMs` on `createSandbox` limits the sandbox (on `local()`, only when a client reconnects or a reaper runs), and `size` sets CPU and memory where the provider allows it.

## Next steps

- [Sandbox tools for AI agents](/docs/guides/give-your-agent-a-sandbox): let a model run commands and edit files in the sandbox, with the AI SDK, Mastra or the OpenAI Agents SDK.
- [CPU, memory and network limits per provider](/docs/guides/machine-size-and-network): sizes, allow lists and what each provider enforces.
- [Cleaning up sandboxes when code throws](/docs/guides/cleanup): provider limits and a scheduled reaper for sandboxes nobody closed.
