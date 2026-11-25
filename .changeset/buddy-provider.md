---
"@opencoredev/sandbox-sdk": minor
---

Add the Buddy provider, `@opencoredev/sandbox-sdk/buddy`: Buddy sandboxes (persistent Ubuntu VMs) through Buddy's REST API with no peer package. Exact keys, since a key becomes the sandbox's workspace-unique identifier; labels, the key and secret names stored in the sandbox's note at create and restore; create-time env and secrets as encrypted Buddy variables. Commands run under a `setsid` bridge that frames and spools their output, with secrets, per-run env, stdin and long commands kept out of Buddy's command history, and a timeout or abort kills and confirms the whole process group. Files, previews behind HTTP Basic auth (`public: true` for public ports) that another client reattaches to without a new password, pause and resume as stop and start, fixed sizes from 1x2 to 12x24, the idle timeout, and snapshots with `deleteSnapshot`.
