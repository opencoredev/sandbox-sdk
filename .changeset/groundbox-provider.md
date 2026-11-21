---
"@opencoredev/sandbox-sdk": minor
---

Add the Groundbox provider, `groundbox()` from `@opencoredev/sandbox-sdk/groundbox`. It runs Groundbox sandboxes (Linux VMs on dedicated cores) through Groundbox's REST API, with no peer package. It supports commands (one request when awaited, a WebSocket stream when iterated), files, background processes, private previews with a token header (or public ones with `publicPreviews`), pause and resume with memory, snapshots and `deleteSnapshot`, `buildTemplate`, `terminal()`, network policies (`"none"` and allow lists), `size` presets (2/4, 4/8 and 8/16 vCPU/GiB) and exact sizes in whole vCPUs and GiB with a disk size, `idleTimeoutMs` and `timeoutMs`. `box.ext.groundbox.fork()` copies a running sandbox. Keys are best-effort, stored as a metadata label. Errors keep Groundbox's HTTP status, error code and request ID, never its message.
