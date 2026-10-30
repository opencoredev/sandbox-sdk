---
"@opencoredev/sandbox-sdk": patch
---

Commands add less overhead on top of each provider's own SDK. Freestyle and Superserve keep one guest supervisor per sandbox instead of starting Python for every command. boxd, Freestyle, Superserve and Tenki supervisors start faster. E2B and Upstash no longer wrap each command in an activity script; `reapSandboxes({ idleOnly: true })` finds running commands by scanning for the `SANDBOX_SDK_RUN=1` tag instead, and still treats a sandbox it can't inspect as busy. On E2B and Upstash, `files.edit` and `files.search` each take one call. Upstash creates poll for readiness every 200 ms, honor `requestTimeoutMs`, and report `outcome_unknown` with the box ID when cleanup after a failed create can't be confirmed.
