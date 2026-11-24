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
prefixes too. Any `mk_`, `mlk_`, `mst_` or `mut_` token and any `token=` query
value is redacted even when no answer carried it, and an error `code` or
request ID is shown only when it holds none: an SSE `error` event's code only
when it is one of Maritime's documented codes. A write sent without an idempotency
key (a create, a command) follows no redirect, so it is never sent twice; a
redirect is `outcome_unknown`.

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
  when its `metadata["sandbox-sdk-alloc"]` is this call's. An answer with no
  readable marker (missing or malformed metadata) is replayed with the same key
  as a lost one is. One carrying another call's marker fails `outcome_unknown`
  and ends nothing. The replay and every lookup page share the one 30-second
  deadline: no request starts after it.
- `503 out_of_capacity` (also `no_ready_machine`, `capacity_unavailable`) is a
  refusal made before anything ran: Maritime ends the sandbox it names
  (`create_failed`) and holds the key to that answer, so the adapter tries
  again with a new key, backing off from 2 to 20 seconds, for up to 3 minutes.
  An abort during the backoff sends no further create.
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

    sh -c <supervisor> -- <wrapper> <cwd> <command> <tag>

which runs `setsid -w sh -c <wrapper> -- <cwd> <command> <tag>`, with a
`tag` chosen before the request. The wrapper writes its PID (the new
group's leader) to `/tmp/.sandbox-sdk/exec/<tag>`, then checks for
`<tag>.cancel` and exits 137 without running anything if it is there (a record
it cannot write exits 125 without running anything), then
`cd`s and runs the command with `sh -c`. The wrapper runs under a supervisor,
a plain `sh` outside the command's group that Maritime starts: once the wrapper
exits, it asks the kernel with `kill -0 -<pid>` and removes the record only on
"No such process". A background child (`cmd &`) can hold the stream open and
keeps the group's number in use, so its group stays findable. On a timeout or abort the adapter
drops the stream and runs the killer, a JSON `POST /commands` on a fresh
30-second deadline: it writes `<tag>.cancel` before it reads the PID (and
exits 1 when it cannot), checks
the PID is a plain number above 1, sends `kill -KILL -<pid>`, and exits 0 only
once `kill -0 -<pid>` answers "No such process". It signals only the group,
never the bare PID, which after the group is gone can only name an unrelated
process. When `sudo -n` works (passwordless on the base image), the killer
signals and checks through `sudo -n kill`, so root-owned processes the
command started in its group die too; without it a root-owned survivor
answers "Operation not permitted" and the cancel is `outcome_unknown`. A known
limit: a record kept because the group still had members can outlive them. If
they all exit and Linux gives that number to a new group before this same
command's pending cancel runs, the cancel signals that unrelated group in the
sandbox. That needs the PID counter to reach the number again inside that
window. Only
a killer record of `state: "exited"` with `exitCode: 0` counts; two failed
tries fail `outcome_unknown`, never a clean `timedOut`. A `404` from the
commands route counts as a cancel only when `GET /v1/sandboxes/{id}` then
reads `ended` (or answers `404 sandbox_not_found` or `410 sandbox_ended`). A cancel that reaches
the guest before the command either stops it from starting or finds its group.

The stream carries `stdout` and `stderr` (JSON strings), `result` (the Command
object) and `error` events. `result` gives the exit code (`exited` with a
whole `exitCode` and a null `signal`), or 128 plus the signal for a killed
command (`killed` with a known `signal` and a null `exitCode`); any other
combination is unreadable. `error` with `command_timeout` (Maritime's own
deadline, the caller's plus 10 seconds, at most one hour) still runs the
killer and reads as timed out; `sandbox_ended` is `not_found` once a read
confirms the sandbox ended; any other error, a stream that breaks, ends
without a result, or sends an event whose data is not JSON, or output that is
not a string, runs the killer and fails `outcome_unknown`. Every event's data
is parsed as JSON first, so an event with another name is skipped only when
its data is JSON; comments are skipped. A
command is sent
again only when it provably did not run: it never left the process, Maritime
answered `409 sandbox_paused` or `sandbox_starting`, or the data plane
answered `401` with Maritime's `unauthenticated` code (the secret rotated; the
adapter reads the current one first). Any other `401`, a bodyless one included,
fails `auth` and is not sent again.

## Files, previews, lifecycle

Files use `GET` and `PUT {dataPlaneUrl}/files?path=` (PUT creates parents);
list, stat, mkdir and remove run the shared guest helpers. `previewUrl()` calls
`POST /v1/sandboxes/{id}/urls` with `token: true` (private: the URL carries
`?token=mut_...`) or, with `maritime({ public: true })`, `token: false`, which
makes the port public. A private URL is asked for on every call, never cached,
so a rotated URL token is picked up. The core keeps that query on
`box.preview(port, { path })`.

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
`POST /v1/sandboxes/{id}/save`; the answer counts only when it names that
snapshot with this sandbox as its `sourceSandboxId`. A lost, unreadable or
mismatched answer is looked up with
`GET /v1/snapshots/{name}`, and counts only when its `sourceSandboxId` is this
sandbox. Snapshots are kept until deleted (`DELETE /v1/snapshots/{name}`;
`false` on 404), so `expiresInMs` fails `unsupported`. `create({ from })`
restores one and honours a `size`.
