# Buddy provider

Import `buddy` from `@opencoredev/sandbox-sdk/buddy`. The adapter calls Buddy's
REST API with `fetch`; there is no peer package. One API host per region
(`https://api.buddy.works`, `https://api.eu.buddy.works`,
`https://api.asia.buddy.works`, or `BUDDY_API_URL`), `Authorization: Bearer
<personal access token>`, and every sandbox route under
`/workspaces/{workspace}/sandboxes`. `box.native` is a `NativeApi` on the
planes `workspace` (base `/workspaces/{workspace}`, placeholder `{sandbox_id}`)
and `api` (the host's root). There is no `sdk()` binding.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { buddy } from "@opencoredev/sandbox-sdk/buddy";

await using box = await createSandbox(buddy(), {
  key: "user:123",
  size: "medium",
  idleTimeoutMs: 30 * 60_000,
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Everything below was checked against the live API on 2026-11-24 (workspace on
the Pro plan, `ubuntu:24.04`, default `2x4`).

## What Buddy gives

- A sandbox is a KVM virtual machine (AMD EPYC, Linux 6.8) with a persistent
  50 GB disk (46 GiB usable). Sizes are twelve fixed tiers, `1x2` to `12x24`
  (vCPU x decimal GB): a `2x4` guest has 3814 MiB, a `4x8` guest 7629 MiB.
  `resources: "CUSTOM"` silently becomes `2x4`, so the adapter never sends it.
- Status is `STARTING`, `RUNNING`, `STOPPING`, `STOPPED`, `RESTORING` or
  `FAILED`; setup status is `INPROGRESS`, `SUCCESS`, `FAILED` or `STALE`. A
  bare create reaches `RUNNING` + `SUCCESS` in about 0.6 s; a create with
  `variables` takes about 5.5 s.
- `identifier` is unique across the workspace (`400 'identifier' must be
unique`). `tags` cannot hold `:`. `note` stores any string, JSON included, on a
  clean create and on a restore from `snapshot_id`.
- `variables` with `encrypted: true` are returned as `!encrypted ...` and are in
  the environment of every command.
- `POST /exec` runs one command and answers with stdout, stderr and the exit
  code. It is not listed in `GET /execs`, takes up to about 64 KiB of command
  (256 KiB answered `200` with empty output; 1 MiB is `400 request body too
large`), and is cut at 60 seconds.
- `POST /execs` starts a command and records it, its command text and its
  output in `GET /execs`. It takes at most 16,384 bytes of command, runs up to
  90 minutes (`failure_reason: TIMEOUT`), and concurrent executions are
  allowed; a `409` is a refusal before anything ran. `GET /execs/{id}?wait=ms`
  long-polls until a terminal status (`SUCCESSFUL`, `FAILED`, `CANCELLED`).
  `GET /execs/{id}/log` returns stdout and stderr merged and split into lines,
  with `\r` dropped and a missing final newline joined to the next write;
  about 10 MB of a fast 20 MB output came through. `DELETE /execs/{id}` kills
  the execution, a `setsid` child included.
- `POST /content/upload/{path}` (multipart `file`) makes parent directories;
  `GET /download/{path}` answers a file as `application/octet-stream`, a
  directory as `application/gzip` (`<name>.tar.gz`), a missing file as
  `404 File not found`. An unknown sandbox or execution is
  `404 Resource not found`; a stopped sandbox refuses commands and transfers
  with `Sandbox must be running`.
- `PATCH /sandboxes/{id}` with `endpoints` replaces the whole list. A BASIC
  endpoint's `password` is write-only: sending its `!encrypted` form back breaks
  it, leaving it out keeps it.
- `POST /stop` stops in about 1.4 s and `POST /start` starts in about 3.5 s.
  Snapshots are `POST /sandboxes/{id}/snapshots { name }`, `CREATING` then
  `CREATED` in about 2.4 s; they outlive their source, whose ID then drops out
  of the snapshot's URL, and are deleted with
  `DELETE /sandboxes/snapshots/{id}`.
- There is no usage or billing API. Buddy bills $0.00024 per CPU-minute and
  per GB-minute of the tier, per started minute, plus $0.00011 per GB-hour of
  used disk and snapshots.

## Create

- The identifier is `sbx-k-<sha256(project + "\0" + key)[0..24]>` for a keyed
  sandbox and `sbx-a-<alloc>` otherwise, so `keyMode` is `exact`. The name is
  the identifier.
- The body carries `tags: ["sandbox-sdk"]` and a JSON `note`:
  `{ v: 1, "sandbox-sdk": "1", "sandbox-sdk-alloc", "sandbox-sdk-key"?,
labels, secrets }`, on a clean create (`os`) and on a restore
  (`snapshot_id`) alike. Reads parse the note and report its labels plus
  `"sandbox-sdk": "1"`; `list()` reads only sandboxes with an SDK identifier
  and a note this adapter wrote.
- `CreateInput.env` (secrets included) becomes `variables` with
  `encrypted: true`. The secret names go in the note, so `recordsSecretNames`
  is set: they are recorded with the sandbox itself, before anyone can find it.
  `readSecretEnvironment` returns them with the environment, read over
  `POST /exec`, so recovered values never enter the command history.
- A create's answer is trusted when its note carries this call's allocation ID
  and its identifier is the one sent. Otherwise (a lost answer, an unreadable
  one, or `400 'identifier' must be unique`), one fresh 30-second deadline
  covers a reconcile: list the sandboxes, read the one holding the sent
  identifier, and return it only when its note carries this call's allocation
  ID. Another call's sandbox holding the identifier proves this create made
  nothing: that throws `unavailable`, and the core, seeing an exact provider,
  calls `find(key)` and attaches with `created = false`, so the losing caller
  never deletes the winner's sandbox on abort or a failed init. No holder after
  a lost answer stays `outcome_unknown`.
- Readiness: `RUNNING` with setup `SUCCESS` (`FAILED` or `STALE` fail), then a
  setup command over `POST /exec` that makes `/workspace` writable for `buddy`,
  checks `python3`, `setsid`, `flock` and `base64`, and installs the bridge.
  `create`, `find` (for a keyed sandbox another call is still starting) and
  `resume` all wait for it. A failure or abort after the create deletes the
  sandbox on a fresh 30-second deadline, else `outcome_unknown`.
- `find` deletes a keyed sandbox that is `FAILED` and returns nothing, since its
  identifier would block every new create; a stopped one is returned as
  `paused`.
- `timeoutMs` is refused (no hard lifetime). `idleTimeoutMs` is Buddy's
  `timeout` in whole seconds. No network policy.

## Commands

- Adapter steps (setup, staging, cancel, spool reads, file metadata, preview
  locks and credentials, secret recovery) run on `POST /exec`, never recorded.
- A user command runs on `POST /execs` under a launcher of at most a few
  hundred bytes plus the command when it is 4 KiB or less:
  `exec setsid -w python3 -u <bridge> <dir> <cwd> <activity> <envFile> <staged> [command]`.
  Per-run `env` (`env.json`), `stdin` and a longer command (`cmd`) are written
  first into `/tmp/.sandbox-sdk/exec/<tag>` (mode 0700, umask 077) through
  `POST /exec`, in chunks of 30 KiB; the handle's stable environment goes once
  per client into a 0600 file under `/tmp/.sandbox-sdk/env` named by a random
  ID. The bridge reads and unlinks the staged files before it runs anything, so
  no environment value, stdin or long command is ever in a recorded command.
- The bridge (a file named by its content hash under `/tmp/.sandbox-sdk/bin`)
  starts the command's shell with `start_new_session`. That shell takes the
  command's lock, checks the cancel marker (a cancelled start writes `refused`
  and runs nothing), records its own PID (its process group) and only then runs
  the command, so a bridge killed right after the spawn cannot leave a running
  command the killer does not find. The bridge numbers every chunk from frame 0
  (`<seq>:O:<base64>`, `<seq>:E:<base64>`, `<seq>:X:<code>`), appends it to
  `spool` and writes it to stdout without blocking; once stdout cannot take a
  whole frame it stops writing there. `done` marks its end. A missing bridge or
  staged file prints a marker and exits 125 before anything ran, and the
  adapter stages and launches once more.
- The reader follows Buddy's log; a gap, a broken frame, `truncated`, or a
  terminal status without the exit frame moves it to the spool from the next
  frame it needs, over `POST /exec` in 1 MiB reads. A buffered command waits on
  one long-polled status; a streaming one polls status with a 1 to 5 second
  hold between log reads.
- A lost `POST /execs` answer, or a `2xx` whose body is not an execution, is
  looked up in `GET /execs?limit=20` by its tag. When it is not there, the
  killer writes the cancel marker so a late start never runs the command. The
  call fails `unavailable` (retryable) only when the command's shell recorded
  `refused`; otherwise it is `outcome_unknown`, since a fast command can run and
  end before the lookup. A `409` is sent again up to four times.
- A timeout or abort runs the killer over `POST /exec` on a fresh 30-second
  deadline, twice at most: under the command's lock it writes the cancel
  marker, reads the PID, kills the group (through `sudo -n` when it works) and
  exits 0 only when `kill -0` answers "No such process", or when no PID was
  recorded (the marker then stops the start, and the staged input is removed).
  Only that exit, or a read that shows the sandbox gone, settles the call as
  timed out; otherwise `outcome_unknown`, and the execution is left for you to
  inspect. After a confirmed kill the execution is deleted (best effort, 10
  seconds), and the output written before the stop is read from the log and
  then the spool on a fresh 5-second deadline, and kept.
- An abort after staging and before the launch removes the command's
  directory (`env.json`, `stdin`, `cmd`) on a fresh 10-second deadline.
- An execution that ends with no exit frame anywhere is a platform failure:
  `TIMEOUT` is `timeout`, `CANCELLED` (outside this client) and any other end
  are `provider`, each after the group is killed. A command's exit code comes
  only from its exit frame, never from Buddy's `exit_code`.
- The next launch names the directories of this client's finished commands,
  and the bridge removes each one that has its `done` marker; a cancelled
  command's directory is removed once its group is gone and its spool read. Any other
  is swept by a later command 10 minutes after it ended, or 2 days after it
  was made.

## Files, previews, lifecycle

- Paths resolve against `/workspace`, NUL is refused, and each segment is
  URL-encoded. `files.read` takes a `200 application/octet-stream` as the file;
  `application/gzip` or a `.tar.gz` disposition is a directory
  (`invalid_argument`); `404 File not found` is `file_not_found`,
  `404 Sandbox not found` is `not_found`, any other download 404 is `provider`.
  `files.write` uploads with `userName=buddy` and makes parents; `list`, `stat`,
  `mkdir` and `remove` are the shared guest programs over `POST /exec`.
- Previews: an endpoint `sbx-p<port>` of type `HTTP`. Private by default:
  `auth_type: BASIC`, login `sbx`, a random password registered for redaction
  (with its header) before the `PATCH`, and stored in
  `/tmp/.sandbox-sdk/previews/<port>` (0600) so another client returns the same
  `{ url, headers }` without a change. `public: true` uses `auth_type: NONE`.
  A change takes an atomic `mkdir` lock in the sandbox (a lease older than two
  minutes is broken) and an in-process queue, reads the endpoints, sends the
  others back without read-only fields or the write-only `password`, and
  refuses, before any `PATCH`, when any endpoint (the one named `sbx-p<port>`
  included) has custom TLS, a custom CA or any other encrypted value, or when
  the one named `sbx-p<port>` is not `HTTP` on that port. These errors never
  name an endpoint or echo its settings. An
  unconfirmed `PATCH` that added a new endpoint is settled by a read.
- `pause` is `POST /stop` until `STOPPED`; already stopped is fine. `resume`
  waits out `STOPPING`, sends `POST /start` and waits for readiness. A stop
  ends every process.
- `snapshot` names the snapshot `sandbox-sdk-<uuid>` before the request, looks
  it up by that name when the answer is lost, and returns its ID once it is
  `CREATED`. `deleteSnapshot` is `DELETE /sandboxes/snapshots/{id}`; a 404 is
  `false`. `expiresInMs` is refused.
- Errors carry only the HTTP status and a reason the adapter matched from
  Buddy's message; the token, preview passwords and their Basic headers,
  secret values and any `!encrypted ...` value are redacted.

## What Buddy keeps

- Create-time `env` and `secrets` are `variables` with `encrypted: true`;
  secret recovery reads them over `POST /exec`. Per-run `env`, `stdin` and
  staged commands are written over `POST /exec`. None of these is in the
  command text `GET /execs` records.
- The stdout and stderr of a command on `POST /execs` flow through Buddy's
  execution log as base64 frames, and Buddy keeps that log. The SDK redacts
  secret values from `RunResult` and from errors; it cannot scrub them from
  Buddy's server-side log.
