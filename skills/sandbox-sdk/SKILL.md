---
name: sandbox-sdk
description: Use when implementing isolated code execution with @opencoredev/sandbox-sdk, choosing a provider, or working with sandbox files, commands, processes, ports, and snapshots.
---

# Sandbox SDK

Use one normalized TypeScript interface across Local, E2B, Daytona, Vercel Sandbox, Upstash Box, and Agent37.

## Start here

1. Fetch `https://sandbox-sdk.app/llms.txt` to find the current documentation.
2. Read the Quickstart and exactly one provider page.
3. Read a focused API or integration page only when the task needs it.

## Default implementation

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";

await using sandbox = await createSandbox({ provider: local() });
const result = await sandbox.run("node --version");
console.log(result.stdout);
```

## Rules

- Prefer `await using sandbox = await createSandbox(...)` so the sandbox stops automatically when its scope exits.
- Use `withSandbox()` when callback-style lifecycle management is required or uncompiled JavaScript runs on Node.js 22.
- Use Local when no hosted runtime is required. Select a cloud provider from the compatibility table when persistence, previews, native Linux, GPUs, or provider-specific features matter.
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
