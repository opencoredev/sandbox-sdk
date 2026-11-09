---
"@opencoredev/sandbox-sdk": minor
---

Add the Modal provider, `modal()` from `@opencoredev/sandbox-sdk/modal`. It runs Modal Sandboxes through Modal's official `modal` SDK (0.11.1 or later), an optional peer. Keys are exact (unique sandbox names within one Modal App). It supports `size` presets and exact CPU and memory (request and limit pinned together), `network: "none"` and allow lists of domains, wildcards, IPs and CIDRs, declared preview ports, `timeoutMs` and `idleTimeoutMs` in whole seconds, file-system snapshots with `expiresInMs`, `deleteSnapshot()`, and `buildTemplate()` for Modal images. There is no pause or terminal. Set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, and optionally `MODAL_SANDBOX_REGION`.
