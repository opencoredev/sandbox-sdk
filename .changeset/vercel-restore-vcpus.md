---
"@opencoredev/sandbox-sdk": patch
---

Vercel: restoring a snapshot this provider took, with no `size`, now starts the sandbox with the source's vCPUs instead of Vercel's 2 vCPU default. A restore of a snapshot taken by another provider instance still gets Vercel's default.
