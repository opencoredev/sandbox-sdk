# Changelog

## 1.3.0

### Minor Changes

- f56d72e: Add the Archil provider, `archil()` from `@opencoredev/sandbox-sdk/archil`. It runs Archil sandboxes through Archil's official `disk` SDK (1.12.1 or later), an optional peer, because Archil runs processes over a WebSocket protocol that `fetch` cannot carry. It supports commands with separate stdout and stderr and stdin, files, listing and reconnect, public preview URLs, pause and resume with memory, a terminal, network policies (`"none"` and allow lists, on paid plans; free-plan sandboxes have no outbound access), and `size` presets (small 1 vCPU / 2048 MiB, medium 2 / 4096, large 4 / 8192) and exact sizes of 1 to 32 whole vCPUs and 256 to 65536 MiB. With no `size`, a sandbox gets Archil's own default of 1 vCPU and 2048 MiB on `node:24-bookworm`. Keys are exact, because Archil names are unique per account; labels are stored in a marker file in the sandbox, so `listSandboxes` and `reapSandboxes` leave out a paused or stopped sandbox until it runs again (its marker can't be read without waking it); `connectSandbox` by ID still works without waking it, and reopening by `key` wakes and verifies it. A new optional provider flag, `readsMetadataOnlyWhenRunning`, tells the core this: it reopens such a keyed sandbox through `find`, idle-only reaping leaves a sleeping one alone instead of waking it, and `await using` on a handle connected while it slept closes it rather than destroying it. `CreateInput.secretNames` and `Provider.recordsSecretNames` let an adapter write the secret-names record itself before it publishes readiness; only Archil uses them. `timeoutMs` takes 60 seconds to 24 hours and `idleTimeoutMs` up to 24 hours, both in whole seconds, and both pause the sandbox when they fire, as does Archil's 30-minute default idle timeout; a command on a paused sandbox fails with `unavailable` until `box.resume()`. There are no snapshots, templates or disk size (the root disk is fixed), so `from` and `diskGb` fail with `unsupported`. A refusal for the plan's concurrent-sandbox cap is reported as `quota`. `box.native` returns the `disk` `Sandbox` and `Archil` client. When bundling, keep `disk` external: it loads `undici` at run time, and an inlined `disk` fails with `unavailable` saying so. Set `ARCHIL_API_KEY`, and `ARCHIL_REGION` for a key outside `aws-us-east-1`, and optionally pass `image` (a public OCI reference) or `imageId`.

## 1.2.0

### Minor Changes

- 9b43183: Add the Beam provider, `beam()` from `@opencoredev/sandbox-sdk/beam`. It runs Beam Sandboxes through Beam's official `@beamcloud/beam-js` SDK (1.1.6 or later), an optional peer. It supports commands, files (files over Beam's gateway limits move in pieces), listing and reconnect, public preview URLs, memory snapshots and restore, and `size` presets (small 1 vCPU / 2048 MiB, medium 2 / 4096, large 4 / 8192) and exact sizes in whole vCPUs and MiB. With no `size`, a sandbox gets Beam's own default of 1 vCPU and 128 MiB. Keys are best-effort, stored in a marker file in the sandbox. A sandbox lives for `timeoutMs`, or `keepWarmSeconds` (default 3600) when none is given, counted from creation. There is no pause, network policy, disk size or terminal, and Beam snapshots never expire and cannot be deleted. `box.native` is a `NativeApi` on Beam's gateway with the adapter's token (`{containerId}` fills itself), plus the container and stub IDs. Because `@beamcloud/beam-js` keeps one global client, one process can use one Beam token, workspace and gateway; a provider for another account is refused, and the account is checked again before every fresh create. Set `BEAM_TOKEN` and `BEAM_WORKSPACE_ID`, and optionally pass `image`, `gatewayUrl` and `requestTimeoutMs`. beam-js's create requests follow the `requestTimeoutMs` of the first provider that creates, since it keeps one client, except its image builds.

## 1.1.0

### Minor Changes

- 62bd329: Add the Baseten provider, `baseten()` from `@opencoredev/sandbox-sdk/baseten`. It runs Baseten Sandboxes through Baseten's official `@basetenlabs/sandbox` SDK (0.5.0), an optional peer. Keys are exact (unique sandbox names). It supports `size` presets and the exact sizes 1 vCPU / 2048 MiB, 2 / 4096 and 4 / 8192 (Baseten sets CPU from memory), `timeoutMs` and `idleTimeoutMs` as Baseten lifecycle policies, public preview URLs without declared ports, and a `volume` option that creates, mounts and deletes a volume per sandbox, for workspaces too large to keep in memory. There is no pause call: Baseten puts an idle sandbox on standby by itself and resumes it on the next request. There are no snapshots, network policies or terminal, and outbound traffic is IPv6-only. Set `BASETEN_API_KEY`, and optionally pass `teamId`, `image`, `region` and `readyTimeoutMs`.
- a40e3b6: Add the Instabox provider, `instabox()` from `@opencoredev/sandbox-sdk/instabox`. It runs Instabox machines (InsForge's Firecracker microVMs) through Instabox's REST API, with no peer package. It supports commands streamed over server-sent events, files, background processes, public previews, pause and resume with memory, snapshots and `deleteSnapshot`, `size` presets (2/4, 4/8 and 8/16 vCPU/GiB) and exact sizes the plan offers, `idleTimeoutMs` (5 to 30 minutes) and `timeoutMs` (1 minute to 24 hours). Keys are best-effort, stored as a metadata label. `/workspace` links to the persistent 20 GiB `/data` disk. Errors keep Instabox's HTTP status, error code and request ID, never its message.
- 592c85a: Add the Modal provider, `modal()` from `@opencoredev/sandbox-sdk/modal`. It runs Modal Sandboxes through Modal's official `modal` SDK (0.11.1 or later), an optional peer. Keys are exact (unique sandbox names within one Modal App). It supports `size` presets and exact CPU and memory (request and limit pinned together), `network: "none"` and allow lists of domains, wildcards, IPs and CIDRs, declared preview ports, `timeoutMs` and `idleTimeoutMs` in whole seconds, file-system snapshots with `expiresInMs`, `deleteSnapshot()`, and `buildTemplate()` for Modal images. There is no pause or terminal. Set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, and optionally `MODAL_SANDBOX_REGION`.
- aeae333: Add provider extensions (`box.ext`) for provider-specific features, and two provider-level capabilities with root functions: `deleteSnapshot(provider, id)` (`"snapshot-delete"`) and `buildTemplate(provider, spec)` (`"templates"`). E2B implements both, plus a PTY `box.terminal()`, native `files.watch` events through envd, and its metrics in `box.usage()` and `box.ext.e2b.metrics()`. `box.usage()` gains optional `cpuCount`, `cpuPercent`, `memoryBytes`, `memoryLimitBytes`, `diskBytes`, `diskLimitBytes` and `metricsAt` fields. Requests the SDK sends now carry `User-Agent: sandbox-sdk/<version>`. `/provider` now exports `SandboxError`, the error helpers and the Connect stream codec, so an adapter can live in its own package; the E2B adapter imports from nothing else. For adapter authors: `terminal()` receives `cwd` and `env`, and `Terminal` gains an optional `wait()`.

### Patch Changes

- 7d571e0: boxd failures carry the gRPC status, boxd's reason and request ID, and, for control-plane calls, boxd's message, in the error's cause. Error codes and messages are unchanged. Supports `@boxd-sh/sdk` 0.3.x.
- 592c85a: boxd: `listSandboxes()` and `reapSandboxes()` no longer read the guest of a suspended or hibernated machine, which woke it, and boxd bills a woken machine. A keyless machine without custom labels is read from its name in any state. A sleeping machine created with a key, custom labels or `from` is left out of the listing until it runs again, because its labels are only in its guest; the new `listSleeping()` on the boxd provider returns those machines without waking them. `reapSandboxes({ idleOnly: true })` still runs an activity check in each listed sandbox, which wakes a sleeping keyless one. Finding a sandbox by key still reaches a sleeping one, and reads sleeping machines only when no running machine has the key.
- c0be02d: Daytona: a buffered run whose large output is still downloading when its deadline passes now returns `timedOut: true` instead of sometimes rejecting with a `timeout` error from the download request, and a forward wall-clock step no longer cuts that download short.
- e3d6dd7: Tenki is now Luxor Agent Cloud. Error messages and docs from the `tenki()` adapter say Luxor, and its doc links point to luxor.ai. Nothing else changes: the `tenki()` factory, the `@opencoredev/sandbox-sdk/tenki` import path, the `@tenkicloud/sandbox` peer package and the `TENKI_*` environment variables keep working, as Luxor still supports them.
- 592c85a: Vercel: restoring a snapshot this provider took, with no `size`, now starts the sandbox with the source's vCPUs instead of Vercel's 2 vCPU default. A restore of a snapshot taken by another provider instance still gets Vercel's default.

## 1.0.3

### Patch Changes

- 83ff7b9: Commands add less overhead on top of each provider's own SDK. Freestyle and Superserve keep one guest supervisor per sandbox instead of starting Python for every command. boxd, Freestyle, Superserve and Tenki supervisors start faster. E2B and Upstash no longer wrap each command in an activity script; `reapSandboxes({ idleOnly: true })` finds running commands by scanning for the `SANDBOX_SDK_RUN=1` tag instead, and still treats a sandbox it can't inspect as busy. On E2B and Upstash, `files.edit` takes one call and changes the file the way that provider's own write does: in place on E2B, by replacing it on Upstash. `files.search` takes one call wherever the guest can walk files in the provider's own listing order (E2B, Upstash, boxd, Freestyle, Superserve, Tenki, Boat, Sandboxer and local), so `maxMatches` returns the same files as before; elsewhere it lists and reads as before. Upstash creates poll for readiness every 200 ms, honor `requestTimeoutMs`, ride out transient errors while the new box boots, and report `outcome_unknown` when the create answer is lost or unreadable, or when cleanup after a failed create can't be confirmed. A create whose first read of the new box stalls or keeps failing stops at the create deadline or `requestTimeoutMs`, deletes the box and reports `timeout`, or `aborted` when the caller cancels. If the guest call behind `files.edit` fails after it may have run, the edit reports `outcome_unknown`, so read the file before retrying; failures that prove nothing ran keep their own code.

## 1.0.2

### Patch Changes

- 4ca73cd: Internal cleanup with no API change: request bodies, headers and error fields are built explicitly instead of through conditional spreads, so an undefined header value can never be sent as the string "undefined".

## 1.0.1

### Patch Changes

- 1970429: Daytona snapshots that end in `error` or `build_failed` now reject instead of reporting success, and Daytona buffered reads honor `requestTimeoutMs` after headers arrive. `box.native.fetch()` applies `timeoutMs` to the wait for headers rather than the whole stream, an already-expired deadline no longer sends a request, and a failed kill during E2B startup cancellation now destroys the sandbox instead of reporting a clean timeout.

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
