---
"@opencoredev/sandbox-sdk": minor
---

Add provider extensions (`box.ext`) for provider-specific features, and two provider-level capabilities with root functions: `deleteSnapshot(provider, id)` (`"snapshot-delete"`) and `buildTemplate(provider, spec)` (`"templates"`). E2B implements both, plus a PTY `box.terminal()`, native `files.watch` events through envd, and its metrics in `box.usage()` and `box.ext.e2b.metrics()`. `box.usage()` gains optional `cpuCount`, `cpuPercent`, `memoryBytes`, `memoryLimitBytes`, `diskBytes`, `diskLimitBytes` and `metricsAt` fields. Requests the SDK sends now carry `User-Agent: sandbox-sdk/<version>`. `/provider` now exports `SandboxError`, the error helpers and the Connect stream codec, so an adapter can live in its own package; the E2B adapter imports from nothing else. For adapter authors: `terminal()` receives `cwd` and `env`, and `Terminal` gains an optional `wait()`.
