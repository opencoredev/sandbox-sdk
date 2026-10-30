---
"@opencoredev/sandbox-sdk": patch
---

Daytona snapshots that end in `error` or `build_failed` now reject instead of reporting success, and Daytona buffered reads honor `requestTimeoutMs` after headers arrive. `box.native.fetch()` applies `timeoutMs` to the wait for headers rather than the whole stream, an already-expired deadline no longer sends a request, and a failed kill during E2B startup cancellation now destroys the sandbox instead of reporting a clean timeout.
