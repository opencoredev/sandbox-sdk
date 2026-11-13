---
"@opencoredev/sandbox-sdk": patch
---

Daytona: a buffered run whose large output is still downloading when its deadline passes now returns `timedOut: true` instead of sometimes rejecting with a `timeout` error from the download request, and a forward wall-clock step no longer cuts that download short.
