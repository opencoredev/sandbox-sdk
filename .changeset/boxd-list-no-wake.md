---
"@opencoredev/sandbox-sdk": patch
---

boxd: `listSandboxes()` and `reapSandboxes()` no longer read the guest of a suspended or hibernated machine, which woke it, and boxd bills a woken machine. A keyless machine without custom labels is read from its name in any state. A sleeping machine created with a key, custom labels or `from` is left out of the listing until it runs again, because its labels are only in its guest; the new `listSleeping()` on the boxd provider returns those machines without waking them. `reapSandboxes({ idleOnly: true })` still runs an activity check in each listed sandbox, which wakes a sleeping keyless one. Finding a sandbox by key still reaches a sleeping one, and reads sleeping machines only when no running machine has the key.
