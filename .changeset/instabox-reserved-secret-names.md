---
"@opencoredev/sandbox-sdk": patch
---

Instabox refuses a secret whose name Instabox reserves for the machine environment (such as `SSH_*`, `INSTABOX_*` or `PATH`) with `invalid_argument`, since a reconnect could not recover its value. Adapters now receive `CreateInput.secretNames` whether or not they record the names themselves.
