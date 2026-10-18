# Sandbox SDK core

`@opencoredev/sandbox-sdk` 1.0.0 is ESM for Node 22+ and Bun 1.3+. The root exposes lifecycle functions, `SandboxError`, and the public handle types. Provider adapters import the primitive contract from `/provider`; `/memory` supplies an offline fake; `/testing` registers the shared Vitest suite.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

await using box = await createSandbox(memory());
await box.files.write("hello.txt", "hello\n");
const result = await box.$`cat ${"hello.txt"}`;
console.log(result.stdout);
```

The result is `hello` followed by a newline. Commands are lazy: awaiting or iterating a `RunHandle` starts execution, after its chained options have been applied. Iteration streams live output; awaiting returns the capped result. Stream failures throw `SandboxError`. Nonzero exits, timeouts, and aborts return results.

## Implement an adapter

Implement `Provider<Native, CapabilityLiterals>` from `src/provider.ts`. The capability type parameter must be the literal union the adapter actually supports, such as `"pause" | "snapshot"`. It controls optional handle methods. Runtime capability declarations must have matching hooks.

- `create` receives native resource options, SDK labels, and the merged environment. Honor size, network policy, hard lifetime, and idle timeout, or reject with `unsupported`. Never silently drop restrictions. `find` and `list` should restrict discovery to SDK-created resources.
- `keyMode: "exact"` means the native resource name is unique. `find` must return that same native resource for a key. `connect` reports `not_found` for stale IDs.
- `exec` closes stdin, emits stdout/stderr chunks in arrival order, and settles only after the remote process group is terminated on timeout or abort. Return nonzero exits without throwing. Stream decoding belongs in the transport so split UTF-8 sequences survive.
- File paths are absolute POSIX paths. `mkdir` creates parents and succeeds for existing directories. `list` returns immediate children with absolute paths. `read` and `write` transfer bytes unchanged. Missing files use `file_not_found`; missing sandboxes use `not_found`.
- `previewUrl` returns the URL and any required access headers and expiry. Core performs HTTP probing when requested.
- `native` returns the fully typed client. `close` detaches local transport resources; it must leave the remote sandbox running.
- Optional native process hooks must keep their process alive when local resources detach. Core owns the durable records and log framing. A shell fallback requires Linux `sh`, `setsid`, `nohup`, `mkfifo`, GNU `sed -u`, and standard file utilities. File checkpoints require Git, and directory transfer requires tar.

All provider errors must use `SandboxError`. Core wraps unknown failures and sanitizes native causes to prevent nested credential objects from escaping. File reads preserve data exactly; command output, process output, search results, patches, and errors are redacted. Reconnect restores redaction values by reading the recorded secret variable names from the sandbox environment. That environment must survive connection changes.

Run conformance from a provider test file:

```ts
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { runConformance } from "@opencoredev/sandbox-sdk/testing";

runConformance(() => memory(), { live: false });
```

Use `timeout 120s vitest run --maxWorkers=4`. Cloud providers require `live: true`; the caller gates that flag on its credentials. `/testing` imports Vitest through an optional peer dependency. The core and memory entry points have no runtime package dependencies.

## Memory behavior

Each `memory()` instance owns an isolated virtual filesystem and process table. It never launches host programs or contacts the network. The handler table includes echo, printf, cat, ls, pwd, true, false, sleep, exit, and printenv. It supports quotes, variable interpolation, sequential commands, conditional lists, redirection, and per-call cwd/env. It is a shell subset, not a full POSIX shell. Custom handlers must honor their abort signal and must not perform external effects.

Register handlers with `memory({ handlers })` or `provider.register(name, handler)`. Handlers receive arguments, cwd, environment, stdin, abort signal, stdout/stderr callbacks, and scoped file primitives. Memory uses portable byte snapshots and recursive file transfer instead of Git and tar. Its conformance suite explicitly skips real Git and HTTP probes. Fake previews end in `.memory.invalid`.

## Limits and spec clarifications

- A two-function locator cannot enforce cross-host uniqueness: `get` followed by `set` is not atomic. A best-effort provider accepts it for cached lookup and stale-ID recovery. Requesting `keyMode: "exact"` additionally requires `locator.withLock(key, action)`, implemented with a distributed lock or transaction. Core also serializes same-key calls on one provider instance within the current JS realm.
- `reapSandboxes({ idleOnly: true })` means no active SDK run record and no running SDK background process. It does not infer provider-specific idle state or account for commands launched outside the SDK. A server crash can leave a run record behind; cleanup is conservative.
- Persistent process logs rotate at 10 MB. Native output waiting for storage is capped at 1 MB; if a producer outruns storage, older pending records are discarded and the cursor advances. A stale cursor returns `truncated: true`. The shell fallback records partial chunks and conservatively masks secret fragments at chunk boundaries. Incomplete lines retain at most 1 MB and carry a truncation marker.
- Linux native hooks launch the same durable shell wrapper as the fallback, so log capture survives loss of the host client. Memory captures output in-process because its entire sandbox lifetime is in-process.
- The root module loads the handle implementation on first creation/connection. The size gate measures the minified root entry (under 8 KB); feature chunks are reported separately. This is an entry-size budget, not an 8 KB budget for all SDK features combined.

Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun run test` from this package. The test script also enforces the root size and zero runtime dependency checks.

## Give an agent a sandbox

Install the framework you use and `zod`. Import its adapter, then pass the tools to your agent:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { sandboxTools } from "@opencoredev/sandbox-sdk/ai";

await using box = await createSandbox(memory());
const tools = sandboxTools(box);
```

`/ai` returns an AI SDK tool map; `/mastra` returns a Mastra tool map; `/openai` returns an OpenAI Agents tool array. The adapters require AI SDK 7, Mastra 1.78, or OpenAI Agents 0.20 respectively, and Zod 4.6. They are optional peers and never load through the SDK root. `/tools` exposes `createSandboxTools`, `toolSchemas` (Zod schemas, convertible with `z.toJSONSchema`), and the shared option and event types for other integrations.

The default tools are `run`, `read_file`, `write_file`, `edit_file`, `start_process`, `process_logs`, and `stop_process`. Use `allow` to opt into `search`, `list_files`, `changes`, or `preview`; `deny` takes precedence. Parameters are flat and validated. `read_file` uses zero-based line offsets, returns numbered lines and a SHA-256, and reports `nextOffset` for pagination. Binary files return metadata. Edits require exactly one literal match; they do not provide optimistic concurrency checks.

```ts
const tools = sandboxTools(box, {
  root: "/workspace/app",
  allow: ["run", "read_file", "edit_file", "start_process", "process_logs", "stop_process"],
  beforeRun: command => command.includes("rm -rf") ? false : command,
  limits: { run: { timeoutMs: 30_000, maxOutputBytes: 16_384 } },
  onEvent: event => sendToUI(event),
});

function sendToUI(event: { text: string }) {
  process.stdout.write(event.text);
}
```

`beforeRun` returns `false` to deny, a string to rewrite, or `true` to allow. It also applies to `start_process`. The `root` confines file parameters and working directories and rejects symlink components. It is not an OS security boundary: shell commands retain the sandbox's privileges, can use absolute paths, and can change directories. Configure sandbox isolation and command policy for untrusted agents. File checks cannot prevent a concurrent process from changing a path after validation.

Each result starts with `OK` or `FAILED`, followed by `output:`. Nonzero exits and timeouts are results. Commands default to a 30-second timeout; caller timeouts cannot exceed the configured tool limit. Output defaults to a 16,384-byte budget, with head and tail retained and a cut marker. The minimum budget is 256 bytes. Per-tool limits also support `maxReadBytes` (default 1 MB for reads) and `maxMatches` (default 100 for search).

Truncated foreground output includes a generated name and `cursor=0` for `process_logs`. The replay window retains the last 1 MB of each of the eight most recent foreground runs or long-line reads per tool collection; expired bytes are labeled. Background logs read the SDK's durable process records, normalize and redact them before paging, and return tool-specific byte cursors. These cursors are not interchangeable with `box.process(name).logs()` cursors; restart at zero after log rotation. File pagination stops at line boundaries where possible. A single line larger than the output budget includes a `process_logs` replay name and cursor so the cut content remains readable. Search, listings, and change summaries are capped summaries; narrow the path or query when they are cut. `changes` compares file hashes within `root` against a snapshot taken when the tools are created.

`onEvent` receives redacted foreground chunks and requested log pages before model formatting. Framework cancellation signals stop foreground runs; returning an AI preliminary iterator aborts and awaits its command. AI SDK also receives those foreground chunks as preliminary results; its `toModelOutput` returns only the final compact result to the model. Consumers that fall behind AI preliminary output have a bounded 1 MB queue. Background startup waits for a supplied `port`; without a port it confirms launch only. A readiness timeout returns `ready=false` and leaves the process available for logs or stopping. Preview access headers stay server-side. Registered sandbox secrets are redacted from every model result, including file contents, errors, and preview URLs; raw `box.files.read` remains unchanged. Tools require handles created or connected by this SDK so their secret redactor is available.

Framework API references checked for these adapters: [AI SDK tool](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool), [Mastra createTool](https://mastra.ai/reference/tools/create-tool), and [OpenAI Agents tools](https://openai.github.io/openai-agents-js/guides/tools/).

## Local Docker

Import `local` from `@opencoredev/sandbox-sdk/local` and pass `local()` to `createSandbox`. Docker Engine must be running and accessible at `unix:///var/run/docker.sock`. Set `DOCKER_HOST` or `local({ dockerHost })` to another absolute `unix://` socket. Remote TCP engines are unsupported because preview URLs must reach this machine.

The default image is `node:22-bookworm`. The adapter pulls it when absent and reuses it thereafter. `local({ image })` selects another image; it must contain Node, Git, tar, setsid, nohup, mkfifo, GNU sed, and standard Linux utilities. Snapshot IDs select locally committed images through `{ from: id }`.

Size presets set CPU quotas and hard memory limits, with swap disabled: `small` = 1 CPU / 1024 MiB, `medium` = 2 CPUs / 4096 MiB, and `large` = 4 CPUs / 8192 MiB. Omitted size uses Docker defaults. Custom sizes are rejected because their required `diskGb` limit cannot be enforced portably. Idle and hard lifetime options are also rejected: Docker does not provide durable timers for these restrictions.

`network: "none"` uses Docker's isolated network namespace with loopback only. Domain allow-lists fail with `unsupported`. The default network is Docker bridge. Declare preview ports at creation; each maps to an ephemeral host port bound exclusively to `127.0.0.1`. Omitting `ports` declares port 3000. Previews are accessible on the Docker host. They are unavailable with network `none`.

Keys map to SHA-256 container names for Docker-enforced uniqueness. Discovery is restricted to containers labeled `sandbox-sdk=1`. Pause/resume use Docker pause/unpause. Snapshots use Docker commit and persist as local images until explicitly removed through Docker. `close()` leaves the container and detached background processes running. `destroy()` removes the container and anonymous volumes, while preserving the shared base image.

Exec streams Docker's framed stdout/stderr, closes stdin after the supplied input, and kills the command's process group on timeout or abort. Files transfer through Node exec with base64 encoding, preserving binary bytes; core directory upload/download uses tar. Usage combines core command/output counters with container creation time. No Docker CLI, dockerode dependency, or container-side SDK daemon is required.

Run live verification with `timeout 1200s env SANDBOX_LOCAL_LIVE=1 bunx vitest run packages/sdk/tests/local.live.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000`. The suite creates labeled containers and removes its containers and snapshot images.
