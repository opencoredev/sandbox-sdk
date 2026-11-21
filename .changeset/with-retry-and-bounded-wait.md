---
"@opencoredev/sandbox-sdk": minor
---

Add `withRetry(action, options)`, which retries while `error.retryable` is `true` and waits the longer of a full-jitter exponential backoff and the new `SandboxError.retryAfterMs` (the provider's `Retry-After`, set by adapters that call its HTTP API directly). `ProcessHandle.wait()` takes `{ timeoutMs, signal }` and now gives up with `timeout` after 30 minutes by default instead of polling forever; the process keeps running. `local()` takes `apiTimeoutMs` (default 600000) for slow image pulls. `Provider.find` receives the create's `{ signal }`, and `createSandbox` stops waiting on a hung lookup when it fires. `createSandbox` now rejects custom adapters that implement optional capability methods (`pause`, `snapshot`, `terminal`, `deleteSnapshot`, `buildTemplate`) without declaring the matching capability, and `files.read` now preserves a leading UTF-8 BOM so `files.edit` does not strip it.
