# Changelog

## 1.0.0-beta.0

First preview of the 1.0 rewrite, published under the `next` tag. The SDK was rewritten from scratch; most of the 0.2 surface changed. The API may still change before 1.0.0. The [upgrade guide](https://github.com/opencoredev/sandbox-sdk/blob/main/apps/docs/content/upgrade-from-0-2.mdx) maps every 0.2 call to its 1.0 form.

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
