# Changelog

## 1.0.0

### Major Changes

- 8b7214a: Sandbox SDK 1.0: one TypeScript API for 14 sandbox providers (E2B, Daytona, Vercel Sandbox, Upstash Box, Railway, Boat, Sandboxer, Tenki, boxd, Freestyle, Superserve, local Docker, agentOS, and an in-memory fake), with typed capabilities, background processes, previews, files, git, and agent tools for the AI SDK, Mastra, and OpenAI Agents. 1.0 is a rewrite; see the upgrade guide at https://sandbox-sdk.app/docs/upgrade-from-0-2 when coming from 0.2.

  Since 1.0.0-beta.1:

  E2B, Daytona, Freestyle, Superserve, Boat, and Sandboxer now call their provider's HTTP API directly, so `npm i @opencoredev/sandbox-sdk` is the whole install for them. `e2b`, `@daytonaio/sdk`, `freestyle`, `@superserve/sdk`, and `@boatdev/sdk` are no longer peer dependencies. On these providers `box.native` is a `NativeApi` (`request`, `fetch`, `sdk`), and `box.native.sdk(() => import("<package>"))` still gives you the official SDK's object if you install it yourself. Vercel, Upstash Box, Railway, Tenki, boxd, and agentOS still need their SDK. The bullets below cover each provider's migration.

  - **Breaking for Daytona:** `daytona()` calls Daytona's HTTP API directly, and `@daytonaio/sdk` is no longer a peer dependency, so `npm i @opencoredev/sandbox-sdk` is the whole install. File transfers use Web `FormData` and a built-in multipart reader, so bundled apps no longer need `form-data` or `busboy`, and the `codeRun` transfer fallback is gone. `box.native` is now a `NativeApi` with `"api"` and `"toolbox"` planes instead of the SDK's `Sandbox`: call `box.native.request(...)`, or `await box.native.sdk(() => import("@daytonaio/sdk"))` to keep using the SDK. `daytona().api` makes account-level calls. A create that fails after Daytona made the sandbox now always deletes it, including one whose create request got no answer.
  - `superserve()` calls Superserve's HTTP API directly, so `@superserve/sdk` is no longer a peer: `npm i @opencoredev/sandbox-sdk` is the whole install. Breaking for beta users: `box.native` is now a `NativeApi` (`request`, `fetch`, `sdk`) instead of the SDK's `Sandbox`. Get the old object with `await box.native.sdk(() => import("@superserve/sdk"))`. A stdin-free run whose connection drops after the command started now rejects with `outcome_unknown` instead of `provider`.

  - `e2b()` calls E2B's API and each sandbox's envd daemon over HTTP, so `e2b` is no longer a peer dependency: `npm i @opencoredev/sandbox-sdk` is the whole install. Options, defaults and behaviour are unchanged. Control-plane reads and the idempotent `connect`, `timeout` and `pause` calls retry on 429, 502, 503 and 504; a create whose response is lost is `outcome_unknown`. Every command start carries a tag, so a cancelled start, or one whose response was lost, is found and stopped. **Breaking for beta users:** `box.native` is now a `NativeApi` with the `"api"` and `"envd"` planes and the `{sandboxId}` placeholder, and `e2b().api` makes account calls. For the official SDK's `Sandbox`, install `e2b` and call `await box.native.sdk(() => import("e2b"))`.
  - **Breaking for Freestyle:** `freestyle()` calls Freestyle's API directly, so `npm i @opencoredev/sandbox-sdk` is the whole install and the `freestyle` package is no longer a peer. `box.native` is now a `NativeApi` (`request`, `fetch`, `sdk`) instead of the SDK's `Vm`. Replace `box.native.exec(...)` with `(await box.native.sdk(() => import("freestyle"))).exec(...)` after installing `freestyle` yourself, or call the endpoint with `box.native.request("POST", "/v5/vms/{vmId}/exec-await", { body })`. `freestyle().api` makes account-level calls. Background requests (HTTP 202 polling), ranged reads and chunked uploads over 8 MiB work as they did with the SDK. A create aborted by its signal no longer cuts the request, so a VM Freestyle allocates anyway is deleted instead of left running.
  - `boat()` and `sandboxer()` call their API over plain HTTP. `@boatdev/sdk` is no longer a peer: `npm i @opencoredev/sandbox-sdk` is the whole install. Breaking for beta users: `box.native` is now a native API (`request`, `fetch`, `sdk`) instead of `{ sandbox, client }`. Get the old pair with `await box.native.sdk(() => import("@boatdev/sdk"))` after installing `@boatdev/sdk` yourself, and the account client with `boat().api.sdk(...)`. Sandboxer keeps `box.native.region`, `regionSource` and `createSnapshot(name)`.
  - On these six providers, credential headers you pass to `box.native` (`authorization`, `cookie`, `*-token`, `*-key`) are never sent to another origin or followed through a redirect, and an error that echoes one shows it redacted. A command whose output stream breaks after it started rejects with `outcome_unknown`, and a write is never sent twice after a credential refresh unless the server refused it first. A Boat or Sandboxer create stays within `requestTimeoutMs` across its retries.

## 1.0.0-beta.1

Fixes from early-adopter reports, provider options that were missing, and bundler support. Published under the `next` tag.

### Fixed

- Provider SDKs load inside bundles. CommonJS peers imported from an esbuild, webpack or Next.js bundle no longer fail with `X is not a constructor`, and error mapping no longer depends on class names that minifiers rename. boxd transfers and Daytona file operations work in bundles too. An ESM bundle without a `require` shim fails with an `unavailable` error that says how to fix it.
- Errors keep a redacted `cause`, and messages say what went wrong instead of "The provider reported provider". URLs, auth headers and credential-like values are scrubbed from every message and cause.
- `boat()` and `sandboxer()` no longer put stdin or file contents in command strings. Both travel through the file API into a private `0600` staging file.
- `connectSandbox()` no longer runs secret recovery on connect. It runs before the first command, so connecting to a stopped sandbox to destroy it works. Pass `recoverSecrets: false` to skip it.
- `start()` reports a command that exits at once, or a missing `cwd`, as `failed` instead of `running`. A missing `cwd` is a normal failed run (exit 2) on every provider.
- Railway command timeouts kill only the command instead of deleting the sandbox. Railway `list()` includes owned sandboxes that aren't running yet.
- Tenki reports `/workspace` as a directory on a fresh sandbox. boxd and Freestyle report missing files as `file_not_found`. e2b reports exit 143 after `stop()`.
- A local Docker sandbox restored from a snapshot no longer inherits the source's deadlines.
- A Daytona create that times out deletes the half-created sandbox (with `@daytonaio/sdk` 0.227 or later). The Daytona peer range now accepts any 0.x from 0.225.
- A thrown `SandboxError` prints as `SandboxError [code]: message`. `box.run()` returns a real `Promise` with `catch` and `finally`.

### Added

- `files.write(path, data, { mode })` and `files.write(record, { mode })` set POSIX permissions. Providers apply the mode natively where they can; the rest run `chmod` right after the write.
- `box.snapshot({ expiresInMs })`. Providers that can't expire snapshots reject a nonzero value with `unsupported`.
- `vercel()`: `persistent`, `timeoutMs` (per session), `image`, `runtime`, `source` (git or tarball), exact vCPU sizes, `networkPolicy`, `region`, `failoverRegions`, `networkId`, `mounts`, `snapshotExpiresInMs`, `keepLastSnapshots`, `deleteOrphanSnapshots` and `fetch`.
- Native options for the other providers, including e2b `public`, `autoPause`, `autoResume`, `volumes`; Daytona `public`, `autoArchiveMs`, `autoDeleteMs`, `volumes`, `createTimeoutMs`; Upstash `keepAlive`, `browser`, `attachHeaders`; Tenki `pauseRetentionMs`, `volumes`, `workspaceId`, `previewTtlMs`; Railway `resources`; Boat and Sandboxer `ttlSeconds`, `snapshots`, `monitoring`, `org`, and Sandboxer `idleTimeoutMs`; local `platform`, `user`, `runtime`, `networkMode`, `mounts`, `pidsLimit`, `shmSizeMb`, capabilities, `securityOpt` and custom sizes; Superserve network policies, `secretBindings`, `previewAccess`, `autoPauseMs`, `autoDeleteMs`; boxd allow lists, `volumes`, `timeoutMs`, `idleTimeoutMs`; Freestyle `autoDeleteMs` and snapshot expiry; agentOS `software`, `mounts`, `limits`. Each provider page lists them.

## 1.0.0-beta.0

First preview of the 1.0 rewrite, published under the `next` tag. The SDK was rewritten from scratch; most of the 0.2 surface changed. The API may still change before 1.0.0. The [upgrade guide](https://github.com/opencoredev/sandbox-sdk/blob/main/apps/docs/content/upgrade-from-0-2.mdx) maps every 0.2 call to its 1.0 form.

### Unreleased

- Provider options now use `baseUrl` instead of `boxd.baseURL`, `daytona.apiUrl`, and `boat.apiUrl`; `tenki.apiKey` replaces `authToken`, and `boat.machine` replaces `type`. Old names remain deprecated aliases until 1.0.0. When both are supplied, the new name wins.
- Added the Sandboxer provider at `@opencoredev/sandbox-sdk/sandboxer`. It shares Boat's API transport, including deferred workspace setup, and adds pause and resume, named snapshots, cookie-authenticated previews, and a `region` option (`us-east` or `eu-central`, default `SANDBOXER_REGION`, else nearest).
- Provider option hovers document defaults and environment variables. All provider subpaths export a named provider type. Missing-credential errors explain the next step; E2B checks its key on first use and reads environment values set after factory construction.

### Breaking changes since 0.2.0

- `createSandbox(provider, options?)` takes the provider as its first argument instead of `createSandbox({ provider })`. The `cwd` option is gone; every sandbox starts in `/workspace`.
- `stop()` is split into `destroy()`, which deletes the sandbox, and `close()`, which detaches and leaves it running. `await using` calls `close()` for keyed sandboxes and `destroy()` otherwise.
- `run` results: `success` is now `ok`, `timeout` is `timeoutMs` (default 120 s), and a timeout resolves with `timedOut: true` instead of throwing. The `{ command, args }` form is replaced by the `` box.$`...` `` tag.
- `files.text(path)` is now `files.read(path)`; bytes come from `files.read(path, { as: "bytes" })`. `files.mkdir` is gone (`write` creates parents). `write` accepts only strings and `Uint8Array`.
- `processes.start` is now `box.start(command, { name })`. `output()` is replaced by `lines()` and `logs()`, `kill()` by `stop()`, and process stdin writes are removed.
- `ports.expose` is now `box.preview(port)`, which returns `url` plus any required `headers`.
- `snapshots.*` is now `box.snapshot()` and `createSandbox(provider, { from: id })`.
- `local()` runs a Docker container from `node:22-bookworm` instead of a bundled AgentOS VM. AgentOS moved to the optional `/agentos` entry.
- `sandbox.raw` is now `box.native`.
- Removed: the Ascii Box provider, the `/eve` integration, and the helpers `withSandbox`, `supports`, `requireCapability`, `capabilityMode`, `isSandboxError`, and `redactSensitive`. Use `await using`, `box.capabilities.has(...)`, and `error instanceof SandboxError`.
- Node.js 22+ or Bun 1.3+ is required. The package is ESM only.

### Highlights

- Thirteen providers behind one API: E2B, Daytona, Vercel, Upstash Box (durable and ephemeral), Railway, Tenki, boxd, Freestyle, Superserve, Boat, Local (Docker), agentOS, and an in-memory fake for tests.
- Typed capabilities: `pause`, `snapshot`, and `terminal` exist on the sandbox type only when the provider supports them. Options a provider cannot enforce fail with `unsupported` instead of being dropped.
- Keys: `createSandbox(provider, { key })` returns the same sandbox on every call, with an optional `locator` for your own store.
- Secrets passed as `secrets` are redacted from command output, logs, errors, and agent tool results, including after reconnecting.
- Durable named background processes with readiness checks (`port`, `http`, or `log`) and resumable log cursors that survive a server restart.
- Files: `edit`, `search`, `watch`, `upload`/`download`, and `mark`/`changes` diffs, plus `box.git` with token-safe `clone` and `push`.
- Agent tools for AI SDK (`/ai`), Mastra (`/mastra`), and OpenAI Agents (`/openai`), with output budgets, a `root` path guard, and a `beforeRun` command hook.
- `SandboxError` with 15 stable codes, a `retryable` flag, and a `hint` for every code.
- Zero runtime dependencies. The root entry is under 8 KB minified, and provider SDKs load only on first use.
- A shared conformance suite (`/testing`) that every adapter, including third-party ones, can run.
