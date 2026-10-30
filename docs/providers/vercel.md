# Vercel provider

Install `@vercel/sandbox` 3.8 or later, then import `vercel` from
`@opencoredev/sandbox-sdk/vercel`. The provider dynamically loads the optional
peer SDK on its first remote operation. `box.native` is typed as Vercel's
`Sandbox`.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { vercel } from "@opencoredev/sandbox-sdk/vercel";

await using box = await createSandbox(vercel(), {
  key: "user:123",
  ports: [3000],
  size: "small",
  network: { allow: ["registry.npmjs.org"] },
});
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout);
```

Authentication uses the Vercel SDK's OIDC context (`VERCEL_OIDC_TOKEN`), or
`VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. Explicit
`vercel({ token, teamId, projectId })` values take precedence over environment
variables. Token authentication requires all three values.

Keys map to deterministic SHA-256 names, unique within the Vercel project.
The adapter uses `Sandbox.get` and `Sandbox.create`, rather than
`getOrCreate`, so the core can distinguish creation from a concurrent
unique-name conflict. Labels become native tags. Vercel allows five tags in
total; the SDK reserves `sandbox-sdk`, plus `sandbox-sdk-key` for keyed boxes.
Extra tags fail with `unsupported`. Discovery filters the SDK tag and then
filters all requested labels locally across every page.

Sizes map to 1, 2, and 4 vCPUs for `small`, `medium`, and `large`, with 2048 MiB
RAM per vCPU. Custom CPU/memory/disk objects fail with `unsupported`, because
Vercel cannot configure disk allocation. `network: "none"` maps to `deny-all`;
allowlists map to native default-deny domain rules. `idleTimeoutMs` is rejected.
Ports must be declared at creation, with at most 15 distinct ports.
`preview()` calls `domain(port)` and rejects undeclared ports.

Commands run detached, stream the native log iterator, and close stdin after
any supplied input. A remote watchdog enforces command timeouts even if the
client disconnects. Timeout and abort terminate the remote process group.
Background processes use the core's durable shell wrapper with core-owned
records and logs, so closing a handle leaves them running. The native process
hook is omitted: its host-side completion bookkeeping could automatically
resume a paused Vercel session.

Pause and snapshots stop the Vercel session. Resume restores the filesystem
into a new session; it does not restore running OS processes. Restored process
records without an exit status are marked failed with exit code 137. Call
`process(name).restart()` to launch them again. The same cleanup runs for
snapshot clones and automatic SDK resumes. Snapshot creation stops the source
box; its next command resumes it. PTYs are not exposed by this adapter.

Creation `timeoutMs` maps to Vercel's native `timeout`, which bounds one
session. Each resume starts a new session with a fresh timeout, so it is not an
absolute lifetime across sessions. Command `timeoutMs` is supported. The
native SDK also expires stored snapshots according to its retention policy.

The offline tests run the full shared suite against a mock SDK backed by real
Linux commands. With either OIDC or all three token environment variables set,
`tests/vercel.live.test.ts` runs the full suite against Vercel:

```sh
timeout 600s bunx vitest run tests/vercel.live.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000
```

Run this command from `packages/sdk`. It creates and deletes billable sandboxes.
The implementation was checked against the official [JavaScript SDK reference](https://vercel.com/docs/sandbox/sdk-reference)
and the published `@vercel/sandbox` 3.8.0 types and source.
