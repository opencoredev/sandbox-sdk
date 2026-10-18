# Sandbox SDK core

`@opencoredev/sandbox-sdk` 1.0.0 is ESM for Node 22+ and Bun 1.3+. The root exposes lifecycle functions, `SandboxError`, and the public handle types. Provider adapters import the primitive contract from `/provider`; `/memory` supplies an offline fake; `/testing` registers the shared Vitest suite.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

await using box = await createSandbox(memory());
await box.files.write("hello.txt", "hello\n");
const result = await box.$`cat ${"hello.txt"}`;
console.log(result.stdout);
```

The result is `hello` followed by a newline. Commands are lazy: awaiting or iterating a `RunHandle` starts execution, after its chained options have been applied. Iteration streams live output; awaiting returns the capped result. Stream failures throw `SandboxError`. Nonzero exits, timeouts, and aborts return results.

## Implement an adapter

Implement `Provider<Native, CapabilityLiterals>` from `src/provider.ts`. The capability type parameter must be the literal union the adapter actually supports, such as `"pause" | "snapshot"`. It controls optional handle methods. Runtime capability declarations must have matching hooks.

- `create` receives native resource options, SDK labels, and the merged environment. Honor size, network policy, hard lifetime, and idle timeout, or reject with `unsupported`. Never silently drop restrictions. `find` and `list` should restrict discovery to SDK-created resources.
- `keyMode: "exact"` means the native resource name is unique. `find` must return that same native resource for a key. `connect` reports `not_found` for stale IDs.
- `exec` closes stdin, emits stdout/stderr chunks in arrival order, and settles only after the remote process group is terminated on timeout or abort. Return nonzero exits without throwing. Stream decoding belongs in the transport so split UTF-8 sequences survive.
- File paths are absolute POSIX paths. `mkdir` creates parents and succeeds for existing directories. `list` returns immediate children with absolute paths. `read` and `write` transfer bytes unchanged. Missing files use `file_not_found`; missing sandboxes use `not_found`.
- `previewUrl` returns the URL and any required access headers and expiry. Core performs HTTP probing when requested.
- `native` returns the fully typed client. `close` detaches local transport resources; it must leave the remote sandbox running.
- Optional native process hooks must keep their process alive when local resources detach. Core owns the durable records and log framing. A shell fallback requires Linux `sh`, `setsid`, `nohup`, `mkfifo`, GNU `sed -u`, and standard file utilities. File checkpoints require Git, and directory transfer requires tar.

All provider errors must use `SandboxError`. Core wraps unknown failures and sanitizes native causes to prevent nested credential objects from escaping. File reads preserve data exactly; command output, process output, search results, patches, and errors are redacted. Reconnect restores redaction values by reading the recorded secret variable names from the sandbox environment. That environment must survive connection changes.

Run conformance from a provider test file:

```ts
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { runConformance } from "@opencoredev/sandbox-sdk/testing";

runConformance(() => memory(), { live: false });
```

Use `timeout 120s vitest run --maxWorkers=4`. Cloud providers require `live: true`; the caller gates that flag on its credentials. `/testing` imports Vitest through an optional peer dependency. The core and memory entry points have no runtime package dependencies.

## Memory behavior

Each `memory()` instance owns an isolated virtual filesystem and process table. It never launches host programs or contacts the network. The handler table includes echo, printf, cat, ls, pwd, true, false, sleep, exit, and printenv. It supports quotes, variable interpolation, sequential commands, conditional lists, redirection, and per-call cwd/env. It is a shell subset, not a full POSIX shell. Custom handlers must honor their abort signal and must not perform external effects.

Register handlers with `memory({ handlers })` or `provider.register(name, handler)`. Handlers receive arguments, cwd, environment, stdin, abort signal, stdout/stderr callbacks, and scoped file primitives. Memory uses portable byte snapshots and recursive file transfer instead of Git and tar. Its conformance suite explicitly skips real Git and HTTP probes. Fake previews end in `.memory.invalid`.

## Limits and spec clarifications

- A two-function locator cannot enforce cross-host uniqueness: `get` followed by `set` is not atomic. A best-effort provider accepts it for cached lookup and stale-ID recovery. Requesting `keyMode: "exact"` additionally requires `locator.withLock(key, action)`, implemented with a distributed lock or transaction. Core also serializes same-key calls on one provider instance within the current JS realm.
- `reapSandboxes({ idleOnly: true })` means no active SDK run record and no running SDK background process. It does not infer provider-specific idle state or account for commands launched outside the SDK. A server crash can leave a run record behind; cleanup is conservative.
- Persistent process logs rotate at 10 MB. Native output waiting for storage is capped at 1 MB; if a producer outruns storage, older pending records are discarded and the cursor advances. A stale cursor returns `truncated: true`. The shell fallback records partial chunks and conservatively masks secret fragments at chunk boundaries. Incomplete lines retain at most 1 MB and carry a truncation marker.
- Linux native hooks launch the same durable shell wrapper as the fallback, so log capture survives loss of the host client. Memory captures output in-process because its entire sandbox lifetime is in-process.
- The root module loads the handle implementation on first creation/connection. The size gate measures the minified root entry (under 8 KB); feature chunks are reported separately. This is an entry-size budget, not an 8 KB budget for all SDK features combined.

Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun run test` from this package. The test script also enforces the root size and zero runtime dependency checks.

## E2B

Install the optional `e2b` peer (`^2.56.0`) and set `E2B_API_KEY`, or pass `apiKey` to the factory:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using box = await createSandbox(e2b({ template: "base" }));
console.log((await box.run("echo hello")).stdout);
```

`e2b({ apiKey?, template?, domain? })` loads E2B on first provider operation. The root entry never imports E2B. `box.native` is typed as the official E2B `Sandbox`.

- Keys use metadata lookup and can race across hosts (`keyMode: "best-effort"`). Labels become E2B metadata; listing paginates over SDK-owned running and paused sandboxes. `sandbox-sdk-key` and `sandbox-sdk-deadline` are reserved metadata keys.
- Omitted `size` uses the template's CPU, RAM and disk. Every explicit preset (`small`, `medium`, `large`) and custom size fails with `unsupported`: E2B chooses resources when building the template, not when creating a sandbox.
- `network: "all"` enables internet access. `"none"` uses `allowInternetAccess: false`. `{ allow }` combines E2B `allowOut` with `denyOut: ["0.0.0.0/0"]`. E2B domain rules use HTTP Host/TLS SNI and permit DNS resolution; shared endpoints can admit other destinations on the same endpoint. These are E2B's native network guarantees, not a separate SDK firewall. See [E2B internet access](https://docs.e2b.dev/network/internet-access).
- `timeoutMs` maps to E2B's native timeout with kill-on-expiry. A metadata deadline prevents a fresh client's connect/resume from extending the requested lifetime. If omitted, E2B's default timeout applies. `idleTimeoutMs` fails with `unsupported`: E2B exposes an elapsed-time timeout, not an idle detector. Ports need no advance registration.
- Commands use native stdout/stderr callbacks, stdin delivery and EOF. A separate POSIX session lets timeout/abort kill the entire process group. Templates need `sh`, `bash`, `setsid` and `git`; commands and file operations run as root to make `/workspace` and SDK records accessible.
- Native background commands back process hooks. Process records and logs remain core-owned files, so a new client can reattach. Lost streams reconnect with `commands.connect`. `close()` disconnects local streams and leaves the sandbox running; `destroy()` kills it.
- Pause/resume and snapshots are advertised capabilities. Snapshots return E2B's `snapshotId`; pass it as `from` to create a sandbox from that state. PTYs are not exposed by this adapter. Preview URLs use HTTPS and `getHost(port)`.

The offline E2B tests replace the official SDK transport with isolated Linux commands and files, including real Git and HTTP probes. `tests/e2b.live.test.ts` registers the full conformance suite and skips it without `E2B_API_KEY`. With credentials, the suite creates billable sandboxes; run it with `timeout 600s node_modules/.bin/vitest run tests/e2b.live.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000` from this package.
