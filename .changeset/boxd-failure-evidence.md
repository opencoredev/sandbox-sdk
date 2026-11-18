---
"@opencoredev/sandbox-sdk": patch
---

boxd failures carry the gRPC status, boxd's reason and request ID, and, for control-plane calls, boxd's message, in the error's cause. Error codes and messages are unchanged. Supports `@boxd-sh/sdk` 0.3.x.
