---
name: sandbox-sdk
description: Use when implementing isolated code execution with @opencoredev/sandbox-sdk, choosing a provider, or working with sandbox files, commands, processes, ports, and snapshots.
---

# Sandbox SDK

Use one TypeScript interface across Local, Memory, E2B, Daytona, Vercel Sandbox, Upstash Box, Ascii Box, Railway, and Cloudflare. Files and commands are portable. Ports, snapshots, and PTY are not.

## Start here

1. Fetch `https://sandbox-sdk.app/llms.txt` to find the current documentation.
2. Read First sandbox and exactly one adapter page.
3. Read a focused API or integration page only when the task needs it.

## Default implementation

```ts
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using sandbox = await e2b().create();
console.log((await sandbox.$`node --version`).stdout);
```

For tests with no VM, use `memory()`. It is not a security boundary.

## Rules

- Prefer `await using sandbox = await e2b().create()` so the sandbox stops when its scope exits. `createSandbox({ provider })` still works.
- Use `withSandbox()` when callback-style lifecycle management is required or uncompiled JavaScript runs on Node.js 22.
- Use Memory for unit tests. Use Local when no hosted runtime is required. Railway and Cloudflare are experimental and are not eligible for Eve, Mastra, or Harness. Cloudflare needs a Worker `getSandbox` binding.
- Use `sandbox.files`, `sandbox.run`, `sandbox.processes`, `sandbox.ports`, and `sandbox.snapshots` before native SDK methods.
- Check `sandbox.capabilities` or use `requireCapability()` before optional operations.
- Access provider-specific APIs through the typed `sandbox.raw` escape hatch.
- Put `sandbox.stop()` in `finally` only when the sandbox must outlive an `await using` scope.
- Treat preview URLs, environment variables, credentials, and untrusted commands as security boundaries owned by the application.
- Do not assume optional behavior is portable. Verify it in `https://sandbox-sdk.app/docs/reference/compatibility`.

## Focused Markdown

Fetch one page with:

`https://sandbox-sdk.app/llms.mdx/docs/{path}/content.md`

Use `https://sandbox-sdk.app/llms-full.txt` only when the task genuinely needs the entire documentation set.
