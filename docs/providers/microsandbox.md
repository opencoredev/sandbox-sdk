# Microsandbox provider

Import `microsandbox` from `@opencoredev/sandbox-sdk/microsandbox`. The adapter
is a hybrid. The control plane (`https://api.microsandbox.dev/v1`, or
`MSB_API_URL` plus `/v1`, with `Authorization: Bearer <key>`) creates, reads,
lists, starts, stops, snapshots and deletes sandboxes and owns Services, all
over `fetch`. Commands and files go through the sandbox's guest agent, whose
protocol (length-prefixed CBOR frames and a bulk WebSocket) only the official
`microsandbox` package speaks, through a native addon. `microsandbox` is an
optional peer (`^0.8.1`). `box.native` is a `NativeApi` on the plane `control`;
its `sdk()` builds a `RemoteContext` with the adapter's key, URL and tier and
returns the sandbox from `context.sandboxes.get(name)`.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { microsandbox } from "@opencoredev/sandbox-sdk/microsandbox";

await using box = await createSandbox(microsandbox({ computeType: "standard" }), {
  key: "user:123",
  size: { cpu: 4, memoryMb: 8192, diskGb: 64 },
  timeoutMs: 30 * 60_000,
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Authentication uses `MSB_API_KEY` (an organization key, `msb_...`), or
`microsandbox({ apiKey })`, which takes precedence. A missing or blank key
fails with `auth` before any request. Every error is redacted of the key and
of any `msb_...` or `msb_pat_...` token, registered or not; an error `code` is
shown only when redaction leaves it unchanged, and the peer's messages go only
into `cause`, redacted. Writes follow no redirect, so none is sent twice.

## The peer

`create()` loads `microsandbox` and constructs
`new RemoteContext({ url, apiKey, requestTimeoutMs, computeType })` before it
sends anything. The context is built once per provider, with explicit options,
never from `MSB_*` variables or the peer's process-wide defaults, and never
through the static `Sandbox.get()`. A missing package fails with `unavailable`
naming `Install microsandbox`. A package that loads but whose native addon
cannot (optional dependencies omitted, so no
`@superradcompany/microsandbox-<platform>`; or a bundle that inlined it, so
`../native/index.cjs` is not beside it) fails with `unavailable` naming
`Keep microsandbox external`. Either way no sandbox is made. A failed setup
is retried on the next call.

`microsandbox@0.8.1`'s published manifest omits its platform
`optionalDependencies`, so on that version the platform package has to be
installed by hand next to it for commands to run.

## Create

`POST /v1/sandboxes?start=true&wait_for=running&wait_timeout=60` with the
nested envelope `{ spec, compute? }`:

- `spec.source`: `"oci"` with `reference` (the factory's `image`, default
  `node:22-bookworm`), or `"disk_snapshot"` with
  `disk_snapshot_ref: { type: "managed", id }` for `from`. A `from` that is not
  a UUID is a snapshot name, looked up with `GET /v1/snapshots/by-name/{name}`.
- `spec.name`: `sbx-<uuid>`, chosen before the request.
- `spec.labels`: the caller's labels, the key as `sandbox-sdk-key`, and a fresh
  `sandbox-sdk-alloc` naming this one `create()` call.
- `spec.resources`: omitted without `size`, so the cloud's default applies.
  Presets are small 1/1024, medium 2/4096, large 4/8192 (vCPUs/MiB). An exact
  size needs whole `cpu >= 1` and `memoryMb >= 128`; `diskGb` becomes
  `disk_size_mib = round(diskGb * 1024)`. A restore takes only `vcpus` and
  `memory_mib`, and `diskGb` with `from` is `unsupported` before any request.
- `spec.lifecycle`: `ephemeral: false` (a snapshot needs a stopped sandbox,
  which an ephemeral one would not survive), `max_duration_secs` from
  `timeoutMs` (default 1 hour), `idle_timeout_secs` from `idleTimeoutMs`.
- `spec.network`: `{ enabled: true }` for `"all"`, `{ enabled: false }` for
  `"none"` or an empty allow list, and otherwise a policy with
  `default_egress: "deny"`, `default_ingress: "allow"` (Services keep working)
  and one egress allow rule per entry: `{ domain }`, `{ domain_suffix }` for
  `*.domain`, or `{ cidr }` for an IPv4 address or CIDR. Anything else is
  `unsupported`.
- `compute: { type }` when `computeType` is set. Kept nested: an API that
  ignored a flat field could pick the wrong tier.

Before the request, the adapter awaits the `create` hook with
`{ name, allocId, from, labels }`, so a harness can journal the attempt; a
rejection, or an abort, sends nothing.

A 4xx refusal, or a request that never left the process, is final. Anything
else (a lost or timed-out answer, a 5xx, the caller's abort after sending, an
unreadable answer, or one whose `spec` is not resolved yet) is settled on a
fresh 60-second deadline: `GET /v1/sandboxes/by-name/{name}` is read with
backoff across 404s (for 15 seconds) and across `spec: null`. Labels are read
only from `spec.labels`; `SandboxResponse` has none at the top level. Only a
sandbox whose `spec.labels["sandbox-sdk-alloc"]` is this call's is returned or
deleted. Another marker under the name is left alone and reported as
`outcome_unknown`; so is a name never found, and the error names it.

Once the sandbox is this call's:

1. An abort deletes it and throws `aborted`.
2. With `computeType`, `compute.type` must match, else it is deleted and the
   create fails with `provider`.
3. `created` is started (`POST /v1/sandboxes/{id}/start?wait_for=running`, a
   409 waited out) and `created` or `starting` is polled until `running`, on a
   180-second deadline; `failed` or any other end state deletes it and throws.
4. `/workspace` is made through the guest agent.

Any failure in these steps deletes the sandbox on a fresh deadline before the
error is thrown; a delete that cannot be confirmed is `outcome_unknown`.

The sandbox's ID is its immutable `SandboxResponse.id`; the adapter keeps
`id -> name` in memory and reads `GET /v1/sandboxes/{id}` on a miss.
`list()` and `find()` page `GET /v1/sandboxes?labels=<JSON>` and filter again
locally: every label must match, and with `computeType` only sandboxes on that
tier count, so a standard client never sees a shared sandbox. `find()` skips
`failed` sandboxes and prefers one whose status is `running`. Without one, a
`starting` match is waited for, and a stopped one (its lifetime or idle
timeout ended; `stopping` and `saving_state` are waited out first) is started
again, unless the lookup was aborted; the signal also ends the waits. `isStopped(id)` is true only for
`stopped` and `failed`, so idle-only reaping counts only those idle without a
probe, and skips any other non-running sandbox for that sweep.

A stop ends every guest process but leaves its record on the disk, which a
restart or restore keeps. Right after the adapter boots a guest itself (a
restore, the start in `find()`, the restart after a snapshot), it compares the
kernel's `/proc/sys/kernel/random/boot_id` with `/tmp/.sandbox-sdk/boot-id`.
On the first run in a boot it marks every record without an exit as killed
(137), drops the run markers, and writes the new ID; later runs in that boot
change nothing. A client that was already connected when another client
restarted the sandbox can read the old records until that repair finishes, and
a record it writes in that window is marked killed too. Closing that window
needs a boot generation in the core's process records, which every adapter
shares.

## Commands

`await context.sandboxes.get(name)`, then
`sandbox.execStreamWith("sh", b => b.args(["-c", command]).cwd(cwd).envs(env).tty(false)...)`
with `stdinBytes(Buffer.from(stdin, "utf8"))` when `stdin` is set, else
`stdinNull()`. Events are decoded with one `TextDecoder` per stream
(`stream: true`, flushed at the end), so a multi-byte character split across
chunks never mixes with the other stream, and chunks are emitted in arrival
order. The exit code comes from the `exited` event, or `wait()` when the
stream ends first.

The guest agent lookup (`sandboxes.get`, and the name read behind it) runs
inside the command's timeout and abort: one that fires first reports
`{ exitCode: null, timedOut: true }`, as nothing was started. The lookup itself
has a `requestTimeoutMs` deadline, as does loading the peer, and a failed or
stalled one is dropped so the next command tries again. Each read of the
stream races the stop with one removable abort listener, so a long stream never
adds reactions to a shared promise.

A timeout or abort before `execStreamWith` hands back its handle leaves the
start unknown: the late handle is killed and waited for when it arrives, and
the call fails with `outcome_unknown`. After the handle, the adapter calls
`kill()` and then `wait()` on a fresh 30-second deadline; only both succeeding
reports `{ exitCode: null, timedOut: true }`, otherwise `outcome_unknown`. A
command is never sent twice. A launch refused because the sandbox is not
running or not found is reported as such; any other launch failure is
`outcome_unknown`.

Whether the cloud guest agent's `kill()` reaches the whole process group is
documented for `msb exec` (since 0.6) but not yet verified live through the
cloud `RemoteContext`; the live test checks it.

## Files

`read` and `write` use the peer's `sandbox.fs()`. A filesystem error that
reads as a missing path is `file_not_found`, and a write to a missing parent
makes the parents and retries. `list`, `stat`, `mkdir` and `remove` run the
SDK's shared guest metadata program (python3) through the guest agent, so
types, symlinks, sizes and times match other providers. Modes are applied by
the core with `chmod` after a write.

## Previews (Services)

`previewUrl(id, port)` returns a Microsandbox Service's public URL. The slug is
`sbx-<first 16 hex of the sandbox ID>-p<port>`. An existing Service at that
slug is reused only when it is `enabled` and targets this sandbox's name and
this port; otherwise, and on a 409 (the slug belongs to someone else), the
adapter uses `<slug>-<4 hex>` once and never touches the other Service. The
slug is passed to the `service` hook and kept in memory before
`POST /v1/services { slug, target: { sandbox: name, port } }`. A lost answer is
settled with `GET /v1/services/{slug}`.

`destroy(id)` gathers candidate Services from memory and from
`GET /v1/services?sandbox={name}`, keeps only slugs of the adapter's shape for
this ID that still target this sandbox (or nothing, once it is detached),
deletes each (404 is gone), and then always runs
`DELETE /v1/sandboxes/{id}`, even when a Service could not be removed. A
Service that failed stays in memory and the call fails after the sandbox is
deleted, so destroying again finishes it. A Service listing that fails, or a
sandbox name that cannot be read (not a 404), is reported the same way, after
the delete. The ID is remembered before the DELETE is sent, and the next destroy reads the whole Service
list for detached slugs of this ID's shape that memory cannot prove. It names
them in its error and never deletes them. Microsandbox accepts a DELETE before it finishes, so an accepted
delete is confirmed by reading `GET /v1/sandboxes/{id}` until it answers 404,
on its own 60-second deadline; a sandbox that still reads then fails with
`outcome_unknown`, as does a failed create whose cleanup it was.

## Snapshots

`snapshot(id)` rejects `expiresInMs` with `unsupported`. It picks
`sandbox-sdk-<uuid>` and awaits the `snapshot` hook with it before touching the
source. A running source is stopped (`POST /v1/sandboxes/{id}/stop`, polled to
`stopped`). Then
`POST /v1/snapshots { kind: "disk", sandbox_id, name, labels: { "sandbox-sdk-source": id } }`
answers `202` with an operation, polled with
`GET /v1/snapshot-operations/{id}` until it succeeds or fails, on a 10-minute
deadline.

- A 4xx refusal (400, 403, 404, 409, 422) restarts a source that was running
  and throws the refusal.
- A lost answer is settled by `GET /v1/snapshots/by-name/{name}` and the
  operations list (matching `snapshot_name`), on a fresh deadline; still
  unsettled, the source is restarted and the call fails with
  `outcome_unknown` naming the snapshot.
- A failed operation restarts the source and throws.
- A result must be in managed storage and captured from this sandbox
  (`sandbox_id`, or the `sandbox-sdk-source` label); otherwise it is never
  returned.
- The returned ID is the managed `location.id`. A source that cannot be
  restarted afterwards fails the call with an error naming that ID and name,
  so the snapshot is never lost.

`deleteSnapshot(id)` sends `DELETE /v1/snapshots/{id}` for a UUID and falls
back to `DELETE /v1/snapshots/by-name/{id}`; `false` when both answer 404.

## Pricing

Standard compute: $0.048 per vCPU-hour, $0.003 per GiB-hour of memory,
$0.0000625 per GiB-hour of root disk ($0.220/h for 4 vCPU, 8 GiB, 64 GiB).
Shared: $0.007, $0.000375 and $0.0000625 ($0.035/h at the same size). A
stopped persistent sandbox keeps billing its disk until it is deleted.
Managed snapshots are $0.08 per GiB-month.

## Not yet verified live

The adapter was built from the OpenAPI document, the docs and the official
SDK's source before an account was available. The live test
(`SANDBOX_MICROSANDBOX_LIVE=1`, `MSB_API_KEY`, optional `MSB_COMPUTE_TYPE`)
checks: the Services routes, `compute.type` on create, default resources and
disk, `/workspace`, process-group kill, snapshot stop/capture/restart and
restore, and Service cleanup.
