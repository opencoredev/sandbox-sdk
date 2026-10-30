---
"@opencoredev/sandbox-sdk": patch
---

Internal cleanup with no API change: request bodies, headers and error fields are built explicitly instead of through conditional spreads, so an undefined header value can never be sent as the string "undefined".
