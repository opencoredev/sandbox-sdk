# Modal provider

Install `modal` 0.11.1 or later, then import `modal` from
`@opencoredev/sandbox-sdk/modal`. Modal's API is gRPC, so the adapter keeps
Modal's official JavaScript SDK as an optional peer and loads it on its first
remote operation. `box.native` is typed as the SDK's `Sandbox`.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { modal } from "@opencoredev/sandbox-sdk/modal";

await using box = await createSandbox(modal(), {
  key: "user:123",
  ports: [3000],
  size: "small",
  network: { allow: ["registry.npmjs.org"] },
  timeoutMs: 30 * 60_000,
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Authentication uses `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, or the active
profile in `~/.modal.toml`. Explicit `modal({ tokenId, tokenSecret })` values
take precedence. Every sandbox lives in one Modal App, `sandbox-sdk` by
default, created on first use. `createApp` can pick another App for an unkeyed
create (one App per job, so Modal's per-App billing report prices each job).
`list()` scans `app` plus every App the provider has created into or prepared
(Modal deprecates Environment-wide listing), so a new process calls
`prepareApp(name)` for each App it must see; `prepareApp` also takes the App
lookup out of create timing.

Keys map to `sdk-` plus 56 hex characters of SHA-256, under Modal's 64-character
name limit. Modal allows one running sandbox per name in an App, and create
raises `AlreadyExistsError` for a second one, so `keyMode` is `"exact"` and the
core resolves a concurrent create through `find`. Labels become native tags.
Modal allows ten tags and 1024 bytes per sandbox; the SDK reserves `sandbox-sdk`,
`sandbox-sdk-created` (the creation time, which Modal's JS SDK does not expose),
`sandbox-sdk-key` for keyed sandboxes, and keeps room for
`sandbox-sdk-destroying`. Extra tags fail with `unsupported`.
Listing filters by tags on the server and returns only running sandboxes.

Sizes map to `cpu` 1, 2, and 4 with 2048 MiB per CPU, and set Modal's request
and limit to the same values, so a sized sandbox cannot burst. A live check on
2026-11-09 found that `cpu: N` with an equal limit gives `nproc` N and N threads
of parallel throughput (a fixed SHA-256 job: effective threads 2.0 for `cpu: 2`
and 4.1 for `cpu: 4` at eight copies; an E2B 4 vCPU sandbox reached 3.0, and
Modal `cpu: 4` did 1.10x its work). One Modal CPU unit therefore counts as one
vCPU of guest-visible capacity here, while Modal bills it as a physical core it
calls "2 vCPU equivalent". The sandbox runtime is gVisor, so
`/sys/fs/cgroup/cpu.max` and `memory.max` do not exist; `nproc`,
`/proc/cpuinfo` and `/proc/meminfo` reflect the request and limit instead.
`diskGb` fails with `unsupported`. Without `size`, Modal's default request is
0.125 CPU and 128 MiB, bursting into spare host capacity.

`network: "none"` sends empty outbound allow lists. Modal's `blockNetwork` is
not used because it also breaks the inbound tunnels previews use. Allow lists
split into domains (with `*.` wildcards) and IPv4/IPv6 addresses or CIDRs.
Ports become encrypted tunnels declared at creation, and `preview()` rejects
undeclared ports without waiting on Modal's tunnel lookup. `region` (or
`MODAL_SANDBOX_REGION`) maps to Modal's `regions`. `timeoutMs` and
`idleTimeoutMs` round up to whole seconds; `timeoutMs` is capped at 24 hours,
and Modal applies 5 minutes without one.

Commands run as `setsid --wait sh -c <wrapper>`. The wrapper `cd`s into the
working directory, prints the new process group ID as the first stderr line
(stripped before output reaches the caller), and `exec`s GNU `timeout
--signal=KILL`, so the remote deadline kills the whole group even when the
client disconnects. Timeout and abort kill the group from a second exec. Modal's
native exec `timeoutMs` is not used: a live check showed it leaves background
children running. stdin closes after any supplied input. A stdin write or close
error is ignored only when the command has exited (or does within a second);
transport errors (`unavailable`, `auth`, `timeout`, `quota`) always reject and
kill the command. Background processes use the core's shell records.

Files use Modal's filesystem API (`readBytes`, `writeBytes`, `listFiles`,
`stat`, `remove`, `makeDirectory`); Modal creates parents on write. Snapshots
are `snapshotFilesystem()` images with Modal's 30-day default lifetime,
`ttlMs: null` for `expiresInMs: 0`. A restore is tagged pending until the
adapter marks restored process records failed. `deleteSnapshot()` looks the
image up first, because Modal's delete succeeds for an image that is gone.
`buildTemplate()` builds `RUN` layers in exec form with build-only env and
returns the image ID.

`destroy()` requests termination and, beside it, sets `sandbox-sdk-destroying`;
a failed tag write never blocks the request. It then polls until Modal reports
the sandbox stopped, up to `destroyWaitMs` (default 60 s), because Modal
sometimes takes about 30 seconds (2 of 18 in a 2026-11-09 probe) and bills until
then. A failed terminate rejects and clears the tag. An unconfirmed stop rejects
with a retryable `timeout`; until Modal stops it, `list()` and `connect()` return
the sandbox with state `"stopped"`, `find()` skips it, and a keyed create that
collides with its name waits up to a minute for Modal to free it. `onDestroy`
reports `requestMs` (terminate accepted) and `stoppedMs` (stop confirmed).

There is no pause (Modal sandboxes cannot run again once stopped; memory
snapshots restore into a new sandbox ID, so they are not a resume), and no
terminal (Modal's PTY exec cannot resize).

The offline tests run the full shared suite against a mock SDK backed by real
Linux commands. With `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` set,
`tests/modal.live.test.ts` runs it against Modal in the App
`sandbox-sdk-conformance`:

```sh
timeout 1200s bunx vitest run tests/modal.live.test.ts --maxWorkers=1
```

Run this command from `packages/sdk`. It creates and terminates billable
sandboxes, about 30 of them, and ends by checking that none from the run is
still running in any App. The implementation was checked against the published `modal`
0.11.1 types and source and [Modal's sandbox guide](https://modal.com/docs/guide/sandbox).
