# Sandbox SDK

One TypeScript API for running code in a sandbox. The same `createSandbox`, `run`, `files`, `start`, and `preview` calls work on E2B, Daytona, Vercel, Upstash Box, Railway, Tenki, boxd, Freestyle, Superserve, Boat, Sandboxer, Docker on your machine, and an in-process fake for tests. Changing provider means changing one import.

> **1.0 beta.** This is `1.0.0-beta.0` of the 1.0 rewrite, published under the `next` tag. The API can still change before 1.0.0. `latest` is still 0.2.

## Install

```sh
npm install @opencoredev/sandbox-sdk@next
```

Then add the peer package for each provider you use (see [Providers](#providers)), for example `npm install e2b`. Provider packages are optional peers, so you only download the ones you need. The core has no runtime dependencies.

Requires Node.js 22+ or Bun 1.3+, ESM only. The examples use `await using`, which runs natively on Node.js 24 and Bun. On Node.js 22, compile with TypeScript (target ES2022 or lower) or call `box.destroy()` yourself.

## Quickstart

This runs with no account and no Docker. The `memory` provider is an in-process fake with a small shell (`echo`, `cat`, `printf`, `sleep`, `ls`, `printenv`):

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

await using box = await createSandbox(memory());

await box.files.write("hello.txt", "hello from the sandbox\n");
const result = await box.run("cat hello.txt");
console.log(result.ok, result.stdout); // true "hello from the sandbox\n"
```

For a real Linux sandbox, swap the provider. Nothing else changes:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

// Reads E2B_API_KEY from the environment. Run `npm install e2b` first.
await using box = await createSandbox(e2b());

await box.files.write("hello.py", "print('hello from the sandbox')");
const result = await box.run("python3 hello.py");
console.log(result.ok, result.stdout);
```

`await using` deletes the sandbox when the scope ends, even if your code throws. A command that exits non-zero resolves with `ok: false`; it never throws.

## Switch providers with one variable

Pick the provider from an environment variable and keep the sandbox code identical. Each adapter loads through a dynamic `import()`, so only the provider you pick needs its peer package installed. At runtime that holds as written. For the TypeScript compiler, the switch still reaches every listed adapter's declarations, and those reference their peer's types. Set `"skipLibCheck": true` in `tsconfig.json` (most templates already do), or install the peers you list as devDependencies, otherwise `tsc` reports TS2307 for the ones you left out.

```ts
import { createSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";

async function loadProvider(name: string): Promise<Provider> {
  switch (name) {
    case "memory": return (await import("@opencoredev/sandbox-sdk/memory")).memory();
    case "local": return (await import("@opencoredev/sandbox-sdk/local")).local();
    case "e2b": return (await import("@opencoredev/sandbox-sdk/e2b")).e2b();
    case "daytona": return (await import("@opencoredev/sandbox-sdk/daytona")).daytona();
    case "vercel": return (await import("@opencoredev/sandbox-sdk/vercel")).vercel();
    case "upstash": return (await import("@opencoredev/sandbox-sdk/upstash")).upstash();
    default: throw new Error(`Unknown SANDBOX_PROVIDER "${name}"`);
  }
}

// Portable code takes the base `Sandbox` type: only the methods every provider has.
async function greet(box: Sandbox): Promise<string> {
  await box.files.write("greeting.txt", `hello from ${box.provider}\n`);
  return (await box.run("cat greeting.txt")).stdout.trim();
}

await using box = await createSandbox(await loadProvider(process.env.SANDBOX_PROVIDER ?? "memory"));
console.log(await greet(box));
```

`SANDBOX_PROVIDER=local` runs it in Docker; `SANDBOX_PROVIDER=e2b` runs it on E2B. The repository has a runnable version with every provider and an exhaustive switch in `examples/getting-started`.

Two things differ between providers and are worth checking before you go multi-provider:

- **Optional methods.** `pause`/`resume` and `snapshot` exist only on providers that support them. See [Pause, resume, and snapshots](#pause-resume-and-snapshots) for how this works with a runtime-selected provider.
- **Create options.** `size`, `network`, `from`, `timeoutMs`, and `idleTimeoutMs` fail with `unsupported` on providers that cannot enforce them. Provider-agnostic code should leave them out or catch that code.

## Providers

Import each provider from its own subpath. The root entry never loads a provider SDK, and constructing a factory performs no I/O.

| Provider | Import from | Factory | Credentials (env) | Peer package | Capabilities | Previews |
| --- | --- | --- | --- | --- | --- | --- |
| [E2B](https://sandbox-sdk.app/docs/providers/e2b) | `/e2b` | `e2b()` | `E2B_API_KEY` | `e2b` | pause, snapshot, network-policy | any port |
| [Daytona](https://sandbox-sdk.app/docs/providers/daytona) | `/daytona` | `daytona()` | `DAYTONA_API_KEY` (optional `DAYTONA_API_URL`, `DAYTONA_TARGET`) | `@daytonaio/sdk` | snapshot, size, network-policy | any port; private sandboxes need `preview.headers` |
| [Vercel](https://sandbox-sdk.app/docs/providers/vercel) | `/vercel` | `vercel()` | `VERCEL_OIDC_TOKEN`, or `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` | `@vercel/sandbox` | pause, snapshot, size, network-policy | declare in `ports` (max 15) |
| [Upstash Box](https://sandbox-sdk.app/docs/providers/upstash) | `/upstash` | `upstash()` | `UPSTASH_BOX_API_KEY` (optional `UPSTASH_BOX_BASE_URL`) | `@upstash/box` | pause, snapshot, size, network-policy; no pause with `ephemeral: true` | any port; bearer token in `preview.headers` unless `public: true` |
| [Railway](https://sandbox-sdk.app/docs/providers/railway) | `/railway` | `railway()` | `RAILWAY_API_TOKEN`, `RAILWAY_ENVIRONMENT_ID` | `railway` | snapshot | declare in `ports` (max 10) |
| [Tenki](https://sandbox-sdk.app/docs/providers/tenki) | `/tenki` | `tenki()` | `TENKI_AUTH_TOKEN` or `TENKI_API_KEY` | `@tenkicloud/sandbox` | pause, snapshot, size, network-policy | any port; URL may expire (`preview.expiresAt`) |
| boxd | `/boxd` | `boxd()` | `BOXD_API_KEY` (optional `BOXD_BASE_URL`) | `@boxd-sh/sdk` | pause, snapshot, size | one port at a time; the URL follows the last port requested |
| Freestyle | `/freestyle` | `freestyle()` | `FREESTYLE_API_KEY` | `freestyle` | pause, snapshot, network-policy | any port |
| Superserve | `/superserve` | `superserve()` | `SUPERSERVE_API_KEY` | `@superserve/sdk` | pause, snapshot | any port; token in `preview.headers` |
| Boat | `/boat` | `boat()` | `BOAT_API_KEY` (optional `BOAT_API_BASE`) | `@boatdev/sdk` | size | any port; cookie in `preview.headers` |
| Sandboxer | `/sandboxer` | `sandboxer({ region })` | `SANDBOXER_API_KEY` (optional `SANDBOXER_REGION`: `us-east`, `eu-central`) | `@boatdev/sdk` | pause, snapshot, size | any port; private URL, send `preview.headers` |
| [Local (Docker)](https://sandbox-sdk.app/docs/providers/local) | `/local` | `local()` | none; needs a running Docker Engine (`DOCKER_HOST` or `/var/run/docker.sock`) | none | pause, snapshot, size, network-policy (`"none"` only, no allow-lists) | declare in `ports` (default `[3000]`); URL is `http://127.0.0.1:<port>` |
| [agentOS](https://sandbox-sdk.app/docs/providers/agentos) | `/agentos` | `agentos()` | none | `@rivet-dev/agentos-core` | network-policy | none; no background processes either |
| Memory | `/memory` | `memory()` | none | none | network-policy | fake `*.memory.invalid` URL; never fetch it |

Capability meanings: `pause` adds `box.pause()` and `box.resume()`, `snapshot` adds `box.snapshot()` and `createSandbox(provider, { from })`, `size` allows the `size` option, and `network-policy` allows `network: "none"` or `{ allow: [...] }`. The SDK also defines `terminal` (`box.terminal()`, an interactive PTY), but no built-in provider supports it yet.

Every factory also accepts its credential as an option, such as `e2b({ apiKey })` or `railway({ token, environmentId })`. Endpoints use `baseUrl` (boxd, Daytona, Tenki, Upstash, Boat), and Boat's default machine size uses `machine`:

```ts
import { boat } from "@opencoredev/sandbox-sdk/boat";
import { boxd } from "@opencoredev/sandbox-sdk/boxd";
import { daytona } from "@opencoredev/sandbox-sdk/daytona";
import { tenki } from "@opencoredev/sandbox-sdk/tenki";

const providers = [
  boxd({ baseUrl: "https://boxd.sh:9443" }),
  daytona({ baseUrl: "https://app.daytona.io/api" }),
  boat({ baseUrl: "https://boat.dev/api/v1", machine: "small" }),
  tenki({ apiKey: process.env.TENKI_API_KEY }),
];
```

The old names (`boxd.baseURL`, `daytona.apiUrl`, `boat.apiUrl`, `tenki.authToken`, and `boat.type`) still work as deprecated aliases until 1.0.0. When both names are set, the new name wins.

## Core API

### Create, reconnect, clean up

```ts
import { connectSandbox, createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

const box = await createSandbox(e2b(), {
  key: "user:123", // the same key returns the same sandbox
  env: { NODE_ENV: "development" },
  secrets: { GITHUB_TOKEN: "ghp_example" }, // redacted from all output and errors
  network: { allow: ["registry.npmjs.org"] },
  timeoutMs: 30 * 60_000, // hard lifetime, where the provider supports it
});

await box.close(); // detach; the sandbox keeps running
const again = await connectSandbox(e2b(), box.id);
await again.destroy(); // delete it
```

`await using box = await createSandbox(...)` disposes the handle when the scope ends:

- Without a `key`, it calls `destroy()` and the sandbox is deleted.
- With a `key`, it calls `close()`, so the sandbox survives for the next request with that key.

Use `listSandboxes(provider)` and `reapSandboxes(provider, { olderThanMs })` to find and delete sandboxes this SDK created, such as ones a crashed process never cleaned up.

### Run commands and stream output

```ts
const result = await box.run("npm test", { cwd: "app" });
if (!result.ok) console.log(result.exitCode, result.output);

const branch = "feature/login";
await box.$`git checkout ${branch}`; // interpolated values are shell-quoted

const install = box.run("npm install");
for await (const chunk of install) process.stdout.write(chunk.text); // chunk.stream is "stdout" or "stderr"
const { ok, durationMs } = await install; // the same handle, now finished
```

`run` returns a lazy handle: nothing starts until you `await` it or iterate it. Commands start in `/workspace` and keep up to 1 MB per stream (`maxOutputBytes`); older output is dropped and `truncated` is set. `stdout` and `stderr` are separate strings, and `output` interleaves them in arrival order.

### Timeouts and cancellation

```ts
const slow = await box.run("sleep 600", { timeoutMs: 5_000 });
console.log(slow.ok, slow.timedOut, slow.exitCode); // false true null

const chained = await box.run("npm test").cwd("app").timeout(60_000);

const controller = new AbortController();
const pending = box.run("npm run build", { signal: controller.signal });
controller.abort();
console.log((await pending).ok); // false; an aborted run also reports timedOut: true
```

- Commands time out after 120 seconds unless you pass `timeoutMs` or chain `.timeout(ms)`. A timeout or an abort kills the command's process group and resolves with `ok: false`, `exitCode: null`, and `timedOut: true`. It does not throw.
- `createSandbox(provider, { signal })` rejects with `SandboxError` code `aborted`. A sandbox that arrives after the abort is destroyed for you.
- `start(..., { readyTimeoutMs })` bounds readiness (default 60 seconds), and `preview(port, { waitMs })` waits for a 2xx.
- `timeoutMs` and `idleTimeoutMs` on `createSandbox` set the sandbox's own lifetime, not a command timeout. A hard lifetime (`timeoutMs`) works on E2B, Daytona (one minute or more), Tenki, Freestyle, Local, and Memory. An idle timeout (`idleTimeoutMs`) works on Daytona, Railway, Freestyle, Local, and Memory. Every other provider rejects them with `unsupported`.

### Files

```ts
await box.files.write({ "app/package.json": "{}", "app/index.js": "console.log(1)" });
const text = await box.files.read("app/index.js");
const bytes = await box.files.read("app/index.js", { as: "bytes" });
await box.files.edit("app/index.js", { find: "console.log(1)", replace: "console.log(2)" });
const matches = await box.files.search("console.log", { path: "app" });
const entries = await box.files.list("app", { recursive: true });
await box.files.upload("./local-project", "app", { ignore: ["node_modules"] });
const diff = await box.files.changes({ since: await box.files.mark() });
```

Relative paths resolve against `/workspace`. `read` returns a string unless you pass `{ as: "bytes" }`. A missing path fails with `file_not_found`. `edit` fails with `edit_not_found` or `edit_not_unique` unless the text matches exactly once.

### Background processes

```ts
const dev = await box.start("npm run dev", { name: "dev", ready: { port: 3000 } });
console.log(dev.ready, dev.status); // true "running"

const { text } = await box.process("dev").logs();
await dev.stop();
```

`start` returns once the process is ready. Readiness is one of:

- `{ port: 3000 }`: the port's preview URL answers with a 2xx.
- `{ http: { port: 3000, path: "/health" } }`: that path answers with a 2xx.
- `{ log: /listening/ }`: a log line matches.

Without `ready`, `start` returns as soon as the process launches. If the process exits first, `start` fails with `process_exited` and includes the exit code and log tail. Readiness gives up after `readyTimeoutMs` (default 60 seconds) with `timeout`.

The name is the process's durable ID (1 to 128 letters, digits, `-`, `_`). It is optional: without one, `start` derives a stable name from the command, such as `npm-1a2b3c4d`, and returns it as `dev.name`. Any client can find it again with `box.process("dev")`, even after your server restarts. `box.processes()` lists them, and a handle has `logs()`, `lines()`, `stop()`, `restart()`, and `wait()`.

### Previews

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";

await using box = await createSandbox(local(), { ports: [3000] });
await box.start("python3 -m http.server 3000", { name: "web", ready: { port: 3000 } });

const preview = await box.preview(3000);
const response = await fetch(preview.url, { headers: preview.headers });
console.log(preview.url, response.status); // http://127.0.0.1:<port>/ 200
```

Always send `preview.headers`. Daytona (private sandboxes), Upstash, Superserve, Boat, and Sandboxer put the access token there, and those providers reject requests without it. Local, Vercel, and Railway only route ports you declared with `createSandbox(provider, { ports })`, so pass `ports` in provider-agnostic code; the other providers ignore it. Servers must listen on `0.0.0.0`, not `localhost`.

### Pause, resume, and snapshots

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using box = await createSandbox(e2b());
const snap = await box.snapshot();
await using copy = await createSandbox(e2b(), { from: snap.id });

await box.pause();
await box.resume();
```

These methods are gated in the types by the provider's capability union. With a concrete provider, a missing method is a compile error:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { boat } from "@opencoredev/sandbox-sdk/boat";

await using box = await createSandbox(boat());
// @ts-expect-error Boat has no snapshot capability, so the method does not exist.
await box.snapshot();
```

When you pick the provider at runtime, as in [Switch providers](#switch-providers-with-one-variable), the provider's type is the wide `Provider`, so the SDK cannot know which methods exist. `pause`, `resume`, `snapshot`, and `terminal` are then optional on the sandbox, and calling one directly is a compile error. `hasCapability` checks at runtime and narrows the type:

```ts
import { hasCapability } from "@opencoredev/sandbox-sdk";

if (hasCapability(box, "snapshot")) {
  const { id } = await box.snapshot();
  console.log(`saved ${id}`);
}
```

`box.capabilities.has("snapshot")` gives the same answer as a boolean, but it cannot narrow `box`, so use `hasCapability` before calling the method.

### Git

```ts
await box.git.clone("https://github.com/opencoredev/sandbox-sdk", { dir: "repo", depth: 1 });
await box.git.commit("repo", { message: "Update docs", all: true });
await box.git.push("repo", { token: process.env.GITHUB_TOKEN });
```

Tokens reach git through a temporary credential helper, never argv, env, or shell history, and are redacted from output. Git must be installed in the sandbox image; the memory provider has no git.

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

The SDK only throws `SandboxError`. A non-zero exit, a command timeout, or an aborted `run` is a result, not an error. `hint` is the next step on its own, `retryable` says whether the same call can succeed again, and `provider` and `sandboxId` say where it happened. Secrets are redacted from every field.

| `code` | Meaning |
| --- | --- |
| `auth` | Credentials are missing or rejected. |
| `not_found` | The sandbox no longer exists, or this handle was closed. |
| `quota` | A provider limit or billing stopped the request. Usually retryable. |
| `unavailable` | The provider is down or unreachable. Usually retryable. |
| `unsupported` | The provider cannot do what was asked: `size`, `network`, a lifetime option, an undeclared preview port. |
| `timeout` | A provider operation or a readiness check took too long. |
| `aborted` | Your `AbortSignal` fired during `createSandbox`. |
| `outcome_unknown` | The request may or may not have happened. Check state before retrying. |
| `process_exited` | A background process exited before it was ready. |
| `port_not_ready` | A preview did not answer with a 2xx before `waitMs` ran out. |
| `edit_not_found`, `edit_not_unique` | `files.edit` matched zero times or more than once. |
| `file_not_found` | The path does not exist. |
| `invalid_argument` | The input is invalid. Retrying will not help. |
| `provider` | Any other provider or adapter failure. Read `message` and `cause`. |

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

The default tools are `run`, `read_file`, `write_file`, `edit_file`, `start_process`, `process_logs`, and `stop_process`. Opt into `search`, `list_files`, `changes`, or `preview` with `allow`. Results are compact and capped for model context, and registered secrets never reach the model. Use `beforeRun` to deny or rewrite commands. `root` limits file paths, but it is not a security boundary; the sandbox is.

## Performance

The SDK aims for near-zero overhead on top of each provider's own API. The root entry is under 8 KB minified, providers load on first use, and `createSandbox` adds no provider calls beyond the create itself unless you pass `secrets`, `from`, or `trackChanges: true` (one exec each).

Time the SDK adds on top of each provider's own SDK, as median milliseconds. "Cold" is `createSandbox` plus the first `box.run("true")`, compared with the provider SDK's create plus its own exec. "Run" is a warm `run("true")` on an existing sandbox. Negative numbers and small differences are within provider noise.

| Provider | Create | Cold: create to first command | Warm `run` |
| --- | ---: | ---: | ---: |
| E2B | +24 | +52 | +8 |
| Daytona | ±0 | ±0 | +38 |
| Upstash Box | +27 | +69 | +15 |
| Freestyle | ±0 | +51 | +23 |
| Tenki | ±0 | +119 | +15 |
| Superserve | ±0 | +73 | +9 |
| boxd | +272 | +370 | +52 |

boxd has no native metadata field, so a sandbox created with labels or a `key` writes its ownership record with one extra request before `createSandbox` returns. The other providers send labels with the create call itself and run any guest setup inside your first command.

Measured on 2026-10-22 from one Linux host with `bench/scripts/sdk-overhead.ts`, 5 to 8 cold samples and 10 warm samples per provider. See the `bench/` directory in the repository to reproduce.

## More

- [Documentation](https://sandbox-sdk.app/docs): guides, provider pages, and the [error reference](https://sandbox-sdk.app/docs/reference/errors).
- Write your own provider: implement `Provider` from `@opencoredev/sandbox-sdk/provider` and test it with `runConformance` from `@opencoredev/sandbox-sdk/testing`.
- [Report an issue](https://github.com/opencoredev/sandbox-sdk/issues).
- [Changelog](./CHANGELOG.md).

## License

MIT
