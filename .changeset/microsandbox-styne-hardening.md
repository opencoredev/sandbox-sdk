---
"@opencoredev/sandbox-sdk": patch
---

Microsandbox and Styne file reads with a range (the agent tools' size-limited reads, process log reads) stream the file and stop once they have the range, so a large file, or one that grows after its size was checked, is never buffered whole. A Microsandbox adapter keeps the first API key it resolved for both its REST calls and its guest connection, so a changed `MSB_API_KEY` never splits one adapter across two keys. Styne's whole-file `files.read` refuses a file over 32 MiB with `unsupported` instead of buffering up to 4 GiB. Styne refuses any redirect off its API origin, so a create's secret environment values or an upload's bytes are never sent elsewhere. `createHttpClient` planes accept `crossOriginRedirects: false` to refuse such redirects.
