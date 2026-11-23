# Maritime provider

Import `maritime` from `@opencoredev/sandbox-sdk/maritime`. The adapter calls
Maritime's Virtual machines API with `fetch`; there is no peer package. Two
planes: the control plane (`https://api.maritime.sh/v1`, or
`MARITIME_API_URL` plus `/v1`, with `Authorization: Bearer <key>`) creates,
reads, pauses, snapshots and ends sandboxes; each sandbox's data plane (its
`dataPlaneUrl`, with `X-Maritime-Token: <secret>`) runs commands and moves
files. `box.native` is a `NativeApi` on the planes `control`, `data` and `api`
(the API host's root, for `/api/...` routes); its `sdk()` binds a
caller-installed `maritime-sdk` (`new Maritime({ apiKey, baseUrl })`, then
`sandboxes.get(id)`, which never resumes).

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { maritime } from "@opencoredev/sandbox-sdk/maritime";

await using box = await createSandbox(maritime(), {
  key: "user:123",
  size: "medium",
  timeoutMs: 30 * 60_000,
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Authentication uses `MARITIME_API_KEY` (`mk_...`, with the `sandboxes` or
`manage` scope), or `maritime({ apiKey })`, which takes precedence. A missing
or blank key fails with `auth` before any request. Every error is redacted of
the key, every sandbox secret (`mst_...`) and URL token (`mut_...`) an answer
carried, for the client's life; answers read through `box.native.request` are
scanned for `secret`, `urlToken` and `apiKey` fields and Maritime token
prefixes too.

## Create

`POST /v1/sandboxes` with `from` (the factory's `template`, default `base`),
the labels as `metadata`, the key as the `sandbox-sdk-key` entry, and a fresh
`sandbox-sdk-alloc` entry naming this one `create()` call. `name` is never
sent: Maritime answers a create whose name matches a live sandbox with that
sandbox, which could be another caller's. The request carries one
`Idempotency-Key` for the call, as a plain header, so the HTTP client never
resends it on its own.

- A create whose answer is lost (a dropped connection, a deadline, an
  unclassified 5xx, an unreadable body) is replayed once with the same key on a
  fresh 30-second deadline, then looked up by its `sandbox-sdk-alloc` marker.
  If neither settles it, `create` fails with `outcome_unknown`.
- Any answer, first or replayed, is trusted, set up, returned or ended only
  when its `metadata["sandbox-sdk-alloc"]` is this call's. Otherwise `create`
  fails with `outcome_unknown` and ends nothing.
- `503 out_of_capacity` (also `no_ready_machine`, `capacity_unavailable`) is a
  refusal made before anything ran: Maritime ends the sandbox it names
  (`create_failed`) and holds the key to that answer, so the adapter tries
  again with a new key, backing off from 2 to 20 seconds, for up to 3 minutes.
  On 2026-11-23 about one create in three was refused this way.
- Setup runs one command: it makes `/workspace` writable for the command user
  (uid 1000, through passwordless `sudo -n` on the base image) and
  `/tmp/.sandbox-sdk/exec`, and checks `python3`, `tar` and `nohup`. A failed
  setup, or an abort that lands after the answer, ends the sandbox on a fresh
  30-second deadline; an end that cannot be confirmed fails `outcome_unknown`
  naming the sandbox.

Sizes: `small`, `medium` and `large` are Maritime's presets (2/4, 4/8, 8/16
vCPU/GiB). An exact `{ cpu, memoryMb }` with no `diskGb` that is a preset
(including `{ cpu: 16, memoryMb: 32768 }`, `xlarge`) is sent as that preset,
so it gets the preset's disk (12, 50, 125 or 250 GiB). Any other exact size is
sent as `vcpu` (1 to 16), `memoryMib` (1024 to 65536, whole GiB) and `diskGib`
(5 to 500); values outside those fail `unsupported` before a request.

`timeoutMs` becomes `timeLimitSeconds` (1 second to 24 hours, default 1 hour),
counted from the create or the last resume. `idleTimeoutMs` becomes
`idleTimeoutSeconds` (60 seconds to 24 hours); without it Maritime pauses an
idle sandbox after 120 seconds, and the next data-plane call wakes it.
`network: "none"` and `{ allow: [] }` become `{ egress: "none" }`. A nonempty
allow list fails `unsupported`: Maritime's `allowlist` egress blocked its own
allowed host in a live test.

## Commands

`POST {dataPlaneUrl}/commands` with `Accept: text/event-stream`. Maritime runs
a command in its guest daemon's process group, and closing the stream does not
stop it, so every command runs as

    setsid -w sh -c <wrapper> -- <cwd> <command> <tag>

with a `tag` chosen before the request. The wrapper writes its PID (the new
group's leader) to `/tmp/.sandbox-sdk/exec/<tag>`, then checks for
`<tag>.cancel` and exits 137 without running anything if it is there, then
`cd`s and runs the command with `sh -c`. On a timeout or abort the adapter
drops the stream and runs the killer, a JSON `POST /commands` on a fresh
30-second deadline: it writes `<tag>.cancel` before it reads the PID, checks
the PID is a plain number above 1, sends `kill -KILL -<pid>`, and exits 0 only
once `kill -0` answers "No such process" for both the group and the PID. Only
a killer record of `state: "exited"` with `exitCode: 0` counts; two failed
tries fail `outcome_unknown`, never a clean `timedOut`. A cancel that reaches
the guest before the command either stops it from starting or finds its group.

The stream carries `stdout` and `stderr` (JSON strings), `result` (the Command
object) and `error` events. `result` gives the exit code, or 128 plus the
signal for a killed command. `error` with `command_timeout` (Maritime's own
deadline, the caller's plus 10 seconds, at most one hour) still runs the
killer and reads as timed out; `sandbox_ended` is `not_found`; any other error,
a stream that breaks, ends without a result, or sends an event the adapter
does not know, runs the killer and fails `outcome_unknown`. A command is sent
again only when it provably did not run: it never left the process, Maritime
answered `409 sandbox_paused` or `sandbox_starting`, or the data plane
answered `401` (the secret rotated; the adapter reads the current one first).

## Files, previews, lifecycle

Files use `GET` and `PUT {dataPlaneUrl}/files?path=` (PUT creates parents);
list, stat, mkdir and remove run the shared guest helpers. `previewUrl()` calls
`POST /v1/sandboxes/{id}/urls` with `token: true` (private: the URL carries
`?token=mut_...`) or, with `maritime({ public: true })`, `token: false`, which
makes the port public. The core keeps that query on `box.preview(port, { path })`.

`list` and `find` page `GET /v1/sandboxes` with every state but `ended` and
`metadata[<label>]` filters; `connect` reads `GET /v1/sandboxes/{id}`, which
never resumes, and an ended sandbox (kept visible for 7 days) is `not_found`.
`destroy` is `DELETE /v1/sandboxes/{id}`; a 404 is gone, and a 5xx (a live
`500 internal_error` on 2026-11-23) is sent again up to four times, then
confirmed only by a read that says `ended`. `pause()` is
`POST /v1/sandboxes/{id}/pause` (a repeat is accepted). Maritime has no resume
route: `resume()` runs `true` on the data plane, which wakes the sandbox, and
requires that command's exit 0; the control plane went on reading `paused` for
several seconds after such a wake. `usage()` reads `GET /v1/sandboxes/{id}/usage`.

`snapshot()` picks the name (`sandbox-sdk-<uuid>`) before
`POST /v1/sandboxes/{id}/save`; a lost or unreadable answer is looked up with
`GET /v1/snapshots/{name}`, and counts only when its `sourceSandboxId` is this
sandbox. Snapshots are kept until deleted (`DELETE /v1/snapshots/{name}`;
`false` on 404), so `expiresInMs` fails `unsupported`. `create({ from })`
restores one and honours a `size`.
