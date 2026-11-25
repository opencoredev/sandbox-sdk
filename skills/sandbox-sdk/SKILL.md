---
name: sandbox-sdk
description: Use when implementing isolated code execution with @opencoredev/sandbox-sdk, choosing a provider, or working with sandbox commands, files, background processes, previews, and snapshots.
---

# Sandbox SDK

`@opencoredev/sandbox-sdk` 1.x is one TypeScript API for sandboxes on Docker (`local`), agentOS, E2B, Vercel Sandbox, Modal, Baseten, Daytona, Upstash Box, Railway, Boat, Sandboxer, Luxor (`tenki`), Superserve, boxd, Freestyle, Instabox, Beam, and an in-process fake for tests (`memory`). Each provider is a factory imported from its own subpath, such as `@opencoredev/sandbox-sdk/e2b`. It runs server-side on Node.js 22+ or Bun 1.3+, not in browsers or edge runtimes.

## Start here

1. Fetch `https://sandbox-sdk.app/llms.txt` for the documentation index.
2. Read the Quickstart and exactly one provider page.
3. Read a focused API page only when the task needs it. Fetch one page as Markdown from `https://sandbox-sdk.app/docs/{path}.md`, for example `https://sandbox-sdk.app/docs/reference/sandbox.md`.

Use `https://sandbox-sdk.app/llms-full.txt` only when the task needs the whole documentation set.

## Default implementation

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";

await using box = await createSandbox(local());
const result = await box.run("node --version");
console.log(result.ok, result.stdout);
```

`createSandbox(provider, options)` takes the provider first. Use `memory()` from `@opencoredev/sandbox-sdk/memory` for tests and offline trials; it needs no Docker and no account.

## Rules

- Prefer `await using box = await createSandbox(...)`. When the scope exits it calls `box.close()` if you passed a `key` (the sandbox keeps running so the next call with that key reattaches), and `box.destroy()` otherwise.
- Outside `await using`, call `box.destroy()` in `finally` to delete the sandbox, or `box.close()` to detach and leave it running. On Node.js 22 without a TypeScript compile step, use `try`/`finally`.
- Pass `key` to get the same sandbox back on the next request, and `connectSandbox(provider, id)` to reattach by ID.
- A non-zero exit is a result, not an error: check `result.ok`. The SDK throws only `SandboxError`; branch on `error.code`.
- Use the portable API before native SDK calls: `box.run`, `box.files`, `box.start` and `box.process(name)` for background processes, `box.preview(port)` for a URL (`{ url, headers }`; send `headers` with every request), and `box.snapshot()` where supported.
- Optional methods (`pause`, `resume`, `snapshot`, `terminal`) exist only when the provider declares the capability. With a provider chosen at runtime, narrow first: `if (hasCapability(box, "snapshot")) await box.snapshot();`.
- Options a provider cannot enforce (`size`, `network`, `from`, `timeoutMs`, `idleTimeoutMs`) fail with `unsupported` instead of being ignored. Check `https://sandbox-sdk.app/docs/reference/capabilities` before you rely on one.
- Reach provider-specific APIs through the typed `box.native` escape hatch, or `box.ext` where an adapter exposes extensions.
- Pass credentials-like values as `secrets`, not `env`: they are redacted from results, logs, and errors. Treat preview URLs, credentials, and untrusted commands as security boundaries the application owns.
- For agent tools, import `sandboxTools` from `@opencoredev/sandbox-sdk/ai`, `/mastra`, or `/openai`.
