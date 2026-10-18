# Provider benchmarks

Run the harness from the repository root with Bun. Build the SDK first so its workspace exports resolve:

```sh
bun install
bun run --cwd packages/sdk build
bun bench --providers memory,local,e2b,vercel,daytona,boat --runs 50 --out results/
```

The command writes `bench/results/results.json`, `results.md`, and `index.html`. Open the HTML file directly for a self-contained chart, or use the Markdown table. Results include failures and skipped scenarios; an unavailable provider gets a skip note. Exit status is 1 when every provider is skipped, a measured scenario fails, a warmup fails, or cleanup fails. Partial results are still written after scenario failures.

## Options and safety

| Option            | Default   | Meaning                                                             |
| ----------------- | --------- | ------------------------------------------------------------------- |
| `--providers`     | `memory`  | Comma-separated provider names, deduplicated                        |
| `--runs`          | `50`      | Measured sandbox iterations per provider                            |
| `--warmup`        | `2`       | Extra iterations excluded from distributions                        |
| `--concurrency`   | `1`       | Maximum active iterations, from 1 to 32; providers run sequentially |
| `--timeout-ms`    | `30000`   | Deadline for each scenario, cleanup attempt, and CPU batch          |
| `--max-sandboxes` | `100`     | Total allowed cloud creations, including warmups                    |
| `--yes`           | false     | Permit cloud creations above that budget                            |
| `--out`           | `results` | Output directory, relative to `bench/` when using the root alias    |

The harness imports `@opencoredev/sandbox-sdk/<name>` dynamically and calls its named factory with no arguments. Build/install providers and their native dependencies before running. Missing entry points skip. Factory configuration errors fail the run.

Cloud providers never load without credentials: E2B requires `E2B_API_KEY`; Vercel accepts `VERCEL_OIDC_TOKEN` alone, or `VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` (explicit token authentication takes precedence); Daytona requires `DAYTONA_API_KEY`; Boat requires `BOAT_API_KEY`. Local and memory need no keys. Unknown providers skip until their credential policy is added to `src/providers.ts`. No cloud providers are exercised by the tests.

One sandbox is created per warmup or measured iteration and reused for the latency scenarios. Every acquired sandbox is destroyed in `finally`, including after failures; failed cleanup is retried once and unresolved IDs are reported. Creation uses an abort signal and tracks raw adapter arrivals so late sandboxes are deleted and unresolved IDs are reported. Timed-out work is drained before another iteration starts or CPU measurements begin. The cleanup grace period is the greater of 1,000 ms and `--timeout-ms`; if work cannot settle, remaining iterations and providers stop and the report flags the outstanding work. Late creation and CPU-fixture setup retain cleanup callbacks. A creation lifetime is requested only from memory, E2B, and Daytona. Local and Vercel rely on tracked cleanup instead; no provider receives an idle timeout. Reports disclose this policy. A provider or network outage can prevent deletion, so inspect `cleanupFailures` after live runs. On scenario failure the iteration skips subsequent work and proceeds to cleanup.

## Measurements

- `cold`: create through the first successful `true` command. Includes SDK initialization; excludes adapter import and factory creation. Provider image caches are outside the harness's control.
- `command`: one `true` command on that sandbox.
- `files-1kb` and `files-10mb`: combined binary write and read of 1,024 and 10,485,760 bytes, including byte-for-byte validation.
- `dev-server`: write and start a tiny Node HTTP server on port 3000 through `box.start`, waiting for its listening callback to log `BENCH_READY`. Images need Node and the SDK's process prerequisites.
- `preview-first-byte`: resolve a preview, fetch with its access headers, and read the first response chunk. Memory skips both server and HTTP scenarios because it has no sockets and returns `.memory.invalid` URLs.
- `destroy`: sandbox deletion, measured even when an earlier scenario fails.
- `raw-cpu`, `sdk-cpu`, `overhead-cpu`: process CPU milliseconds per call for batches of 100 mocked-native calls, and their paired SDK-minus-raw difference. Setup is excluded; all CPU batches run serially after latency workers. Alternating batch order reduces ordering bias. GC, JIT and other threads can still add noise; negative differences are retained.

`memory` is an offline fake, so its results validate the harness and SDK paths rather than predict real provider performance. The committed 20-run sample was collected on a shared server.

## JSON schema v1

`results.json` follows the exported `Report` type in `src/model.ts`. `schemaVersion: 1` identifies this format. Top-level fields include ISO `timestamp`, `sdkVersion`, `machine` (CPU, logical CPU count, RAM bytes, OS, architecture and runtime), validated CLI `config`, `plannedCloudSandboxes`, `methodology`, and `providers`.

Each provider is either `{ kind: "skipped", name, note }` or `{ kind: "measured", name, region, metrics, notes?, warmupFailures, cleanupFailures }`. Region is null when unknown; set `BENCH_REGION_<UPPERCASE_PROVIDER>` to record the actual configured deployment region. E2B/Vercel/Daytona also read `E2B_REGION`, `VERCEL_REGION`, or `DAYTONA_TARGET` as metadata. These variables do not change factory configuration.

Each metric contains `scenario`, `unit` (`ms` or `cpu-ms/call`), raw successful `samples`, `stats`, `failures`, and `skipped` notes. Statistics contain `count`, `p50`, `p95`, `p99`, `mean`, `min`, `max`. Percentiles use nearest rank; failures, skips and warmups are excluded. Empty distributions have count 0 and null statistics. Skip and failure array lengths are their counts.

## Add a CPU hook

Register an `OverheadHook` in `src/overhead.ts`. It returns `sdkCall`, `rawCall`, and `dispose` functions. Both calls must reach the same deterministic mocked native operation with matching response semantics. The hook must require no credentials, create no cloud resources, and release its fixture in `dispose`. Leave an unimplemented hook absent so it produces a clear skip rather than a misleading number. The memory implementation replaces adapter exec after initialization while retaining real SDK command bookkeeping.

```sh
bun run --cwd bench test
bun run --cwd bench typecheck
bun run --cwd bench lint
bun bench --providers memory --runs 20 --out results/sample-memory/
```

The local CPU hook runs the local exec adapter against mocked Docker exec with an in-memory filesystem for core bookkeeping. It creates no container and opens no Docker socket. Latency scenarios still use real Docker.
