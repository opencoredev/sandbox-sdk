# Baseten provider

Install `@basetenlabs/sandbox` 0.5.0 (the peer range is `^0.5.0`), then import
`baseten` from `@opencoredev/sandbox-sdk/baseten`. The adapter keeps Baseten's
official SDK as an optional peer and loads it on its first remote operation.
`box.native` is typed as `{ sandbox, client }`, the SDK's `Sandbox` and the
`SandboxClient` that loaded it.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { baseten } from "@opencoredev/sandbox-sdk/baseten";

await using box = await createSandbox(baseten(), {
  key: "user:123",
  size: "small",
  timeoutMs: 30 * 60_000,
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Authentication uses `BASETEN_API_KEY`, or `baseten({ apiKey })`, which takes
precedence. A missing or blank key fails with `auth` before the SDK loads.
`teamId` picks the team for a key with several. Other options: `image` (a
reference with its tag, default `baseten/base-image:latest`), `region` (unset
lets Baseten pick the closest), `readyTimeoutMs` (how long create waits for the
sandbox and its volume to deploy, default 120 s) and `volume`.

Sandboxes are named `sbxsdk-` plus a UUID. A keyed sandbox is `sbxsdk-k` plus
40 hex characters of the key's SHA-256, and the key is stored as Baseten's
`externalId`. Baseten names are unique, so `keyMode` is `"exact"` and `find`
looks the name up directly. Labels become Baseten labels. Each create also sets
`sandbox-sdk-attempt` to a fresh UUID, hidden from `SandboxInfo`: when a create
fails without an HTTP rejection (a lost or aborted response, or 0.5.0 throwing
on a response that has no URL yet), the adapter deletes the sandbox under that
name only if it carries this attempt's ID. A sandbox with another attempt's ID,
or no sandbox, settles that this attempt made nothing; a missing marker leaves
the outcome unknown and create fails with `outcome_unknown`. Listing pages
through every sandbox, keeps the `sbxsdk-` names and filters labels on the
client. Baseten states `FAILED`, `DELETING`, `TERMINATED` and `DEACTIVATING`
count as gone; `DEACTIVATED`, `ARCHIVING` and `ARCHIVED` map to `"paused"`;
everything else maps to `"running"`.

Baseten sets CPU from memory, 2 GiB per vCPU, as `nproc` shows in the sandbox.
The adapter sends only `memory`. Presets map to 2048, 4096 and 8192 MiB (1, 2
and 4 vCPUs), and an exact size must be one of those pairs. A live check found
that 16384 MiB gives 6 vCPUs, not 8, so larger sizes fail with `unsupported`
until their CPU count is known. `diskGb` fails with `unsupported`. Without
`size`, Baseten's default is 4096 MiB (2 vCPUs).

Baseten holds the file system in memory, capped by default at 50% of the
sandbox's memory, so a large workspace competes with processes for RAM.
`volume: { sizeGiB, mountPath }` creates a volume named `<sandbox>-v` before the
sandbox, waits for it to deploy, and mounts it at `mountPath`; the sandbox goes
in the volume's region. Volumes are network storage: in a smoke run a
dependency install took about 246 s on one and 140 s in memory. Use one for
workspaces too large for memory (a `node_modules` tree, a build that was
OOM-killed without one), not by default. `volume` with a `key` fails with
`unsupported`, because a keyed create races other clients for the name and the
volume would race too. A volume create that fails is deleted; if that delete
fails, create fails with `outcome_unknown` naming the volume. A sandbox create
that fails after its volume deployed deletes the volume once the sandbox is
known gone.

`destroy()` deletes every preview of the sandbox (Baseten keeps a preview and
its quota slot after the sandbox is deleted, whichever client made it), then the
sandbox, then `<id>-v`. Baseten answers 409 while the sandbox that mounted the
volume is still shutting down, a few seconds after its delete returns, so the
volume delete retries for up to 120 s; a missing volume is success. A client
skips the volume request only for sandboxes it created without one, so a
connected client or a retry after a failed volume delete still cleans up.

`timeoutMs` becomes a `TTL_MAX_AGE` lifecycle policy and `idleTimeoutMs` a
`TTL_IDLE` one, both with Baseten's default action, `DELETE`. Without them the
adapter sends no lifecycle policy. `network` accepts only `"all"`; `"none"` and
allow lists fail with `unsupported`. Outbound traffic is IPv6-only, so
hostnames work and raw IPv4 addresses don't. `from` fails with `unsupported`:
Baseten's API has no snapshots yet. `env` values go to Baseten as secret
environment variables.

There is no pause call and no `"pause"` capability. A sandbox goes on standby by
itself about 15 s after its last request (measured 2026-11-16: an in-sandbox
ticker stopped 14 to 15 s after the last request, and `/proc/uptime` advanced
0.2 s across a 15 s wall-clock gap). On standby it keeps memory, files and
processes, is billed only for storage, and resumes on the next request. The API
still reports it `DEPLOYED`, so the SDK reports `"running"`.

`previewUrl(id, port)` creates a public preview named `port-<port>` with
`createIfNotExists`, so a second call returns the same URL. No ports are
declared at create.

Commands run through a Python launcher (`python3` must be in the image; the
default image, Alpine with musl and BusyBox, has it). The launcher's spec
(command, cwd, env, stdin, timeout) goes in one environment variable, or, above
96 KiB, in a file uploaded first, because Baseten caps one environment string at
128 KiB. The command runs in its own session. Baseten replays a process that
finished before its stream opened as one event per line without the newline, so
the launcher writes its own frames on stdout: a letter, base64 and `.`, for
stdout, stderr, a deadline kill and the exit code. At the deadline the launcher
kills the process group; on abort a second exec marks the run cancelled and
kills the group through a pid record. Baseten's PID 1 never reaps orphans, so
the launcher treats zombies as dead. Commands report activity inline
(`inlineActivity`), without separate file calls.

Files use the shared guest helpers: writes through `fs.writeBytes`, whole reads
through `fs.readBytes`, and ranged reads through a Python reader in the guest.
0.5.0 parses any JSON response as a directory listing and Baseten serves `.json`
files as JSON, so a read that reports "is a directory, not a file" falls back to
the guest reader, which fails for a real directory.

Errors keep only the native error's name and HTTP status, never its message:
stream failures carry response event data and API errors can echo paths or
requests. Statuses map through the shared table; `AbortError` is `aborted`,
`SandboxProcessWaitTimeoutError` is `timeout`, and a `TypeError` (a failed
fetch) is `unavailable`.

The offline tests (`tests/baseten.test.ts`, `tests/baseten-volume.test.ts`,
`tests/baseten-launcher.test.ts`) cover the frame reader, error mapping, the
volume lifecycle against a fake client, and the real launcher under local
`python3`. With `BASETEN_API_KEY` set, `tests/baseten.live.test.ts` runs the
shared conformance suite and the size, stdin and output checks, and
`tests/baseten-lifecycle.live.test.ts` checks preview cleanup and the 4 vCPU
size:

```sh
timeout 1200s bunx vitest run tests/baseten.live.test.ts tests/baseten-lifecycle.live.test.ts --maxWorkers=1
```

Run this command from `packages/sdk`. It creates and deletes billable
sandboxes, each with a `timeoutMs` of 10 or 15 minutes as a backstop, and the
conformance file ends by checking that none from its run is still live. The implementation was checked against the
published `@basetenlabs/sandbox` 0.5.0 types and source and
[Baseten's sandbox lifecycle docs](https://docs.baseten.co/sandboxes/lifecycle).
