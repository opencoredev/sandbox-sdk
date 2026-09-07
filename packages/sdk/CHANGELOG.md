## @opencoredev/sandbox-sdk@1.0.0

Sandbox 2 includes the documentation honesty pass instead of a separate 0.2.1 patch.

- Add experimental `@opencoredev/sandbox-sdk/cloudflare`. `create()` calls official `getSandbox(env.Sandbox, id)`. There is no Node-only create path. `liveTest` is `null`.
- Add a `sandbox-sdk` CLI for `adapters`, `doctor`, `capabilities`, and memory `run`.
- Add opt-in lifecycle hooks (`onCreate`, `onRun`, `onError`, `onStop`, `onDestroy`) that redact tokens and omit file contents.
- Honor `AbortSignal` on managed session resume.
- Gate `run`, processes, ports, and snapshots on advertised capabilities before any runtime call.
- Add required conformance cases, skip reasons, and characterization tests for 0.2 file/command/cleanup behavior.
- Freeze the Sandbox 2 design contract in `docs/v1-design-contract.md`.
- Add `adapter.create()` as the happy path: `await using sandbox = await e2b().create()`.
  `createSandbox({ provider })` remains.
- Open adapter ids to strings. Built-in names stay in `builtInProviderNames`.
- Publish `defineAdapter()`, `SandboxAdapter`, and `createRuntime` for third-party adapters.
- Split `stop()` from `destroy()`. Async disposal still calls `stop()`.
- Add the `memory()` testing adapter (`@opencoredev/sandbox-sdk/memory`). Not a security boundary.
- Add `sandbox.info()`, `sandbox.metrics()`, `sandbox.pty.create()`, `sandbox.setNetworkPolicy()`,
  `git.status()`, and clone-at-create via `source: { git }`.
- Export provider and sandbox creation contracts from the package root.
- Add `sandbox.$`, a tagged template that runs shell commands with safely quoted
  interpolations and throws `CommandFailedError` on nonzero exit.
- Add `sandbox.runCode()` for running Python, JavaScript, TypeScript, or Bash snippets
  without managing temporary files.
- Add `onStdout`/`onStderr` streaming callbacks to `sandbox.run()`, with a single final
  callback as the fallback on providers without process streaming.
- Add `sandbox.git.clone()` with branch, depth, and token auth support. Tokens are
  redacted from error output.
- Add `files.stat()`, `files.move()`, `files.copy()`, `files.writeMany()`,
  `files.upload()`, and `files.download()`. Every provider gets shell-based fallbacks;
  providers can override them with native implementations.
- Add `connectSandbox()` to reattach to a running sandbox by id and `listSandboxes()`
  to enumerate account sandboxes. Supported natively on E2B, Vercel, and Daytona
  (`sandbox.connect` and `sandbox.list` capabilities).
- Add `sandbox.extendTimeout(ms)` for providers with managed lifetimes (E2B, Vercel;
  `sandbox.timeout` capability).
- Add `files.watch()` for directory change events. Native on E2B (`watchDir`), polling
  fallback everywhere else.
- Add `git.pull()` and `git.checkout()`.
- Use native implementations for `files.stat()` and `files.move()` on E2B and Vercel.

## @opencoredev/sandbox-sdk@0.2.0

- Add Ascii Box and Railway Sandbox provider adapters, package exports, capabilities, examples,
  live-test entry points, and provider documentation.
- Normalize HTTP response status codes from provider SDK errors.

## @opencoredev/sandbox-sdk@0.1.1

- Add `Symbol.asyncDispose` to `Sandbox` so `await using` provides automatic cleanup.

## @opencoredev/sandbox-sdk@0.1.0

### Initial release

- Run one TypeScript sandbox API across Local, E2B, Daytona, Vercel Sandbox, and Upstash Box.
- Use normalized files, commands, processes, ports, snapshots, and provider capabilities.
- Integrate sandbox sessions with AI SDK, Harness, Eve, and Mastra.
