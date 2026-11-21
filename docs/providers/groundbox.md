# Groundbox provider

Import `groundbox` from `@opencoredev/sandbox-sdk/groundbox`. The adapter calls
Groundbox's REST API (`https://api.groundbox.dev/v1`, or `GROUNDBOX_API_URL`)
through the shared HTTP client; there is no peer package. Create's admission
request ignores the caller's `signal`, so an abort can't strand a sandbox whose
ID never arrived; an abort that lands after admission deletes the sandbox and
fails `aborted`. `box.native` is a `NativeApi` on the one plane, `"api"`, with
`{id}` filled from the sandbox; `provider.api` is the same with no sandbox bound.
`native.sdk(() => import("@groundbox/sdk"))` returns the caller's own official
client and its `sandbox(id)` handle.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { groundbox } from "@opencoredev/sandbox-sdk/groundbox";

await using box = await createSandbox(groundbox(), {
  key: "user:123",
  size: "medium",
  timeoutMs: 30 * 60_000,
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Authentication uses `GROUNDBOX_API_KEY` (`gbx_...`), or `groundbox({ apiKey })`,
which takes precedence, sent as `Authorization: Bearer`. A missing or blank key
fails with `auth` before any request. Other options: `template` (an ID, a name
or `name:version`; default the team's default template, else Groundbox's Ubuntu
24.04 image), `image` (a Docker image instead of a template), `publicPreviews`,
`requestTimeoutMs` (60 s per request) and `operationTimeoutMs` (10 minutes for
a create to run, and for pause, resume and snapshot).

Create sends the labels as `metadata` with the key as the `sandbox-sdk-key`
label (names of 1 to 64 characters and values of at most 512, else
`unsupported`), the size as `cpus`, `memory_gb` and `disk_gb`, `network` as
`allow_hosts` (`"none"` is an empty list), `idleTimeoutMs` as
`idle_timeout_seconds` (30 or more, rounded up) and `timeoutMs` as
`timeout_minutes` (rounded up), with its absolute end in the `sandbox-sdk-deadline` label. Groundbox restarts `timeout_minutes` on every start or wake, so with `timeoutMs` and `idleTimeoutMs` the create sends `wake_on_request: false`, `pause()` does the same, `resume()` PATCHes `timeout_minutes` to what is left, and `resume()` or `connect` on a sandbox past its end deletes it and fails `not_found`. The sandbox `env` goes as the sandbox's `env`,
which every command gets, so a reconnect can read secrets back. `from` is a kept
snapshot (`snap_...`; a `size` with it fails with `unsupported`, as the sandbox keeps
the snapshot's) or else a template. The create carries an `Idempotency-Key`, so the client retries
it on `429`, `5xx` and lost connections without starting a second sandbox. A
sandbox that answers `queued` or `starting` is polled until it runs. Then the
adapter makes `/workspace` for the command user (`runner`, with `sudo -n`
where needed) and `/tmp/.sandbox-sdk`, and checks `python3`, `git`, `tar`,
`nohup` and `setsid`. If the sandbox fails to start or that step fails, the
adapter deletes it and throws with `admittedByThisCall` evidence naming the
sandbox and, when the delete also failed, its error code. Keys are best-effort:
`find` lists live sandboxes by the key label, so two concurrent creates with one
key can both succeed.

Presets: `small` is 2 vCPU / 4096 MiB, `medium` 4 / 8192, `large` 8 / 16384.
An exact size takes whole vCPUs and whole GiB; anything else fails with
`unsupported` before any request, and Groundbox refuses sizes it can't give.

An awaited command is one `POST /v1/sandboxes/{id}/exec` with `timeout_s` set
to the client deadline plus one second, at most 3600; a longer `timeoutMs` fails
with `unsupported`. Its first line is a marker comment. Groundbox runs the
command under a supervisor that can outlive the request, so when the call is
aborted or times out, the adapter lists the sandbox's commands, kills
the one whose line starts with the marker (`POST .../commands/{exec}/kill`,
SIGKILL to everything it started), reads back its output and returns `timedOut`.
A failed list or kill, a command still running after the kill, or one that never
shows up within 3 seconds fails with `outcome_unknown`. A `timed_out` answer
keeps its output. An abort during a large stdin upload deletes the staged file
and returns `timedOut`; stdin frames on the stream never split a surrogate pair. Input up to 512 KiB
goes inline; larger input is written to `/tmp/.sandbox-sdk` and redirected. A
streamed run (`for await`) opens `GET /v1/sandboxes/{id}/exec/stream`, a
WebSocket with the key in the upgrade's `Authorization` header, sends `start`,
then `stdin` and `stdin_end`, and reads `stdout`, `stderr` and `exit`; an abort
sends `kill` and waits up to 5 seconds for the exit. `terminal()` opens the same
stream with `tty`, `rows` and `cols` and runs `bash -l`.

Files use `/v1/sandboxes/{id}/files` (`path` to read or write bytes, `dir` to
list), `/files/stat` and `/files/mkdir`. A 404 whose message is not about the
sandbox is `file_not_found`; the message is read for that and never kept.
`remove` of a missing path is `file_not_found`.

`pause()` pauses the VM with its memory, with `wake_on_request: true` (false with
a hard lifetime), so a command, file call or preview wakes it; `resume()` resumes it, or boots a
sandbox that was shut down with its disk kept (`start`). Both poll until the
sandbox is `paused` or `running`. `snapshot()` keeps a snapshot
(`POST /v1/snapshots`, with an `Idempotency-Key`) and polls it until `ready`; a
snapshot that fails or times out is deleted on a fresh deadline, and the error
names it when that delete fails. Any `expiresInMs`, `0` included, fails with
`unsupported`: Groundbox deletes a snapshot after 30 days without a restore.
`deleteSnapshot()` reads the snapshot first, since deleting a deleted snapshot
answers 200 again. `buildTemplate()` creates the template, or a new version of
it when the name is taken (409), and follows its build log until it ends; build
`env` and `workdir` go in front of each `run` step, and the step runs only once
`mkdir -p` and `cd` succeed. `size` is checked like a sandbox's. The returned ID
pins the version built (`tpl_...:<version>`). `previewUrl()` creates a
private preview and returns its share token as the `x-groundbox-preview-token`
header with its expiry, cached until an hour before it expires;
`publicPreviews: true` asks for public ones. `box.ext.groundbox.fork()` forks
the sandbox with its labels but not its key.

Errors keep only the HTTP status, Groundbox's error code and request ID;
Groundbox's messages are never kept.
