# Instabox provider

Import `instabox` from `@opencoredev/sandbox-sdk/instabox`. The adapter calls
Instabox's REST API (`https://api.instabox.sh`, or `INSTABOX_API_URL`) with
`fetch`; there is no peer package. `box.native` is `{ machineId, request }`,
where `request({ method, path, body })` calls the API with the adapter's key.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { instabox } from "@opencoredev/sandbox-sdk/instabox";

await using box = await createSandbox(instabox(), {
  key: "user:123",
  size: "medium",
  timeoutMs: 30 * 60_000,
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Authentication uses `INSTABOX_API_KEY` (`ibk_...`), or `instabox({ apiKey })`,
which takes precedence. A missing or blank key fails with `auth` before any
request. Snapshots need the `images:write` and `images:delete` scopes. Other
options: `template` (default Instabox's `agent-browser`, optionally pinned as
`id@version`), `requestTimeoutMs` (60 s per request) and `operationTimeoutMs`
(5 minutes per asynchronous change).

Every change (create, start, suspend, resume, delete, snapshot) returns an
operation, which the adapter long-polls with `GET /v1/operations/{id}?wait=25s`
until it succeeds or fails. Writes carry an `Idempotency-Key` that stays the
same across retries. Network failures before an answer are retried for reads and
idempotent writes; `429` and retryable `5xx` answers are retried after
`retryAfterSeconds` or `Retry-After`. A read that never gets an answer fails
with `unavailable`, a write with `outcome_unknown`.

Create sends the labels as metadata, the key as the `sandbox-sdk-key` label,
the size as `vcpus` and `memMiB`, `idleTimeoutMs` as `autoSuspendAfterSeconds`
(300 to 1800 in whole minutes, or 0) and `timeoutMs` as `deleteAfterSeconds`
(60 to 86400). Then it links `/workspace` to `/data/workspace` on the
persistent disk and checks `python3`, `git`, `tar`, `nohup` and `setsid`. If the
operation, that step or the final read fails, the adapter deletes the machine
and throws with `admittedByThisCall` evidence naming the machine and, when the
delete also failed, its error code. Keys are best-effort: `find` lists machines
by the key label, so two concurrent creates with one key can both succeed.

Presets: `small` is 2 vCPU / 4096 MiB, `medium` 4 / 8192, `large` 8 / 16384.
An exact size must be one the plan offers; Instabox refuses others with
`spec_not_allowed` (`unsupported`). `diskGb` fails with `unsupported`: the disk
comes with the size. A machine created from a snapshot without a size gets
`medium`, because Instabox otherwise uses the plan default rather than the
source's size.

Commands go to `POST /v1/machines/{id}/exec` with `Accept: text/event-stream`
and stream `stdout`, `stderr`, `exit` and `error` events. The server limit is
`timeoutSeconds`, the client deadline plus one second, at most 600. Closing the
stream kills the command's process group. Input up to 1 MiB goes inline; larger
input is written to `/tmp/.sandbox-sdk` and redirected. Files use
`/v1/machines/{id}/files` and `/files/content`; a directory with 5000 entries
or more is listed in the guest with `find`.

`pause()` suspends the machine with its memory; `resume()` resumes it, or
starts it if Instabox stopped it. `snapshot()` creates a snapshot and polls it
until `ready`. `deleteSnapshot()` sends `X-Confirm-Delete`. `previewUrl()`
publishes the port (public, 1024 and up) and caches the URL per machine.

Errors keep only the HTTP status, Instabox's error code (snake_case, up to 48
characters) and request ID, as evidence on the cause; Instabox's messages are
never kept.
