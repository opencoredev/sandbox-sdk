# Sandbox SDK v1 design contract

Status: **frozen for implementation**
Date: 2026-08-18
Target release: `@opencoredev/sandbox-sdk@1.0.0`
Product name: **Sandbox 2**

This document freezes Sandbox 2. It supersedes earlier discovery notes where they
conflict. A scope change needs an explicit amendment that records API, migration,
test, documentation, package, and release consequences together.

Source plan: Linear project
[Sandbox 2](https://linear.app/opencoredev/project/sandbox-2-8a3ea771849a).
Public drop `1f7e7f15-c2fa-4092-b4a3-8d7ea8d3a118` expired; this file is the
surviving contract.

## Amendment 1: honesty release

The honesty work ships in `1.0.0`, not a separate `0.2.1`. LEO-100 was canceled
because the honesty and Sandbox 2 changes share one working tree and splitting
them would create a patch release that users do not receive. This amendment does
not change the API, migration path, tests, documentation claims, or package
contents. Release gates cover the combined cut.

## 1. Identity

| Item | Lock |
| --- | --- |
| Repository | Same repo, `opencoredev/sandbox-sdk` |
| Package | `@opencoredev/sandbox-sdk` |
| Site | https://sandbox-sdk.app |
| Skill slug | `sandbox-sdk` |
| License | MIT |
| Owner | OpenCore |
| Product name | Sandbox 2 |
| npm version | `1.0.0` |
| Public 0.3 | Do not ship |

Honesty work lands in `1.0.0` under Amendment 1. Unreleased DX that already
exists on disk (`sandbox.$`, `runCode`, git helpers, connect, watch) is folded
into Sandbox 2. Do not cut a public 0.3.

## 2. Product boundary

Sandbox SDK is a server-side TypeScript library. It gives one normalized API
across sandbox adapters. The application still chooses the provider, owns that
account, and supplies credentials.

It does **not** own:

- hosted sandbox compute
- billing or quotas
- a public REST, OAuth, or MCP control plane
- identical behavior across adapters

Runtime floor:

- Node.js `>=22 <26`
- Bun `>=1.3`
- ESM only
- No browser credential use

## 3. Chosen public API

### 3.1 Happy path

```ts
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using sandbox = await e2b().create();
await sandbox.$`node --version`;
```

`createSandbox({ provider })` and `withSandbox()` stay for this major.

```ts
import { createSandbox, withSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using sandbox = await createSandbox({ provider: e2b() });
```

Factory `create()` returns a `Sandbox`. Adapter internals keep `createRuntime()`
for the normalized wrapper. `createSandbox()` calls `createRuntime` when present
and otherwise the 0.2 `create()` that returns a `SandboxRuntime`.

### 3.2 Lifecycle

| Method | Meaning |
| --- | --- |
| `stop()` | Idempotent. Pause, disconnect, or release the session. State may remain. |
| `destroy()` | Permanent delete. Idempotent after the first success. |
| `[Symbol.asyncDispose]` | Calls `stop()`, never `destroy()`. |
| `withSandbox()` | Calls `stop()` after the callback. |

A shared Vercel sandbox must not be deleted by `stop()`. Unsupported lifecycle
methods throw `SandboxError` with code `unsupported` before pretending.

### 3.3 Adapter ids

`ProviderName` is `string`. Built-in names stay documented as
`builtInProviderNames`. A third-party adapter must not edit that list.

Published authoring types from the package root:

- `SandboxProvider`
- `SandboxRuntime`
- `SandboxAdapter`
- `defineAdapter()`
- capability types

The conformance suite is the public contract. Every required case has a skip
reason when unsupported. A fake in-repo adapter that is not in the built-in list
must pass the required cases.

### 3.4 Capability gating

Methods that a runtime cannot perform throw `SandboxError` with code
`unsupported` before any provider call. The stable `ports`, `snapshots`, and
`processes` objects stay present for consistent TypeScript DX, but they never
fake success when the capability is false.

Normalized sugar (`$`, `runCode`, git, `stat`/`move`/`copy`/`watch`) may use
`run`/`files` on every adapter that can execute commands. Native overrides are
optional on `SandboxRuntime`.

### 3.5 Core surface

Required on every sandbox:

- `id`, `provider`, `cwd`, `capabilities`, `raw`
- `files` read/write/list/mkdir/remove/exists
- `run`
- `stop`, async disposal

Present when the capability allows, otherwise throw `unsupported`:

- `processes.start`
- `ports.expose`
- `snapshots.*`
- `extendTimeout`
- `connect` / `list` (factory or package helpers)
- `pty.create`
- `setNetworkPolicy`
- `metrics`

Always-available sugar, implemented once in core:

- `sandbox.$`
- `sandbox.runCode`
- `sandbox.git.clone|pull|checkout|status`
- `files.stat|move|copy|writeMany|upload|download|watch`
- `sandbox.info()` (id, provider, cwd, plus native fields when present)

`sandbox.run(cmd, { onStdout, onStderr })` streams when `process.stream` exists
and otherwise calls back once with the collected output.

### 3.6 Errors

All SDK-owned failures use `SandboxError` and the closed `sandboxErrorCodes`
union. `CommandFailedError` is the strict-command subclass. Messages redact
tokens, keys, and credential-bearing URLs.

## 4. Provider program

Harden the seven shipped adapters: Local, E2B, Daytona, Vercel, Upstash, Ascii
Box, Railway.

Add:

- `memory()` — in-process testing adapter. Not an isolation boundary.
- Cloudflare — only if the official API supports files and exec at
  implementation time.
- Modal — same gate.

Decide:

- CreateOS (PR #9): live-test then merge, or close with a written reason.
- Blaxel (closed PR #5): ship only if the official SDK still exists and
  capabilities stay honest.

Investigate, do not ship from the investigation issue: Runloop, Morph, Fly
Machines, Northflank, CodeSandbox, Beam.

Reject without a public API: Agent37, Islo.

A new adapter cannot ship without metadata, capabilities, example, docs page,
tests, and a package export.

## 5. Docs, site, CLI, skill

Docs IA:

1. Overview
2. Comparison
3. Install
4. First sandbox
5. Operations
6. Adapters
7. Integrations
8. Guides
9. Reference

Landing page jobs: one-sentence product, install, happy-path snippet using
`e2b().create()`, adapter switchboard with honest capability chips, limits in
one scroll. No dark-gradient card stack as the product.

Banned claims:

- “every sandbox provider”
- identical behavior across adapters
- “any provider” for managed integrations
- live-tested without a dated `liveTest` row
- Local is an unrestricted host shell
- Railway was live-tested (unless a dated row exists)

CLI (`sandbox-sdk`): `adapters`, `doctor` (no live spend by default), `run`,
`capabilities`.

The installable skill and `llms.txt` describe Sandbox 2. Every docs snippet
compiles against the built package.

## 6. Integrations

Eve, Mastra, and AI SDK Harness stay adapter-gated. Railway is not eligible
until its managed/process surface matches. Do not say “any provider” on those
pages.

## 7. Live tests and release

Live tests stay out of `bun test`. Each shipped adapter has either a dated
`liveTest` row or an explicit `liveTest: null` that docs repeat.

1.0.0 gate:

- package build and typecheck
- unit, type, and old-import tests
- docs build and compiled snippets
- compatibility for every renamed public identifier
- dated live results or an explicit untested row
- GitHub Release object
- landing page matches shipped claims

Do not publish, push, or create the GitHub Release from an agent session unless
Leo asks in that message.

## 8. Amendments

Record amendments below. Do not silently expand scope.

| Date | Change | Consequence |
| --- | --- | --- |
| 2026-08-18 | Initial freeze from the Sandbox 2 plan and Leo's override that new adapters and a landing rewrite are in scope. | Implementation may proceed. |
| 2026-08-18 | Fold the honesty pass into 1.0.0 instead of a separate 0.2.1. Keep capability-gated objects stable and fail closed. | One combined release; no public 0.2.1 or 0.3. |
