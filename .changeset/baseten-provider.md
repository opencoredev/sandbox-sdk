---
"@opencoredev/sandbox-sdk": minor
---

Add the Baseten Sandboxes provider, `baseten()` from `@opencoredev/sandbox-sdk/baseten`. It calls Baseten's HTTP API directly, so it needs no peer package. It reads `BASETEN_API_KEY` and optional `BASETEN_TEAM_ID`, `BASETEN_SANDBOX_REGION` and `BASETEN_API_URL`, and trades the key for a short-lived sandbox access token. It supports commands with live log streaming, files, size presets and exact sizes of one vCPU per 2048 MB, `timeoutMs` and `idleTimeoutMs` in whole seconds, and private previews with an expiring token in the URL.
