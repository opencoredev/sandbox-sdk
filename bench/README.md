# Independent sandbox provider benchmark

The v2 harness measures the SDK, guest hardware, guest performance, deterministic agent work, and lifecycle cost. It keeps failures and raw observations. It makes no combined provider ranking. `local` is a Docker reference baseline, not a cloud product. Provider defaults are deliberately visible: this is a default-experience comparison, not a claim that differently sized machines are equivalent.

Build the SDK and run a small pilot before collecting publication data:

```sh
bun install
bun run --cwd packages/sdk build
# Load credentials privately into environment variables. Never enable shell tracing.
for f in ~/.config/sandbox-bench/*_KEY; do export "$(basename $f)=$(cat $f)"; done
bun bench --runs 2 --bursts 3 --concurrency 4 --provider-concurrency 1 \
  --run pilot-001 --out results/pilot-001
```

Output paths are relative to `bench/` through the root alias. Each output directory contains `results.json`, `results.md`, a self-contained `index.html`, `samples.ndjson`, and an `ownership.json` cleanup journal. Reports checkpoint after each sandbox; raw observations append after each scenario as a crash journal. At successful finalization, `samples.ndjson` is rewritten to exactly match `results.json.samples`, including fingerprint backfills, final cost corrections, and burst aggregate rows. Treat interim NDJSON as provisional. Do not reuse a run ID or output directory for a new collection. The harness never prints credentials. Run reports can contain public egress IPs, native sandbox IDs, and hardware identifiers; review before publication.

Use the same SDK commit and harness commit for every provider in a published comparison. Merge SBX-44 before the real run. The pilot exercises the current SDK and is not publication evidence for the SDK after that merge.

## Collection and budgets

| Flag | Default | Meaning |
| --- | --- | --- |
| `--providers` | `local,e2b,daytona,upstash,boat,boxd,freestyle,tenki,railway,vercel` | Provider factories; missing credentials produce a skip note |
| `--runs` | `2` | Sandbox iterations per provider for lifecycle, command, files and guest probes |
| `--workload-runs` | same as runs | Number of iterations that include agent workloads |
| `--scenarios` | `all` | Comma-separated scenario names below; cold, fingerprint and cleanup always run |
| `--concurrency` | `4` | Global active normal sandbox iterations, maximum 32 |
| `--provider-concurrency` | `1` | Active normal iterations per provider, maximum 32 |
| `--bursts` | `3` | Isolated cohorts, e.g. `10,25`; empty string disables |
| `--account-limits` | conservative defaults | Overrides such as `e2b=20,tenki=5,boxd=50`; boxd must never exceed 50 |
| `--timeout-ms` | `180000` | Scenario deadline and bounded cleanup/drain grace |
| `--seed` | `45` | Recorded PRNG seed for scenario-group order and bootstrap CIs |
| `--max-sandboxes` | `100` | Attempted creations per provider, including restored sandboxes and bursts |
| `--max-dollars` | `5` | Estimated budget per provider in USD; not an invoice-level cap |
| `--provider-max-sandboxes` | no override | `boat=100,boxd=100` |
| `--provider-max-dollars` | no override | `boat=2,boxd=5` |
| `--run` | timestamped SBX-45 ID | Ownership label for every created sandbox |
| `--out` | `results/v2` | Report and ownership journal directory |

Normal jobs enter a round-robin provider queue per iteration. Independent providers run concurrently within the global limit. A provider holds its slot through cleanup. Scenario groups are shuffled deterministically for each iteration, using the same order across providers. Dependencies remain ordered: fixture upload/install → dev server → preview → edit. Cold comes first, fingerprint follows, and destruction comes last. No warmup or outlier is discarded.

Bursts intentionally override the normal per-provider iteration limit: K creates start together, record individual cold/readiness times and failures, retain all VMs until the cohort finishes, then destroy them. Cohorts run in isolation from normal work and from other burst providers. K is capped by the global concurrency limit and account limits (defaults: boxd 50, E2B 20, Upstash/Freestyle 10, Tenki 5, others 10). These are conservative admission settings, not verified account entitlements. Check the actual account before raising them. A cohort above its cap is skipped, not silently reduced.

The dollar guard reserves a conservative timeout-based estimate at admission. Estimates settle against measured lifetimes and observed allocation; overlapping restored VMs add their own lifetimes. Failed creates count toward the sandbox budget. Unknown costs reserve the admission estimate and stop further creation. Credits, subscriptions and provider-side unknown-outcome charges cannot be enforced by this local estimate. Boat has the same budget controls as every other provider.

For publication, use 100 normal iterations and 30 workload iterations, serial within each provider. This gives useful p50/mean estimates; p99 from 100 samples is still unstable. Keep raw samples and CIs. Increase the global limit only after examining host-load counters.

```sh
# Example only: do not run before SBX-44 is merged and pilot blockers are resolved.
bun bench --runs 100 --workload-runs 30 --bursts "" \
  --concurrency 4 --provider-concurrency 1 --seed 45 \
  --max-sandboxes 250 --max-dollars 10 --provider-max-dollars boat=2 \
  --run publication-001 --out results/publication-001

# Isolated burst-only collection: K creates can run together within this global limit.
bun bench --scenarios burst --runs 1 --bursts 10,25 --concurrency 25 \
  --max-sandboxes 40 --max-dollars 5 --provider-max-dollars boat=1 \
  --run publication-bursts-001 --out results/publication-bursts-001
```

K=25 is skipped on accounts whose configured cap is lower. A burst above `--concurrency` is also skipped; its K is never silently reduced. Do not raise those caps merely to complete the table. Reconnect, pause/resume, snapshot and restore each have 100 observations when supported; each agent workload has 30. One sandbox serves multiple scenarios, so these are not independent fresh-machine samples per workload. To isolate a workload, collect a separate run with `--scenarios npm-install` or another scenario name.

## Measurements

| Scenario | Measurement |
| --- | --- |
| `cold` | Client create through first successful `true`; raw create-return and first-command phases recorded |
| `command` | One successful `true` round trip |
| `files-1kb`, `files-10mb` | Write + read with byte equality validation; 1,024 / 10,485,760 bytes |
| `fingerprint` | One guest exec for the hardware script, including one-second CPU steal sample |
| `perf` | Guest performance probe, with separate metric observations described below |
| `reconnect` | Close local handle, connect by native ID, first successful command; phase detail retained |
| `pause-resume` | Pause, resume, first command, with pause and resume-ready phases; unsupported providers skip |
| `snapshot`, `create-from-snapshot` | Snapshot API creation and restored first-command readiness measured separately; teardown separately recorded |
| `git-clone` | Depth-one clone and pinned fetch of `octocat/Hello-World`, commit `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`; checkout verified |
| `npm-install` | Committed React 19.1.0 / Vite 6.3.5 fixture and npm lockfile, `npm ci --ignore-scripts --no-audit --no-fund` |
| `dev-server` | Start fixture Vite server on port 3000 to listening log |
| `preview-first-byte` | Provider preview URL and access headers through first non-empty HTTP response chunk |
| `edit-loop` | Edit fixture HTML marker; poll public preview until the changed bytes are served, bypassing caches |
| `tool-replay` | 100 deterministic SDK operations: write, read/validate, edit, list, grep via run, Node test; per-operation timings retained |
| `pip-install` | Pinned requests/numpy and transitive set into a workspace target; imports and versions verified; pinned pip wheel bootstrap with SHA-256 |
| `destroy` | Deletion request, retries retained; final listing separately verifies eventual deletion |

The fingerprint records CPU model and flags, affinity-aware `nproc`, cgroup CPU quota and memory limit, host MemTotal, df/lsblk capacity/type, virtualization probes and readable DMI, kernel/distro, user/uid/sudo, installed tools, Python version, steal time, and optional no-key ipinfo egress IP/org/region. A failed IP lookup is null. A provider may expose host CPU/RAM/disk information beyond its allocation; prefer cgroup limits and inspect raw fields. Default Docker reference size is `medium` (2 vCPU / 4 GiB); its shared backing filesystem size is not a dedicated disk allocation.

Guest performance uses the same rootless CPython script everywhere. It never installs system packages. Images need `python3`; workload images also need Node/npm/git. Missing tools remain a measured failure rather than a fabricated comparable score. The pip workload needs no `venv`, `ensurepip`, sudo or system-package changes.

- CPU: fixed 1,000,000-step 32-bit LCG, iterations/second, single process and process pool sized to `ceil(min(nproc, quota))`, capped at 64. Worker startup counts in all-core performance. Python version differences affect the score and must be disclosed.
- Memory: 64 copies of a 16 MiB bytearray, decimal MB/s. This measures runtime copy throughput, not DRAM-only bandwidth.
- Disk: 64 MiB sequential write + fsync, sequential read, and 256 random 4 KiB operations at queue depth one. Random writes fsync each operation. Reads are buffered and may be cached; no root or O_DIRECT is used. Do not describe these as raw hardware IOPS.
- Network: exactly 25,000,000 bytes from `https://speed.cloudflare.com/__down?bytes=25000000`, including TLS, using a fixed User-Agent; decimal MB/s. TCP latency is the mean of five connects to `1.1.1.1:443`. HTTP denial and byte-count mismatches are failures.

The HTTP edit loop verifies served file changes, not browser rendering or React HMR execution. Network location, shared tenancy, provider image caches, package caches, and filesystem caching remain confounders. The raw host counters include loadavg, per-core ticks, process CPU and `/proc/net/dev` before/after each sample so client bottlenecks can be investigated.

## Costs and statistics

`src/pricing.ts` contains official sources retrieved on 2026-10-19, resource rates, currency, increment assumptions, included disk, fixed plan sizes, and caveats. One-second rounding is an explicit estimate when a source does not publish an increment. Unstated creation fees are not invented. Subscriptions, credits, transfer and retained snapshot storage are excluded. Boat uses its default fixed VM rate. Upstash bills active CPU, so allocation × wall time is an upper bound; boxd RAM/disk allocations likewise overestimate used-memory/written-disk billing. boxd is EUR: reports keep EUR and use a conservative 2 USD/EUR only for budget admission, not a claimed exchange-rate quote.

Sample cost = billed seconds × observed vCPU/RAM/disk allocation rates, or the published fixed VM size/rate. Unknown resources yield null. Sandbox-lifetime totals include setup and idle time; do not sum them with scenario allocations or the performance submetrics. Performance-per-dollar divides each successful throughput score by the observed allocation's estimated per-second rate, then averages those ratios. It is an efficiency estimate (e.g. CPU iterations per currency unit), kept in the provider's stated currency. Local has zero marginal provider charge; its host costs are excluded and it is omitted from ratios that divide by zero.

Distributions retain all successful raw values and report nearest-rank p50/p95/p99, mean/min/max, population standard deviation, and deterministic 2,000-resample percentile bootstrap 95% intervals for p50 and mean. Failure counts remain in every summary. Success rate uses a Wilson 95% interval over successes + failures; skips are counted separately. Empty distributions are null, never zero or NaN. A small pilot validates the harness; it cannot rank providers reliably.

## Cleanup and recovery

Every created VM carries `sandbox-bench-run=<run ID>` in addition to the SDK label. Creation arrivals are tracked before SDK initialization; late arrivals receive deletion callbacks. Each iteration drains timed-out work before releasing its slot. Destruction runs in `finally` and retries. Snapshot deletion uses narrow provider-native hooks because the SDK has no common snapshot-delete method. Daytona snapshot creation uses its native nameable method: the harness journals a run-owned name before calling it, because the SDK wrapper otherwise loses its generated name on timeout. This path difference is disclosed in report methodology. Only IDs created by this run are journaled. Final cleanup checks both the run label and ownership journal, including snapshots.

```sh
bun bench reap --run pilot-001 --out results/pilot-001
```

Reaping requires an explicit run ID. It checks exact label equality even if an adapter returns extra list results. The matching output journal also permits deletion of this run's persistent snapshots. A journal from another run is refused. Without the original journal, only labelled sandboxes can be reaped; do not delete account-wide snapshots. If native creation fails before ownership metadata can be attached, the SDK may return `outcome_unknown`; inspect that provider's account rather than assume label-based discovery is complete.

SIGINT/SIGTERM stop admission and cancel signal-aware operations, then run normal cleanup. Do not use SIGKILL unless necessary. A provider outage can prevent deletion: a nonempty `cleanup.remaining`, cleanup error, or ownership journal is a blocker. Re-run scoped cleanup after recovery. Never use an account-wide delete because other agents use the same keys.

## Schema v2 and compatibility

V2 is an intentional format change. `src/v2-model.ts` owns the model. Existing v1 results/readers and `src/model.ts` remain unchanged; run `bun bench --v1 ...` for the original harness, including mocked-native SDK CPU overhead measurements. See [the v1 reference](README-v1.md). V1 readers must gate on `schemaVersion` and reject v2 rather than interpret it as v1.

V2 top-level fields are `schemaVersion: 2`, `runId`, ISO timestamps, validated `config`, harness `host`, `providers` (ready/skipped plus notes), raw `samples`, `summaries`, `budgets`, `cleanup`, `methodology`, and the serialized pricing table. Each sample includes provider/iteration/scenario/unit, start/end timestamps, client monotonic `durationMs`, native ID, `outcome` (`sample` with numeric value, `failure` or `skipped` with note), phases, host before/after, fingerprint, nullable estimated cost and scenario-specific details. Performance metrics use their native units; their `durationMs` records the enclosing performance probe time. Tool replay details contain per-op milliseconds. Summaries key on provider + scenario + unit and contain stats/CIs, Wilson success intervals, failure/skip counts, estimated cost, per-1000 estimate and performance-per-currency-unit.

```sh
bun run --cwd bench test
bun run --cwd bench typecheck
bun run --cwd bench lint
bun run --cwd packages/sdk build
```

Tests are offline. They exercise real memory-provider cleanup, scheduling limits, seeded order, percentile/bootstrap/Wilson arithmetic, cost conversion and rounding, and fingerprint boundary validation.
