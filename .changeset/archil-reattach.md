---
"@opencoredev/sandbox-sdk": patch
---

Archil: a command whose process connection Archil closes before the exit event arrives (seen when a command prints a few hundred KB, such as a `cat` of a large file run more than once on a sandbox) now returns its exit code and every output byte, instead of failing with `outcome_unknown`. The adapter reconnects to the process by ID from the next undelivered byte, which replays the rest of the output and reports the exit, up to three times; only if that fails is the command stopped and reported as before. File helpers get the same recovery.
