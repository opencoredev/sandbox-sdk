---
"@opencoredev/sandbox-sdk": patch
---

boxd: `listSandboxes()` and `reapSandboxes()` no longer wake suspended or hibernated machines, which boxd bills while awake. A sleeping machine created with a key, custom labels or `from` is left out of the listing until it runs again, because its labels are only in its guest; keyless machines without custom labels are still listed while asleep. Finding a sandbox by key still reaches a sleeping one, and reads sleeping machines only when no running machine has the key.
