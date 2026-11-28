# Agent 37 provider

Import `agent37` from `@opencoredev/sandbox-sdk/agent37`. The adapter calls
Agent 37's Sandbox API with `fetch`; there is no peer package. Two planes take
the same `sk_live_` workspace key: `control` (`https://api.agent37.com/v1`, or
`AGENT37_API_URL`, `Authorization: Bearer`) creates, reads, sleeps, starts,
forks and deletes instances, and `exec` (`https://sandbox.agent37.app/v1`, or
`AGENT37_EXEC_URL`, `X-Agent37-Key`) runs commands. `box.native` is a
`NativeApi` on both planes (placeholder `{id}`); the provider's `api` property
makes account-level calls. There is no `sdk()` binding.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { agent37 } from "@opencoredev/sandbox-sdk/agent37";

await using box = await createSandbox(agent37(), {
  key: "user:123",
  size: "medium",
  idleTimeoutMs: 30 * 60_000,
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Everything below was checked against the live API on 2026-11-28 (Tier 2
workspace, template `agent37-base`, default `2x4` size, `default` type).

## What Agent 37 gives

- An instance is a Debian 12 container (`agent37-base`: Node.js, Python 3,
  git) on dedicated servers in the US. The image user is `node` (uid 1000) with
  no `sudo` and no `/workspace`; exec takes `user: "root"`.
- Sizes are four fixed tiers, `2x4`, `4x8`, `4x16` and `4x32` (vCPU x GB),
  with disk ranges 2-12, 2-20, 2-40 and 2-80 GB (defaults 4, 6, 12, 24).
  Types are `default` (shared CPU, `us` only), `vm` and `performance`.
- A create answered in about 1.0 s; an exec round trip took about 0.5 s.
  `POST /exec` runs one `sh -c` string and answers once it exits, with stdout
  and stderr capped at 512 KB each; it does not stop the command when the
  request goes away. Request bodies are capped at about 1 MB.
- `POST /sleep` checkpoints memory and disk; `POST /start` restores it, and
  processes kept running across a sleep and start. A sleep that cannot save
  memory answers `502 memory_not_saved` and the instance boots fresh.
- `POST /fork` makes a new instance from an existing one; a fork took about
  24 s. `metadata` on create and fork is stored and returned on reads.
- `POST /signed-url { port, ttl_seconds }` returns a URL with an `a37_token`
  query parameter and an expiry. `POST /public-ports { port }` returns a
  permanent public URL; a second call for the same port is `public_port_exists`.
  A public port answered `200` from outside.
- `GET /v1/billing` returns `balance_usd` and `past_due`; `GET /v1/usage`
  returns spend by UTC day and instance, settled hourly. Compute is metered per
  minute: $0.80 per vCPU-month, $0.70 per GB-month of memory and $0.09 per
  GB-month of disk (730 hours a month); sleeping and stopped instances bill
  disk alone. A create needs one day of the running rate in the wallet
  (`402 insufficient_balance` otherwise).

## Create

- The body carries `template` (default `agent37-base`), `type`, `name:
"sandbox-sdk"`, optional `region`, `resources` from `size`, `env` and
  `network` (`"none"` is `deny-all`, `"all"` is `allow-all`, an allow list of
  at most 100 entries), and `metadata` with your labels, the key and a
  per-call allocation ID. `keyMode` is `best-effort`.
- A create's answer is trusted only when its metadata carries this call's
  allocation ID. A lost or unreadable answer is settled by listing the
  workspace and taking the instance with that ID; none found is
  `outcome_unknown`.
- Readiness: `running`, then a root setup command that makes `/workspace` and
  `/tmp/.sandbox-sdk/exec` and checks `python3`, `setsid`, `base64`, `tail`,
  `head` and `wc`. A failure or abort after the create deletes the instance on
  a fresh 30-second deadline.
- `timeoutMs` is refused (no hard lifetime). `idleTimeoutMs` sets
  `auto_sleep: true` and `idle_timeout_seconds`, rounded up, from 300 to
  86,400; anything else is `unsupported`.
- `find(key)` lists instances whose metadata holds the key and skips `failed`
  ones. `connect` is a read and never wakes a sleeping instance.

## Commands

- Each user command runs as `set -- wrapper cwd command tag stdin` followed by
  a supervisor, so no large argument passes through `execve`. The supervisor
  stages stdin (base64) to a file, runs the wrapper under `setsid -w` with
  stdout and stderr in files under `/tmp/.sandbox-sdk/exec/<tag>`, and once it
  exits asks the kernel (`kill -0 -PGID`, from outside the group) whether the
  group still has members; only "No such process" removes the PID record.
  Per-run `env` becomes `exec env K=V ... sh -c <command>`.
- The wrapper records its PID before it checks for a cancel marker. The killer
  writes the marker before it reads the PID, kills the group, and exits 0 only
  when `kill -0` answers "No such process". A timeout or abort runs it on a
  fresh deadline; a kill that cannot be confirmed is `outcome_unknown`.
- A stream of at most 256 KiB is printed in the exec answer and its file
  removed; a bigger one stays in its file and is read back in chunks of
  368,640 bytes, then removed. The answer ends with a trailer line naming the
  tag, the exit status and both stream sizes; an answer without it is a
  provider error.

## Files, previews, lifecycle

- Paths resolve against `/workspace`. Reads and writes go through commands in
  base64 chunks (368,640 bytes per read, 524,288 per write, four in flight),
  so every request stays under the 1 MB body cap and every answer under the
  512 KB output cap. A 10 MB write took 5.4 s and a read 5.1 s live.
- Previews are signed URLs by default (`previewTtlMs`, default one hour); the
  token is registered for redaction. `public: true` makes a public port, one
  URL per port, cached per client.
- `pause` is `POST /sleep` (an instance already asleep is fine; `try_again` is
  retried); `resume` is `POST /start` and waits for `running`.
- `snapshot` forks the instance into a stopped instance with
  `metadata.sandbox_sdk_snapshot` and returns its ID. `from` forks that
  snapshot again; `env` and `network` are refused there, since a fork keeps the
  source's. `deleteSnapshot` deletes the snapshot instance; a missing one is
  `false`. `expiresInMs` is refused. `list` leaves snapshots out.
- Errors carry the HTTP status and a documented Agent 37 error code; the key
  and preview tokens are redacted.
