---
"@opencoredev/sandbox-sdk": patch
---

Adapters can implement `isStopped(id)` to confirm a sandbox has fully stopped. `reapSandboxes({ idleOnly: true })` then counts such a sandbox as idle without probing it, so it neither fails the sweep nor gets started to check. Microsandbox implements it.
