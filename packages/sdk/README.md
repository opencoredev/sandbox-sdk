# Sandbox SDK

One TypeScript API for running code in a sandbox: E2B, Daytona, Vercel, Upstash, Docker, and eight more providers. Write the code once and change one import to switch.

> **1.0 beta.** This is an early preview of the 1.0 rewrite, published under the `next` tag. The API may still change before 1.0.0. Coming from 0.2? See the [upgrade guide](https://github.com/opencoredev/sandbox-sdk/blob/main/apps/docs/content/upgrade-from-0-2.mdx).

## Install

```sh
npm install @opencoredev/sandbox-sdk@next e2b
```

Install the SDK plus the package for the provider you use (the table below lists it). Provider packages are optional peers, so you only download the ones you need. The core has no runtime dependencies.

Requires Node.js 22+ or Bun 1.3+. The examples use `await using`, which runs natively on Node.js 24 and Bun. On Node.js 22, compile with TypeScript (target ES2022 or lower) or call `box.destroy()` yourself.

## Quickstart

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

// Reads E2B_API_KEY from the environment.
await using box = await createSandbox(e2b());

await box.files.write("hello.py", "print('hello from the sandbox')");
const result = await box.run("python3 hello.py");
console.log(result.ok, result.stdout);
```

`await using` deletes the sandbox when the scope ends, even if your code throws. A command that exits non-zero resolves with `ok: false`; it never throws.

To try the API with no account, swap in the in-memory provider. It runs a small shell subset inside your process, which makes it a good fit for unit tests:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

await using box = await createSandbox(memory());
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

## Providers

Import each provider from its own subpath. The root entry never loads a provider SDK.

| Provider | Import from | Credentials | Peer package | Capabilities |
| --- | --- | --- | --- | --- |
| [E2B](https://github.com/opencoredev/sandbox-sdk/blob/main/docs/providers/e2b.md) | `/e2b` | `E2B_API_KEY` | `e2b` | pause, snapshot, network-policy |
| [Daytona](https://github.com/opencoredev/sandbox-sdk/blob/main/docs/providers/daytona.md) | `/daytona` | `DAYTONA_API_KEY` | `@daytonaio/sdk` | snapshot, size, network-policy |
| [Vercel](https://github.com/opencoredev/sandbox-sdk/blob/main/docs/providers/vercel.md) | `/vercel` | `VERCEL_OIDC_TOKEN`, or `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` | `@vercel/sandbox` | pause, snapshot, size, network-policy |
| Upstash Box | `/upstash` | `UPSTASH_BOX_API_KEY` | `@upstash/box` | pause, snapshot, size, network-policy (no pause with `ephemeral: true`) |
| Railway | `/railway` | `RAILWAY_API_TOKEN`, `RAILWAY_ENVIRONMENT_ID` | `railway` | snapshot |
| Tenki | `/tenki` | `TENKI_API_KEY` | `@tenkicloud/sandbox` | pause, snapshot, size, network-policy |
| boxd | `/boxd` | `BOXD_API_KEY` | `@boxd-sh/sdk` | pause, snapshot, size |
| Freestyle | `/freestyle` | `FREESTYLE_API_KEY` | `freestyle` | pause, snapshot, network-policy |
| Superserve | `/superserve` | `SUPERSERVE_API_KEY` | `@superserve/sdk` | pause, snapshot |
| Boat | `/boat` | `BOAT_API_KEY` | `@boatdev/sdk` | size |
| [Local (Docker)](https://github.com/opencoredev/sandbox-sdk/blob/main/docs/providers/local.md) | `/local` | none; needs a running Docker Engine | none | pause, snapshot, size, network-policy |
| agentOS | `/agentos` | none | `@rivet-dev/agentos-core` | network-policy |
| [Memory](https://github.com/opencoredev/sandbox-sdk/blob/main/docs/providers/memory.md) | `/memory` | none | none | network-policy |

Every factory also accepts its credential as an option, such as `e2b({ apiKey })`. Capabilities are typed: `box.snapshot()` only exists on a sandbox whose provider supports snapshots, so calling it on Boat is a compile error, not a runtime surprise. Options a provider can't enforce, such as a `size` it can't honor, fail with `unsupported` instead of being silently dropped.

## Core API

### Create, reconnect, clean up

```ts
import { createSandbox, connectSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

const box = await createSandbox(e2b(), {
  key: "user:123",                // same key returns the same sandbox
  env: { NODE_ENV: "development" },
  secrets: { GITHUB_TOKEN: "ghp_example" }, // redacted from all output and errors
  network: { allow: ["registry.npmjs.org"] },
  timeoutMs: 30 * 60_000,
});

await box.close();   // detach; the sandbox keeps running
const again = await connectSandbox(e2b(), box.id);
await again.destroy(); // delete it
```

With a `key`, `await using` calls `close()` so the sandbox survives for the next request. Without one, it calls `destroy()`. `listSandboxes(provider)` and `reapSandboxes(provider, { olderThanMs })` find and delete sandboxes this SDK created.

### Run commands

```ts
const result = await box.run("npm test", { cwd: "app", timeoutMs: 60_000 });
if (!result.ok) console.log(result.exitCode, result.output);

const branch = "feature/login";
await box.$`git checkout ${branch}`; // interpolated values are shell-quoted

for await (const chunk of box.run("npm install")) process.stdout.write(chunk.text);
```

Commands start in `/workspace`, time out after 120 seconds by default, and keep up to 1 MB per stream. A timeout resolves with `timedOut: true`.

### Files

```ts
await box.files.write({ "app/package.json": "{}", "app/index.js": "console.log(1)" });
const text = await box.files.read("app/index.js");
await box.files.edit("app/index.js", { find: "console.log(1)", replace: "console.log(2)" });
const matches = await box.files.search("console.log", { path: "app" });
await box.files.upload("./local-project", "app", { ignore: ["node_modules"] });
const diff = await box.files.changes({ since: await box.files.mark() });
```

Relative paths resolve against `/workspace`. `edit` fails with `edit_not_found` or `edit_not_unique` unless the text matches exactly once.

### Background processes and previews

```ts
const dev = await box.start("npm run dev", { name: "dev", ready: { port: 3000 } });
const preview = await box.preview(3000);
console.log(preview.url, preview.headers);

const { text } = await box.process("dev").logs();
await dev.stop();
```

`start` returns once the port answers (or a log line matches, with `ready: { log: /ready/ }`). The name is the process's durable ID: any client can find it with `box.process("dev")`, even after your server restarts. Some providers need ports declared up front with `createSandbox(provider, { ports: [3000] })`. Always send `preview.headers` with requests; private previews need them.

### Git

```ts
await box.git.clone("https://github.com/opencoredev/sandbox-sdk", { dir: "repo", depth: 1 });
await box.git.commit("repo", { message: "Update docs", all: true });
await box.git.push("repo", { token: process.env.GITHUB_TOKEN });
```

Tokens reach git through a temporary credential helper, never argv, env, or shell history, and are redacted from output.

### Snapshots and pause

```ts
const snap = await box.snapshot();
await using copy = await createSandbox(e2b(), { from: snap.id });

await box.pause();
await box.resume();
```

These methods exist only when the provider supports them (see the Capabilities column). Check at runtime with `box.capabilities.has("pause")`.

### Errors

```ts
import { SandboxError } from "@opencoredev/sandbox-sdk";

try {
  await box.files.read("missing.txt");
} catch (error) {
  if (!(error instanceof SandboxError)) throw error;
  console.error(error.code, error.message, error.hint, error.retryable);
}
```

The SDK only throws `SandboxError`. `code` is one of 15 strings, such as `auth`, `not_found`, `quota`, `unsupported`, or `file_not_found`. `hint` is the next step on its own, and `retryable` says whether the same call can succeed again. Secrets are redacted from every field. See the [error reference](https://github.com/opencoredev/sandbox-sdk/blob/main/apps/docs/content/reference/errors.mdx).

## Give an agent a sandbox

Install `zod` and your agent framework, then pass the tools to your agent:

```ts
import { generateText, stepCountIs } from "ai";
import { sandboxTools } from "@opencoredev/sandbox-sdk/ai";

const { text } = await generateText({
  model: "anthropic/claude-opus-5-5",
  tools: sandboxTools(box, { root: "/workspace/app" }),
  stopWhen: stepCountIs(20),
  prompt: "Add a /health route to the Express app and run its tests.",
});
```

| Framework | Import | Returns |
| --- | --- | --- |
| AI SDK 7 | `@opencoredev/sandbox-sdk/ai` | tool map for `generateText` / `streamText` |
| Mastra 1.78+ | `@opencoredev/sandbox-sdk/mastra` | tool map for `new Agent({ tools })` |
| OpenAI Agents 0.20+ | `@opencoredev/sandbox-sdk/openai` | tool array for `new Agent({ tools })` |
| Anything else | `@opencoredev/sandbox-sdk/tools` | `createSandboxTools` and Zod `toolSchemas` |

The default tools are `run`, `read_file`, `write_file`, `edit_file`, `start_process`, `process_logs`, and `stop_process`. Opt into `search`, `list_files`, `changes`, or `preview` with `allow`. Results are compact and capped for model context, and registered secrets never reach the model. Use `beforeRun` to deny or rewrite commands. `root` limits file paths, but it is not a security boundary; the sandbox is. Details: [agent tools](https://github.com/opencoredev/sandbox-sdk/blob/main/docs/agent-tools.md).

## Performance

The SDK aims for near-zero overhead on top of each provider's own API. The root entry is under 8 KB minified, providers load on first use, and `createSandbox` adds no provider calls beyond the create itself unless you pass `secrets`, `from`, or `trackChanges: true` (one exec each).

<!-- TODO(lead): replace with measured numbers from bench/scripts/sdk-overhead.ts -->
| Provider | Create: SDK vs native | `run("true")`: SDK vs native |
| --- | --- | --- |
| TODO | TODO | TODO |

Measured with `bench/scripts/sdk-overhead.ts`. See [bench/README.md](https://github.com/opencoredev/sandbox-sdk/blob/main/bench/README.md) to reproduce.

## More

- [Core behavior details](https://github.com/opencoredev/sandbox-sdk/blob/main/docs/core-behavior.md): timeouts, redaction, log cursors.
- [Write a provider adapter](https://github.com/opencoredev/sandbox-sdk/blob/main/docs/adapters.md) and test it with `runConformance` from `/testing`.
- [Full documentation](https://sandbox-sdk.app/docs).
- [Changelog](./CHANGELOG.md).

## License

MIT
