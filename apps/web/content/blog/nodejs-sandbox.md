---
title: Node.js sandbox: vm, isolated-vm, Docker or a microVM
description: Which Node.js sandbox holds up against untrusted code. node:vm, vm2, isolated-vm, QuickJS, the permission model, Docker and microVMs, with tested code.
published: 2026-11-24
---

A Node.js sandbox that holds up against untrusted code runs that code outside your process. `node:vm` and the permission model are not security boundaries, isolated-vm and QuickJS contain only JavaScript, and containers or microVMs contain whole programs.

Every sample below ran on Node 24.22 in November 2026, and the output shown is what it printed. The last two use [Sandbox SDK by OpenCore](/) (`@opencoredev/sandbox-sdk`) to run code a model wrote in a microVM.

## The options at a glance

| Option                        | Where the code runs                   | What it can reach                            | Fit for untrusted code          |
| ----------------------------- | ------------------------------------- | -------------------------------------------- | ------------------------------- |
| `node:vm`                     | Your process, a new V8 context        | Your whole process, through one escape       | No                              |
| vm2                           | Your process, wrapped `node:vm`       | Your process, whenever the wrapper has a gap | No                              |
| isolated-vm                   | Your process, a separate V8 isolate   | Only values you pass in                      | JavaScript only, used with care |
| QuickJS in WebAssembly        | Your process, a Wasm interpreter      | Only values you pass in                      | JavaScript only                 |
| Permission model              | A separate Node process               | What the `--allow-*` flags grant             | No                              |
| Docker container              | A separate process on the same kernel | Its own files and network, your kernel       | Partly: the kernel is shared    |
| MicroVM (E2B, Vercel Sandbox) | Another machine with its own kernel   | Its own disk, and the network you allow      | Yes, any language or program    |

The first four never leave your server's process, so they answer quickly and can only run JavaScript. The last two run a real program, so the code can `npm install`, start a server or run Python.

## Is node:vm a sandbox?

No. Node's own [vm docs](https://nodejs.org/api/vm.html) say: "The node:vm module is not a security mechanism. Do not use it to run untrusted code."

One line of code shows why:

```js
import vm from "node:vm";

// Code a user or a model wrote. It never mentions `process`.
const untrusted = `this.constructor.constructor("return process")().version`;

console.log(vm.runInNewContext(untrusted, {}));
```

```text
v24.22.1
```

The object you pass as the context was created in your realm. Its `constructor` is your `Object`, and that one's `constructor` is your `Function`, which compiles code with full access to `process`. From there the code can read your environment variables or spawn a shell. `node:vm` is for running code you trust in a separate global scope, such as a template engine or a REPL.

## Is vm2 safe to use?

Not for untrusted code. Its [README](https://github.com/patriksimek/vm2) opens with "Project Discontinued" and says the library "contains critical security issues and should not be used for production", and it points users to isolated-vm.

Releases still appear on npm (3.12.2 in September 2026), and escapes keep being found. In January 2026 [Semgrep](https://semgrep.dev/blog/2026/calling-back-to-vm2-and-escaping-sandbox/) described a sandbox escape scored 9.8 on CVSS, fixed in 3.10.2. vm2 wraps `node:vm` in proxies, so every gap in the wrapper reaches your process.

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

It's a different engine from V8, and it needs no native build. It suits formulas, rules and small plugins written in plain JavaScript. Code that expects Node APIs or npm packages won't run in it.

## Does the Node.js permission model sandbox code?

No. The [permission model](https://nodejs.org/api/permissions.html), stable since Node 22.13 and 23.5, "does not protect against malicious code", and Node's docs say malicious code can bypass it. It's a seat belt that stops your own scripts from touching files or APIs by mistake.

Run a script with `--permission` and only what you allow works. This one tries to spawn a process:

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

Run code from strangers in a container only on a machine that holds no secrets. For code from your own team or your own agent, it's often enough.

## MicroVM sandboxes: another kernel, any language

To run untrusted programs safely, run them on another machine. E2B and Vercel Sandbox start each sandbox as a microVM with its own kernel and disk, and the code inside can run `node`, install npm packages or start a dev server without reaching your server.

Write the runner against the sandbox, not the provider:

```ts
import type { Sandbox } from "@opencoredev/sandbox-sdk";

export async function runSnippet(box: Sandbox, code: string) {
  await box.files.write("snippet.mjs", code);
  const result = await box.run("node snippet.mjs", { timeoutMs: 10_000 });
  if (result.timedOut) return "timed out after 10 s";
  return result.ok ? result.stdout : `exit ${result.exitCode}: ${result.output}`;
}
```

Then call it with a real sandbox, network off:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { vercel } from "@opencoredev/sandbox-sdk/vercel";
import { runSnippet } from "./run-snippet";

const code = `console.log(process.version, 6 * 7)`; // what the model wrote

await using box = await createSandbox(vercel(), {
  network: "none",
  timeoutMs: 5 * 60_000,
});
console.log(await runSnippet(box, code));
```

What this gives you:

- **`process` is the sandbox's, not yours.** The snippet sees the sandbox's environment and files, and no provider keys. Those stay on your server.
- **The network is off, or creation fails.** A provider that can't enforce `network: "none"` throws `unsupported` instead of creating an open sandbox. The [No network row of the provider table](/docs/reference/capabilities#matrix) lists which providers can.
- **Time limits on both levels.** A command that runs past its `timeoutMs` is killed and returns `timedOut: true`, and the sandbox's own `timeoutMs` bounds its lifetime.
- **Cleanup on throw.** `await using` destroys the sandbox when the block ends, even if your code throws.

`runSnippet` takes any provider. Swap `vercel()` for `e2b()` or `daytona()` to run the same code on another one, as long as its image has Node.js. The [security reference](/docs/reference/security) covers what the provider isolates and what the SDK adds for secrets.

## Test it without a cloud

`memory()` is a fake provider that runs in your test process. Register a handler for `node` and test `runSnippet` with no account and no machine:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { runSnippet } from "./run-snippet";

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

- **A formula, a rule or a small plugin in plain JavaScript:** isolated-vm or QuickJS. Pass in data only, and set memory and time limits.
- **Anything a model or a stranger wrote that may use npm, a shell, files or another language:** a microVM sandbox.
- **Your own scripts that you want to keep away from files and APIs:** the permission model.
- **Your own team's or agent's code on a machine with no secrets:** a Docker container.
- **Untrusted code of any kind:** not `node:vm`, not vm2.

## Common questions

**What is the best Node.js sandbox library?** For untrusted JavaScript that needs no Node APIs, isolated-vm or quickjs-emscripten. For untrusted programs, no library that runs in your process is enough: run them in a container or microVM and drive it from Node, for example with `@opencoredev/sandbox-sdk`.

**Is vm2 deprecated?** Its README says the project is discontinued, that it has critical security issues and that it shouldn't be used in production. New versions still ship to fix escapes.

**Can I run Python from Node.js in a sandbox?** Yes, in a container or microVM. Write the file with `box.files.write("main.py", code)` and run `box.run("python3 main.py")`. [Files and git](/docs/concepts/files-and-git) has the details.

**How do I limit time and memory?** isolated-vm takes `memoryLimit` on the isolate and `timeout` on each `eval`. QuickJS takes `memoryLimitBytes` and a `shouldInterrupt` deadline. With Sandbox SDK, `timeoutMs` on `box.run` limits one command, `timeoutMs` on `createSandbox` limits the sandbox, and `size` sets CPU and memory where the provider allows it.

## Next steps

- [Sandbox tools for AI agents](/docs/guides/give-your-agent-a-sandbox): let a model run commands and edit files in the sandbox, with the AI SDK, Mastra or the OpenAI Agents SDK.
- [CPU, memory and network limits per provider](/docs/guides/machine-size-and-network): sizes, allow lists and what each provider enforces.
- [Cleaning up sandboxes when code throws](/docs/guides/cleanup): provider limits and a scheduled reaper for sandboxes nobody closed.
