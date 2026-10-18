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

## Daytona

Install `@daytonaio/sdk@^0.225.0` alongside this package, then import `daytona` from `@opencoredev/sandbox-sdk/daytona`. The adapter loads the optional SDK on its first operation. It reads `DAYTONA_API_KEY`, `DAYTONA_API_URL`, and `DAYTONA_TARGET`; `daytona({ apiKey, apiUrl, target })` overrides those values. `requestTimeoutMs` defaults to 30 seconds for control-plane requests. Use `image` for a container image or `snapshot` for an existing Daytona snapshot name. A per-call `from` overrides the configured image or snapshot.

Keys use the `sandbox-sdk-key` label and are best effort. Lists filter by `sandbox-sdk=1`. Pause/resume calls Daytona stop/start, preserving disk while ending running processes. Snapshots capture the filesystem and return a name accepted by `from`. `box.native` is a typed Daytona `Sandbox`. Terminal support is not exposed.

Size presets map to `{ cpu, memoryMb, diskGb }`: small is `{ 1, 1024, 10 }`, medium is `{ 2, 4096, 20 }`, and large is `{ 4, 8192, 40 }`. Custom sizes require positive integer CPUs, memory in whole GiB (`memoryMb` divisible by 1024), and positive integer disk GiB. Image creation allocates resources directly. Snapshot creation stops, resizes, and restarts before returning; Daytona cannot shrink a snapshot's disk, so a smaller disk request fails and the new sandbox is deleted. Provider quotas and resource limits still apply.

`idleTimeoutMs` rounds up to whole minutes for `autoStopInterval`. A hard `timeoutMs` rounds down to whole minutes for Daytona's wall-clock `ttlMinutes`; values below one minute fail with `unsupported`. Auto-pause is disabled so idle behavior uses stop consistently. Network `none` blocks all traffic. An allowlist uses Daytona's enforced `domainAllowList`; entries must be DNS hostnames without schemes, ports, commas, or wildcards. An empty allowlist blocks all traffic. Unsupported expressions fail before creation.

Commands use fresh sessions with streamed stdout/stderr and separate Linux process groups. Stdin is a private file closed at EOF, including when omitted. Timeout/abort kills the group before returning; an ambiguous launch failure stops the sandbox. Commands require `sh`, `env`, `setsid --wait`, and `/bin/kill` in the image. Background hooks launch core's durable wrapper through a session, preserving records and logs after local detachment. `close()` leaves those processes running.

Previews are private. `preview()` returns the URL and `X-Daytona-Preview-Token` header. Daytona's standard preview-link response has no expiry, so `expiresAt` is omitted rather than guessed. Do not discard the headers when fetching a preview.

The offline Daytona tests replace the SDK transport with an SDK-shaped mock backed by real Linux files and processes, including Git and HTTP. `DAYTONA_API_KEY` enables the entire separate live conformance suite. Run the live suite with `timeout 15m bunx vitest run tests/daytona.live.test.ts --maxWorkers=1` from `packages/sdk`; without credentials it skips every live case.

API mappings were checked against Daytona SDK 0.225.0 and the official [client](https://www.daytona.io/docs/en/typescript-sdk/daytona/), [sandbox](https://www.daytona.io/docs/en/typescript-sdk/sandbox/), [process](https://www.daytona.io/docs/en/typescript-sdk/process/), [filesystem](https://www.daytona.io/docs/en/typescript-sdk/file-system/), and [snapshot](https://www.daytona.io/docs/en/typescript-sdk/snapshot/) references.
