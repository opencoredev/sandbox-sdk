# Sandbox SDK DX overhaul plan

Working plan for making this SDK's developer experience match or beat every native
provider SDK. Grounded in the actual type surfaces of `e2b`, `@vercel/sandbox`, and
`@daytona/sdk` in `node_modules`.

## Design principle

Implement sugar once in the core on top of `run`/`files` so all providers get it with no
per-provider work (`src/core/extensions.ts`). Providers may override with native
implementations through optional `SandboxRuntime` methods.

## Contract

Sandbox 2 is frozen in `docs/v1-design-contract.md`. The public drop expired;
that file is the surviving source.

## Shipped

- `sandbox.$` tagged template with safe interpolation; throws `CommandFailedError`.
- `sandbox.run(cmd, { onStdout, onStderr })` streaming callbacks with graceful fallback.
- `sandbox.runCode(code, { language })` for python/javascript/typescript/bash.
- `sandbox.git.clone(url, { branch, depth, auth })` with token redaction.
- `files.stat/move/copy/writeMany/upload/download` with shell fallbacks and optional
  native overrides in the provider contract.
- Tests in `packages/sdk/tests/core/dx.test.ts`; examples `shell-tag.ts`, `run-code.ts`,
  `git-clone.ts`; README and CHANGELOG updated.
- **Sandbox lifecycle parity**: `connectSandbox({ provider, id })`, `listSandboxes(provider)`,
  and `sandbox.extendTimeout(ms)` with capabilities `sandbox.connect`/`sandbox.list`/
  `sandbox.timeout`. Native on E2B (`connect`/`list`/`setTimeout`), Vercel
  (`get`/`list`/`extendTimeout`), and Daytona (`get`/`list`). Providers were refactored so
  runtime construction is reusable (`buildRuntime`). Tests in `tests/core/lifecycle.test.ts`;
  example `reconnect.ts`.

- **File watching**: `files.watch(path, onEvent, { recursive, pollInterval })` returning
  an async-disposable watcher. Native `watchDir` on E2B; `find`+`stat` polling fallback
  elsewhere.
- **Native overrides**: `files.stat`/`files.move` use native E2B (`getInfo`/`rename`) and
  Vercel (`lstat`/`rename`) implementations.
- **Git sugar**: `git.pull()` and `git.checkout(ref)` on every provider.
- **Sandbox 2 factory**: `adapter.create()`, `defineAdapter()`, open adapter ids.
- **`stop()` vs `destroy()`**. Disposal still calls `stop()`.
- **`memory()`** in-process testing adapter.
- **`sandbox.info()` / `metrics()` / `pty.create()` / `setNetworkPolicy()`**.
- **`git.status()`** and clone-at-create (`source: { git }`).
- Docs pages for git, memory, `$`/`runCode`, file extras, and the new happy path.
- Capability gating before runtime calls; characterization tests; conformance skip reasons.
- Community adapter `community-test` passes required conformance cases.
- Managed resume honors `AbortSignal`.
- Opt-in lifecycle hooks with redaction.
- `sandbox-sdk` CLI: adapters, doctor, capabilities, memory run.

## Backlog (priority order)

1. **Harden remaining adapters** (LEO-110) — confirm every stop/destroy mapping against
   native SDKs; fail closed on fake ports/snapshots.
2. **CLI** (LEO-111) — `sandbox-sdk adapters|doctor|run|capabilities`.
3. **Hooks** (LEO-112) — `onCreate`/`onRun`/`onError`/`onStop`/`onDestroy`.
4. **Docs rewrite + landing** (LEO-103, LEO-115) — Email-SDK ramp and switchboard homepage.
5. **Modal** (LEO-120) — deferred. Cloudflare (LEO-108) shipped as a Worker-binding adapter.
6. **CreateOS / Blaxel decisions** (LEO-109, LEO-113).
7. **Live-test evidence** (LEO-116). Do not publish 1.0.0 from an agent session.

## Blocked

- The agent-drop spec (`agent-drop.co/1f7e7f15-...`) is gone: server returns
  `card: null`, page renders "This page is gone", no Wayback capture. Need the owner to
  repost or paste the content.
