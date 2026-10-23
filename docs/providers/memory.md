# Memory provider

`memory()` from `@opencoredev/sandbox-sdk/memory` is an offline fake for tests. Moved from the package README.


Each `memory()` instance owns an isolated virtual filesystem and process table. It never launches host programs or contacts the network. The handler table includes echo, printf, cat, ls, pwd, true, false, sleep, exit, and printenv. It supports quotes, variable interpolation, `;`, `&&`, `||`, a final stdout redirect (`> file`), stdout-to-stderr (`>&2`), and per-call cwd/env. Pipes, background `&`, append/input redirects, file-descriptor redirects, and malformed stdout redirects return exit code 127 with an `Unsupported shell syntax` stderr message before any command runs. Quoted or escaped operators remain literal arguments. It is a shell subset, not a full POSIX shell. Custom handlers must honor their abort signal and must not perform external effects.

Register handlers with `memory({ handlers })` or `provider.register(name, handler)`. Handlers receive arguments, cwd, environment, stdin, abort signal, stdout/stderr callbacks, and scoped file primitives. Memory uses portable byte snapshots and recursive file transfer instead of Git and tar. Its conformance suite explicitly skips real Git and HTTP probes. Fake previews end in `.memory.invalid`.


The offline `memory()` provider does not advertise machine size. Explicit `size` options fail with `unsupported`; use a real provider to enforce CPU, memory, and disk limits.
