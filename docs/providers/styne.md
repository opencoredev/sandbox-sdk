# Styne provider

Import `styne` from `@opencoredev/sandbox-sdk/styne`. The adapter calls Styne's
REST API (`https://api.styne.ai`, or `STYNE_API_URL`) with `fetch` through the
shared HTTP client; there is no peer package. `box.native` is a `NativeApi` with
the `{id}` placeholder bound to the sandbox, and `styne().api` is the same with
no sandbox bound.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { styne } from "@opencoredev/sandbox-sdk/styne";

await using box = await createSandbox(styne(), {
  key: "user:123",
  size: "medium",
  timeoutMs: 30 * 60_000,
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Authentication uses `STYNE_API_KEY`, or `styne({ apiKey })`, sent as
`Authorization: Bearer`. A missing or blank key fails with `auth` before any
request. Other options: `template` (default `base`), `region` (`ash`, or `ams`,
which Styne serves in Ashburn), `timeoutMs` (lifetime for creates without one,
default 1 hour), `public` (serve ports without the traffic token), `pauseTier`
(`memory`, `standby` or `archived`) and `requestTimeoutMs` (60 s per request).

Behaviour checked against the live API on 2026-11-23:

- **Create.** `POST /sandboxes` with `templateID` (or `size`, or `snapshot`),
  `metadata` (labels, plus the key as `sandbox-sdk-key`), `timeout` in seconds
  (1 to 86400), `idleTimeout` (1 to 3600), `envVars`, and for
  `network: "none"` both `allow_internet_access: false` and
  `network.denyOut: ["0.0.0.0/0"]`. It carries an `Idempotency-Key`; Styne
  answers a repeated key with the same sandbox, so the shared client retries
  `429`, `502`, `503` and `504`, and a lost answer is sent once more with the
  same key to learn the sandbox ID. The caller's signal is honoured after the
  answer, by deleting the sandbox. Setup then runs one guest command: it makes
  `/workspace` and `/tmp/.sandbox-sdk/exec`, adds `safe.directory=*` to the
  system git config, and checks `python3`, `tar`, `nohup` and `setsid`. A
  failed setup deletes the sandbox; an unconfirmed delete is `outcome_unknown`
  naming it.
- **Sizes.** `small` → `small` (2 vCPU, 4 GiB, 51 GiB), `medium` → `default`
  (4, 8, 51), `large` → `large` (8, 16, 111). `{ cpu: 16, memoryMb: 32768 }` is
  `xlarge` (16, 32, 251). Any other exact size, and a `diskGb` other than the
  size's disk, is `unsupported`. Styne refuses `size` beside `templateID`, and
  silently ignores `size` beside `snapshot` (it made a default-size sandbox),
  so the adapter refuses both combinations itself.
- **Network.** `"none"` blocks IPv4, IPv6 and DNS. With `denyOut: ["0.0.0.0/0"]`,
  `allowOut` opened neither a hostname nor a `/32`, so `{ allow }` with entries
  is `unsupported`. An empty allow list is treated as `"none"`.
- **Exec.** `POST /sandboxes/{id}/exec` with an NDJSON body: the start line
  (`argv`, `envs`, `timeoutMs` = the run's deadline + 10 s, `stdin: true` when
  input is given), then base64 `stdin` lines of up to 1 MiB and `closeStdin`.
  The answer streams `started`, base64 `stdout` and `stderr`, `exit` and
  `error` lines. Styne makes the started process a process-group leader. Closing
  the stream does not stop the command, so the adapter's own deadline and the
  caller's signal run a kill through `POST /sandboxes/{id}/commands`. Every
  command runs under a wrapper that writes its PID to
  `/tmp/.sandbox-sdk/exec/<tag>` before it checks for `<tag>.cancel`; the kill
  writes `<tag>.cancel` before it reads the PID, so a command either never
  starts or its group is killed. The image's `sh` is dash, which rejects
  `kill -- -PID`, so the kill is `kill -KILL -PID`. When Styne's own deadline
  fires first it kills the group and sends `exit` with `timedOut: true` and an
  `error` line with `command_timeout`; both read as a timed-out result with
  the partial output. A stream that breaks or ends without `exit` is
  `outcome_unknown`, after a best-effort kill. A request that never left the
  process (a failed connect) is sent again, at most twice.
- **Files.** Reads and writes use `GET` and `PUT /sandboxes/{id}/files?path=`
  (10 MiB and 40 MiB moved in one request each). The file API creates new files
  and folders as `user` (uid 1000) and keeps the owner of a file it overwrites;
  commands run as root. A `404` on a file route is `file_not_found` after a
  `GET` of the sandbox shows it exists. List, stat, mkdir and remove run the
  shared guest Python programs: Styne's own `DELETE /files` is recursive and
  answers `204` for a missing path, and its list follows symlinks and has no
  modification time.
- **Lifecycle.** `connect` and `find` read with `GET` only; Styne's
  `POST /connect` resumes a paused sandbox and moves its end to at least five
  minutes away. `list` pages `GET /sandboxes?metadata=k%3Dv&limit=100` with
  `nextToken` from `x-next-token` and filters exactly. Delete answers `204`,
  a second delete `404`, and any other call on an ended sandbox `410
sandbox_ended`; `404`, and `410` with `sandbox_ended`, `sandbox_timeout`,
  `node_loss` or `agent_exit`, are `not_found`. `pause` sends `{ tier }` and
  treats `409 already_paused` as done; `resume` treats `409 already_running`
  the same and keeps the new traffic token.
- **Previews.** `https://<port>-<id>.<domain>`, `domain` from the create answer
  (`ash.styne.ai`). The traffic token comes only with create, resume and
  connect answers, so a client that did not create the sandbox calls
  `POST /connect` once for it. Without the token a port answers 401.
- **Snapshots.** The adapter names each one `sbx-<uuid>` before the request, so
  a lost answer is found with `GET /snapshots/{name}`. The name is the ID for
  `from` and for `DELETE /snapshots/{name}` (`204`, then `404`).
- **Errors.** The shared client keeps the HTTP status and `error_code`, never
  Styne's message. `401`/`403` are `auth`; plan and rate refusals (`402`,
  `429`, `quota_exceeded`, `storage_limit` and the rest) are `quota`; a POST
  answered with a `5xx` other than the documented refusals (`capacity`,
  `region_unavailable`, `guaranteed_capacity`, `upstream_unavailable`,
  `resource_exhausted`) is `outcome_unknown`.
