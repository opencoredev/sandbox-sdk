# Sandbox SDK 1.0 spec

The pitch: "Sandboxes for your agents and your users. Any provider, one line."

The library must be simple to start with and powerful when you need more. It talks directly to each provider's own SDK with your keys. There is no hosted middleman and no daemon installed in the sandbox.

This spec is the single source of truth for the rewrite. If an implementation choice isn't covered here, pick the simplest option that keeps the stated guarantees, and note it in your PR.

## 0. Ground rules

- **Package.** Single package, `@opencoredev/sandbox-sdk`, version `1.0.0`, ESM only, Node 22+ and Bun 1.3+. Each provider is a subpath export. Where a provider's API works over `fetch`, the adapter calls it directly and needs no other package: installing `@opencoredev/sandbox-sdk` is the whole install. Providers whose protocol `fetch` can't carry (bidirectional gRPC, a local runtime) keep their SDK as an optional peer dependency, imported dynamically on first use. Each provider page says which kind it is.
- **Peer guarantees.** The build keeps an explicit list of provider and framework packages external (`packages/sdk/scripts/externals.ts`), never derived from `peerDependencies`, and fails if any `node_modules` code lands in `dist`. Removing a peer can never bundle a dev-installed SDK. The types follow the same rule: no declaration imports a package that is not a declared peer of that subpath, so a consumer with no peers installed typechecks with `skipLibCheck` on or off. `smoke:consumer:nopeers` proves both from the packed tarball on Node 22 and Bun.
- **Core size.** Core has zero runtime dependencies (no zod). The root entry stays under 8 KB minified, enforced by a size check in CI.
- **One obvious way.** No aliases, no `run`/`exec`/`execute` trio, and options are objects with explicit units (`timeoutMs`, `maxOutputBytes`). Root exports stay at about 25 names or fewer.
- **Errors.** A non-zero exit code is a result, never a throw. The SDK throws only when the sandbox, the provider, or the request itself fails, and it always throws `SandboxError` (section 9).
- **No lying.** Methods for optional capabilities exist on the type only when the provider supports them. At runtime, `box.capabilities` lists the same set. When a requested option can't be enforced (network policy, size), creation fails and does not silently ignore it.
- **Defaults stop footguns:**
  - every command has a timeout;
  - stdin is closed;
  - non-interactive env vars are set;
  - output is capped;
  - the default working directory is `/workspace`;
  - `cd` and `export` never carry over between calls.
- Follow `~/.agents/skills/typescript-best-practices/SKILL.md`.

## 1. Getting a sandbox

```ts
import { createSandbox, connectSandbox, listSandboxes, reapSandboxes } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using box = await createSandbox(e2b({ template: "base" }), {
  key: `user:${userId}`,          // optional. get-or-create. box.created tells you which.
  size: "small",                   // "small" | "medium" | "large" | { cpu, memoryMb, diskGb }
  env: { NODE_ENV: "development" },
  secrets: { GITHUB_TOKEN: token },// injected as env, redacted from every output/log/error
  network: "all",                  // "all" | "none" | { allow: ["registry.npmjs.org", ...] }
  ports: [3000],                   // declared up front (Vercel needs this; others ignore)
  idleTimeoutMs: 15 * 60_000,      // auto-stop/pause when idle (native where supported)
  timeoutMs: 60 * 60_000,          // hard max lifetime
  labels: { app: "builder", userId },
  signal,                          // abort creation; a sandbox that arrives late gets destroyed
});
```

- **Get-or-create.** `createSandbox(provider, { key })` finds the sandbox by key or creates it.
  - Each provider adapter declares `keyMode: "exact" | "best-effort"`. Exact means the provider enforces unique names: Vercel named sandboxes, Docker container names, memory. Best-effort means lookup by tag or metadata (E2B, Daytona) and can race.
  - For exact mode on best-effort providers, pass `locator: { get(key), set(key, id), delete?(key) }`. It is a two-function interface any KV store can back.
  - A stale stored ID gets recreated transparently.
- **Lookup and cleanup.**
  - `connectSandbox(provider, id)` reattaches by native ID.
  - `listSandboxes(provider, { labels? })` returns `{ id, key?, labels, state, createdAt }[]`, covering only sandboxes this SDK created, which carry the `sandbox-sdk` label.
  - `reapSandboxes(provider, { olderThanMs?, labels?, idleOnly? })` destroys matching sandboxes and returns the count.
- **Closing vs destroying.**
  - `box.close()` detaches local resources and leaves the sandbox running.
  - `box.destroy()` kills it.
  - `await using` / `[Symbol.asyncDispose]` calls `close()` when a `key` was given, otherwise `destroy()`.
- **Machine size.** Each adapter maps `size` presets to native settings and documents the mapping. A size the provider can't honor makes creation fail with `unsupported`, naming what the provider allows.

## 2. Running commands

```ts
const r = await box.run("pnpm test", { cwd: "app", env: {}, timeoutMs: 120_000, stdin: "y\n" });
// r: { ok, exitCode, stdout, stderr, output, durationMs, truncated, timedOut, cwd, command }

for await (const chunk of box.run("pnpm install")) ui.write(chunk.stream, chunk.text);
// RunHandle is both PromiseLike<RunResult> and AsyncIterable<OutputChunk>

await box.$`git clone ${url} app`;            // tagged template, every interpolation shell-escaped
await box.$`ls ${dir}`.cwd("/workspace");     // same RunHandle, chainable .cwd/.env/.timeout
```

**Defaults:**
- `timeoutMs` 120 000.
- `maxOutputBytes` 1 MB kept per stream in `RunResult`. Beyond that, keep the head and tail, set `truncated: true`, and put a marker in the middle.
- stdin closed unless given.
- Env always includes `CI=1 PAGER=cat GIT_TERMINAL_PROMPT=0 DEBIAN_FRONTEND=noninteractive TERM=dumb NO_COLOR=1`.

**Results:**
- `output` is stdout and stderr interleaved in arrival order.
- `cwd` is the resolved absolute path.
- On timeout or abort, the SDK kills the whole remote process group and returns `{ timedOut: true, exitCode: null, ok: false }` with the partial output. It does not throw.
- `signal` aborts both the call and the remote process.

## 3. Background processes and previews

```ts
const dev = await box.start("pnpm dev --port 3000", {
  name: "dev",                                  // unique per sandbox; reattach by name
  cwd: "app",
  ready: { port: 3000 } | { http: { port: 3000, path: "/" } } | { log: /Local:/ },
  readyTimeoutMs: 60_000,
});
dev.url;          // preview URL when ready included a port, verified to answer
dev.status;       // "starting" | "running" | "exited" | "failed"
for await (const line of dev.lines({ after: cursor })) {}   // line: { text, stream, cursor }
const page = await dev.logs({ after: cursor, maxBytes: 16_384 }); // { text, nextCursor, truncated }
await dev.stop();                                // SIGTERM, then SIGKILL after graceMs; idempotent
await dev.restart();
const exit = await dev.wait();                   // { exitCode, signal }

box.process("dev");      // reattach from anywhere: works after the app server restarted
await box.processes();   // [{ name, command, status, pid, ports, startedAt, exitCode }]
const p = await box.preview(3000, { path: "/", waitMs: 10_000 }); // { url, headers?, expiresAt? }
```

**Process records.**
- Process records and logs live inside the sandbox under `/tmp/.sandbox-sdk/procs/<name>/`, in `spec.json`, `pid`, `exit`, and `out.log`. Logs rotate at 10 MB.
- Native process APIs are used where a provider has them. The shell shim is the fallback.

**Readiness.**
- If the process exits before it's ready, `start` throws `SandboxError{ code: "process_exited" }` with the exit code and the last 50 log lines.
- If readiness times out, the process keeps running, the handle reports `ready: false`, and the error carries the log tail.

**Cursors and memory.**
- Cursors are opaque, serializable strings, so a different server process can resume reading.
- Host-side buffering per process is bounded at 1 MB.

**Previews.**
- `preview()` returns provider-correct access, including the Daytona token header and an expiry where relevant.
- The SDK checks the URL from outside before returning it when `waitMs` is set.

## 4. Files

```ts
await box.files.write("app/index.ts", code);                  // string | Uint8Array; creates dirs
await box.files.write({ "a.ts": "...", "b/c.ts": "..." });     // many at once
const text = await box.files.read("app/index.ts");             // string
const bytes = await box.files.read("logo.png", { as: "bytes" });
await box.files.edit("app/index.ts", { find: "foo()", replace: "bar()" }); // must match exactly once
await box.files.list("app", { recursive?: true, glob?: "**/*.ts" }); // [{ path, type, size, modifiedAt }]
await box.files.stat(path); await box.files.exists(path); await box.files.remove(path, { recursive });
await box.files.upload("./starter", "app", { ignore: [".git", "node_modules"] }); // tar under the hood
await box.files.download("app/dist", "./out");
await box.files.search("TODO", { path: "app", glob: "*.ts", maxMatches: 200 }); // [{ path, line, text }]
const stop = box.files.watch("app", (e) => {}, { recursive: true }); // { type, path } events
const diff = await box.files.changes({ since: "start" });      // { added, modified, removed, patch }; needs createSandbox(p, { trackChanges: true })
```

- Relative paths resolve against `/workspace`.
- `edit` fails with `edit_not_found` or `edit_not_unique`, including the line numbers of the matches.
- `changes` compares against `box.files.mark()` for a named checkpoint, or against a snapshot taken at create time when the sandbox was created with `trackChanges: true` (off by default, so creating a sandbox costs no extra round trips). It works on any provider by using git internally on a hidden index.

## 5. Git

```ts
await box.git.clone(url, { dir: "app", branch?, depth?, token? }); // token never in argv/history/logs
await box.git.status("app");  await box.git.diff("app");
await box.git.commit("app", { message, all: true, author? });
await box.git.push("app", { token?, remote?, branch? });
await box.git.checkout("app", { branch, create? });
```

These run through `run`, with credentials passed through a temporary credential helper.

## 6. Optional capabilities (type-gated)

| Method | Returns |
|---|---|
| `box.pause()` / `box.resume()` | `void` |
| `box.snapshot()` | `{ id }`, used as `createSandbox(provider, { from: snapshotId })` |
| `box.terminal({ cols, rows })` | PTY handle with `write`, `resize`, `onData`, `close` |

- `network` policy and `size` are creation-time options that fail closed when the provider can't enforce them.
- `box.capabilities` is a `ReadonlySet<"pause" | "snapshot" | "terminal" | "network-policy" | "size">`.

## 7. Other handle members

- `box.id`, `box.key`, `box.provider` (a name string), `box.created`, `box.labels`.
- `box.usage()` returns `{ createdAt, runningMs, commands, bytesOut }`, plus native cost fields if the provider exposes them.
- `box.native` is the escape hatch for anything the SDK does not wrap. Its shape depends on the provider:
  - **Direct-HTTP providers** give a `NativeApi<Plane>` (exported from the root as a type):
    - `request<T>(method, path, options?)` calls any endpoint with the adapter's base URL, credentials, retries, error mapping and redaction, and returns the JSON body (`undefined` when empty).
    - `fetch(method, path, options?)` returns the raw `Response` for bytes and streams.
    - `sdk(load)` takes the official SDK module the caller imported (`box.native.sdk(() => import("@daytonaio/sdk"))`) and returns that SDK's object for this sandbox. The caller installs the SDK; it is not a dependency. Each provider types `load` with a structural constraint on the module (`M extends { Daytona: new (config) => { get(id): Promise<unknown> } }`) and derives the result from the caller's own module type, so no declaration of ours imports an optional package.
    - `options`: `plane` (a provider API surface such as Daytona's `"api"` or `"toolbox"`; default is the control plane), `params`, `query`, `body` (JSON unless it is a `BodyInit`), `headers`, `signal`, `timeoutMs`.
    - Placeholders: only the provider's sandbox placeholder (documented per provider, such as `{sandboxId}`) fills itself on `box.native`. Every other `{name}` must be in `params`, and a missing or unused one is `invalid_argument` before any request. Explicit `params` win.
    - Non-2xx responses throw `SandboxError`; native errors keep the provider's error message, scrubbed of credentials and URLs.
    - The factory's return type also carries `api: NativeApi<Plane>` with no sandbox bound, for account-level calls (`daytona().api.request("GET", "/snapshots")`). `api` is not on the shared `Provider` interface.
  - **SDK-backed providers** (Vercel, Upstash, Railway, Tenki, boxd, and agentOS) give the SDK's own client or sandbox object, fully typed through the optional peer.
  Switching a provider from the second kind to the first is a breaking change for `box.native` users; the changelog and the provider page show the migration (`(await box.native.sdk(() => import("pkg"))).method()`).

## 8. Providers

| Factory | Subpath | keyMode | Notes |
|---|---|---|---|
| `local()` | `/local` | exact | Docker; real Linux; ports map to localhost URLs. Default image `node:22-bookworm` with git. |
| `memory()` | `/memory` | exact | In-process fake for tests. Supports files, a small shell subset via a command handler table, processes, and previews (fake URLs). It never touches the network. |
| `e2b(opts)` | `/e2b` | best-effort | Direct HTTP to E2B's API and each sandbox's envd; no peer. Uses native commands and pause/snapshot. |
| `vercel(opts)` | `/vercel` | exact | `@vercel/sandbox`. Named sandboxes, ports declared at create. |
| `daytona(opts)` | `/daytona` | best-effort | Direct HTTP to Daytona's API and toolbox; no peer. Labels, preview token. |

**Adapter contract.** Internal, exported from `/provider` for third parties. Each adapter is about 200–400 lines:
- `create(input)`
- `find(key)`
- `connect(id)`
- `list(labels)`
- `destroy(id)`
- `exec(id, { command, cwd, env, stdin, timeoutMs, signal, onChunk })`, returning `{ exitCode, timedOut }`
- `files` primitives: `read`, `write`, `list`, `stat`, `remove`, `mkdir`
- `previewUrl(id, port)`
- optional `pause`, `resume`, `snapshot`, `terminal`, and native process hooks
- `capabilities`
- `keyMode`

Everything else, including runs, processes, the `$` tag, edit, upload, search, changes, git, and readiness, lives once in core on top of these primitives.

**Direct-HTTP adapters.** They share one transport from `/provider`: `createHttpClient` and `createNativeApi`, with stream readers (NDJSON, server-sent events, Connect envelopes) internal to the package. The transport guarantees:
- Credentials attach only to the configured plane's origin. Absolute URLs, poll URLs, signed URLs and redirects to other origins get none.
- Retries (at most 2, jittered backoff, `Retry-After` up to 20 s and within the deadline) cover 429, 502, 503, 504 and network errors, and only GET, HEAD, PUT and DELETE, or a POST that carries a server-supported idempotency key. A streamed request body is never retried.
- A POST or PATCH that may have reached the server and then failed (a dropped connection after sending, a timeout, a 504) is `outcome_unknown`, never `unavailable`.
- One deadline covers credentials, every attempt, backoff, polling and the response body. Streams use a startup timeout until headers and an idle timeout between chunks instead. Cleanup after an abort uses a fresh, short deadline.
- Response bodies are cancelled before a retry and when a stream reader stops early. Streamed uploads use `duplex: "half"`.
- Error bodies are read up to 64 KB and stream frames up to 16 MiB.
- Redaction happens in the transport: credential header values, the provider's keys, signed URL query strings and credential-shaped text never reach a `SandboxError`. Adapter calls keep the HTTP status and the provider's error code, never response text.
- Providers refine the shared status mapping with a hook (a missing file versus a missing sandbox, a stale route).

## 9. Errors

```ts
class SandboxError extends Error {
  code: "auth" | "not_found" | "quota" | "unavailable" | "unsupported" | "timeout" | "aborted"
      | "outcome_unknown" | "process_exited" | "port_not_ready" | "edit_not_found"
      | "edit_not_unique" | "file_not_found" | "invalid_argument" | "provider";
  retryable: boolean; hint: string; provider: string; sandboxId?: string; cause?: unknown;
}
```

The message format is "what happened. why. what to do next." Secrets are redacted from messages, causes, and logs. Native errors map to these codes in each adapter's `errors.ts`.

## 10. Agent tools

Each adapter is a subpath. `/ai` gives AI SDK tools, `/mastra` gives Mastra tools, and `/openai` gives OpenAI Agents SDK tools. Each one exports `sandboxTools(box, options?)`, which returns that framework's native tool map or array with no glue code needed.

**Default tools.** Flat parameters, one verb each, and a description that says when *not* to use the tool:

| Tool | Parameters |
|---|---|
| `run` | `command`, `cwd?`, `timeoutMs?` |
| `read_file` | `path`, `offset?`, `limit?`. Returns numbered lines and a sha. |
| `write_file` | `path`, `content` |
| `edit_file` | `path`, `find`, `replace` |
| `start_process` | `name`, `command`, `cwd?`, `port?`. Waits for ready and returns the URL. |
| `process_logs` | `name`, `cursor?` |
| `stop_process` | `name` |

**Optional tools:** `search`, `list_files`, `changes`, `preview`.

**Model-facing output:**
- It opens with a verdict line: `OK exit=0 1.2s cwd=/workspace` or `FAILED exit=1 ...`.
- After that come `output:` and the interleaved, ANSI-stripped output, capped at 16 KB as head plus tail with a "[N bytes cut, use process_logs]" marker.
- Errors use the section 9 format, and secrets never appear.

**Options:**
- `root` keeps paths inside it.
- `allow` and `deny` select tools.
- `beforeRun(command)` can deny or rewrite a command.
- Per-tool limits.
- `onEvent` streams full output to the UI while the model gets the compact result. For AI SDK this uses preliminary results and `toModelOutput`.

## 11. Tests, conformance, benchmarks

- **Conformance.** `/testing` exports `runConformance(providerFactory, { live })`, one suite every provider must pass. It covers create/find-by-key, run (exit codes, stdin, timeout kill, abort kill, truncation, interleaving, non-interactive env), `$` escaping, processes (start/ready/logs/cursor/reattach after a new client/stop/exit-before-ready), files (all ops, upload/download, edit errors, changes), git (clone and commit against a local bare repo), preview, close vs destroy, reap, and capability gating.
- **Unit tests** run against `memory()` and provider mocks. Docker conformance runs locally and in CI. Cloud live tests are gated on env keys (`E2B_API_KEY`, `VERCEL_TOKEN` + team/project, `DAYTONA_API_KEY`).
- **Benchmarks.** `bench/` holds a runnable harness, `bun bench --providers e2b,vercel,... --runs 50`. It measures:
  - create to first command (cold);
  - command round trip;
  - file write and read (1 KB, 10 MB);
  - start a dev server until ready;
  - preview first byte;
  - destroy;
  - SDK overhead against the raw provider SDK, as CPU time.

  It reports p50, p95, and p99 with the machine and region, writes JSON plus a Markdown table, and never runs cloud providers without keys.
- Test commands must use timeouts and at most 4 workers.

## 12. Repo layout (branch from `v2`)

```
packages/sdk          the library (old src deleted, written fresh)
apps/web              landing page = current v2 apps/fumadocs home page, moved; docs routes removed
apps/docs             Blume docs (base /docs), ~15 pages, written fresh
bench/                benchmark harness
examples/             ai-app-builder (Next + AI SDK), coding-agent (CLI)
```

## 13. Docs (Blume, about 15 pages)

- Quickstart
- Concepts: sandboxes and keys, running commands, processes and previews, files and git, lifecycle and cleanup
- Guides: give your agent a sandbox (AI SDK / Mastra / OpenAI), build an AI app builder, testing with `memory()`, machine size and network
- Providers: overview table plus one page each
- Reference: generated from types
- Upgrade from 0.2

Writing follows the `doc-writing` skill. Every snippet gets type-checked in CI. One theme, matching the landing page tokens: Geist, JetBrains Mono, accent `#EFA43B`, bg `#0A0A0C`.
