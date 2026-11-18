---
"@opencoredev/sandbox-sdk": minor
---

Add the Instabox provider, `instabox()` from `@opencoredev/sandbox-sdk/instabox`. It runs Instabox machines (InsForge's Firecracker microVMs) through Instabox's REST API, with no peer package. It supports commands streamed over server-sent events, files, background processes, public previews, pause and resume with memory, snapshots and `deleteSnapshot`, `size` presets (2/4, 4/8 and 8/16 vCPU/GiB) and exact sizes the plan offers, `idleTimeoutMs` (5 to 30 minutes, or 0) and `timeoutMs` (1 minute to 24 hours). Keys are best-effort, stored as a metadata label. `/workspace` links to the persistent 20 GiB `/data` disk. Errors keep Instabox's HTTP status, error code and request ID, never its message.
