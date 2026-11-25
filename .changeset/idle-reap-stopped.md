---
"@opencoredev/sandbox-sdk": patch
---

`reapSandboxes({ idleOnly: true })` counts a stopped sandbox as idle without probing it, so a stopped sandbox no longer makes the sweep fail, and one that would start on a command is not started to check.
