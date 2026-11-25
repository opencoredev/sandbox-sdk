---
"@opencoredev/sandbox-sdk": patch
---

The core redacts a sandbox's secrets in boxd's control-plane error message before that message is scrubbed, so a multiline secret echoed there is redacted whole. The message on the adapter's own error stays scrubbed.
