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

## Vercel

Install `@vercel/sandbox` 3.8 or later, then import `vercel` from
`@opencoredev/sandbox-sdk/vercel`. The provider dynamically loads the optional
peer SDK on its first remote operation. `box.native` is typed as Vercel's
`Sandbox`.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { vercel } from "@opencoredev/sandbox-sdk/vercel";

await using box = await createSandbox(vercel(), {
  key: "user:123",
  ports: [3000],
  size: "small",
  network: { allow: ["registry.npmjs.org"] },
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Authentication uses the Vercel SDK's OIDC context (`VERCEL_OIDC_TOKEN`), or
`VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. Explicit
`vercel({ token, teamId, projectId })` values take precedence over environment
variables. Token authentication requires all three values.

Keys map to deterministic SHA-256 names, unique within the Vercel project.
The adapter uses `Sandbox.get` and `Sandbox.create`, rather than
`getOrCreate`, so the core can distinguish creation from a concurrent
unique-name conflict. Labels become native tags. Vercel allows five tags in
total; the SDK reserves `sandbox-sdk`, plus `sandbox-sdk-key` for keyed boxes.
Extra tags fail with `unsupported`. Discovery filters the SDK tag and then
filters all requested labels locally across every page.

Sizes map to 1, 2, and 4 vCPUs for `small`, `medium`, and `large`, with 2048 MiB
RAM per vCPU. Custom CPU/memory/disk objects fail with `unsupported`, because
Vercel cannot configure disk allocation. `network: "none"` maps to `deny-all`;
allowlists map to native default-deny domain rules. `idleTimeoutMs` is rejected.
Ports must be declared at creation, with at most 15 distinct ports.
`preview()` calls `domain(port)` and rejects undeclared ports.

Commands run detached, stream the native log iterator, and close stdin after
any supplied input. A remote watchdog enforces command timeouts even if the
client disconnects. Timeout and abort terminate the remote process group.
Background processes use the core's durable shell wrapper with core-owned
records and logs, so closing a handle leaves them running. The native process
hook is omitted: its host-side completion bookkeeping could automatically
resume a paused Vercel session.

Pause and snapshots stop the Vercel session. Resume restores the filesystem
into a new session; it does not restore running OS processes. Restored process
records without an exit status are marked failed with exit code 137. Call
`process(name).restart()` to launch them again. The same cleanup runs for
snapshot clones and automatic SDK resumes. Snapshot creation stops the source
box; its next command resumes it. PTYs are not exposed by this adapter.

Vercel's native `timeout` is a session timeout reset by resume. It cannot
enforce the SDK's absolute lifetime across multiple sessions, so creation
`timeoutMs` fails with `unsupported`. Command `timeoutMs` is supported. The
native SDK also expires stored snapshots according to its retention policy.

The offline tests run the full shared suite against a mock SDK backed by real
Linux commands. With either OIDC or all three token environment variables set,
`tests/vercel.live.test.ts` runs the full suite against Vercel:

```sh
timeout 600s bunx vitest run tests/vercel.live.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000
```

Run this command from `packages/sdk`. It creates and deletes billable sandboxes.
The implementation was checked against the official [JavaScript SDK reference](https://vercel.com/docs/sandbox/sdk-reference)
and the published `@vercel/sandbox` 3.8.0 types and source.
