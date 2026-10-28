# Getting started

Two small scripts that run with no account.

- `src/quickstart.ts` uses the in-process `memory` provider: files, a command, streamed output, a timeout, a background process with log readiness, and a `SandboxError`.
- `src/multi-provider.ts` picks the provider from `SANDBOX_PROVIDER` and runs the same code on it. It defaults to `memory`, and pauses and resumes only when the provider supports it.

## Run them

From the repository root:

```sh
bun install
bun run --cwd packages/sdk build
cd examples/getting-started
bun run quickstart
bun run multi-provider
SANDBOX_PROVIDER=local bun run multi-provider   # needs Docker; pulls node:22-bookworm the first time
SANDBOX_PROVIDER=e2b E2B_API_KEY=... bun run multi-provider
```

Cloud providers need their peer package and credentials. The [package README](../../packages/sdk/README.md#providers) lists both for each provider.
