# Independent sandbox provider benchmark

The v2 harness measures the SDK, guest hardware, guest performance, deterministic agent work, and lifecycle cost. It keeps failures and raw observations. It makes no combined provider ranking. `local` is a Docker reference baseline, not a cloud product. The `default` track compares provider defaults. The `same-spec` track records explicit size and template choices, with fingerprints showing actual resources and any remaining differences.

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

## Merge collected results offline

Run `bun bench merge` from the repository root to build `bench/results/publication-final/` from the seven collected publication runs. It writes `results.json`, `samples.ndjson`, `results.md`, and a self-contained `index.html`. The merge does not call providers or collect new data. Generated publication datasets remain local under the existing results ignore rule.

For other v2 runs, pass result directories explicitly. Paths are relative to `bench/`:

```sh
bun bench merge results/run-a results/run-b --out results/merged --seed 45
```

`--exclude run-id` can be repeated. The aborted `publication-001` is always excluded. Duplicate run IDs, invalid schemas, different JSON/NDJSON samples, and an output path equal to an input are rejected. Existing output files with these four names are replaced.

The merged schema is `publication-merge-v1`, documented in `results.json.schema` and the report. Every included observation remains, including failures, blocked dependencies and skips. `sourceRunId` and zero-based `sourceSampleIndex` identify its original row. `sourceIteration` preserves the original iteration; `iteration` is reassigned per provider across source runs and burst namespaces. Scenario rows from one sandbox iteration share the new identity. Main, snapshot and burst summaries stay separate. Tracks, requested sizes and templates also have separate summary groups. Historical rows without a track belong to `default`. Do not pool older SDK-inclusive cold measurements with the SBX-53 bare-readiness method.

Distributions and confidence intervals are recomputed from successful samples with the existing statistics code. Raw success rates remain beside rates excluding specifically classified account-limit and client/third-party failures; skips and blocked rows have separate counts. Unknown operation causes remain operation failures. `network-mbps` stays in the data but is labelled not comparable, without a chart or rank. Source commits, flags, regions, seeds, host data, pricing, budget diagnostics and cleanup records remain attached to each source. The default report explicitly discloses the budget-fix top-ups and the discarded run.

Run-cost estimates sum only known `sandbox-lifetime` estimates, which already include restored lifetime. They do not add the overlapping scenario allocations. Missing lifetime costs stay unknown, and the report shows known subtotals plus unpriced counts in native currency. Boxd remains EUR.

## Select equal publication attempts

Pass `--policy path/to/policy.json` to `bun bench merge` to apply the publication targets: 100 main attempts, 30 workload and snapshot attempts, and three burst cohorts per size. The policy contains `replacements` (`provider`, `suite`, `scenario`, `sourceRunIds`) and `notRun` (`provider`, `suite`, `scenario`, `reason`) arrays. A scenario ending in `/*` matches its burst member and aggregate rows. Use replacement rules to select only the fresh pause/resume sources and fresh Boat bursts. Document unsupported capabilities and account limits in `notRun`; these are not provider failures.

Policy rules accept an optional `track` (`default` when omitted). Attempt targets and counts are independent per track, and an old default-track replacement or not-run rule never applies to same-spec.

Selection drops classified account-limit and client/third-party failures, then keeps the first N attempts per track, provider, suite and test in `startedAt` order. Ties use source run ID and original sample index. Provider-operation failures count as attempts. Blocked and skipped rows do not. Selecting burst cohorts also selects their associated member rows. Original source files remain unchanged, and the report records selection removals and every source date/configuration.

Run `bun bench attempts results/publication-final-v2` to print every required provider/test count and fail on missing or excess attempts without a documented not-run reason. It also checks the three phase fields on successful pause/resume samples. Pause/resume failures retain whichever phases completed; the total sample value remains elapsed time. Use `--omit-network-download true` for performance top-ups that must omit the optional CDN download while retaining CPU, memory, disk and TCP probes.

## Collection and budgets

| Flag | Default | Meaning |
| --- | --- | --- |
| `--track` | `default` | `default` or `same-spec`; retained in provider metadata, samples and summaries |
| `--size` | no override | Repeat `provider=small`, `provider=medium`, `provider=large`, or `provider=cpu:memoryMb[:diskGb]` |
| `--template` | no override | Repeat `provider=name`; maps to the factory template, snapshot or image option |
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
bun bench --scenarios burst --runs 1 --bursts 10,25 --burst-cohorts 3 --concurrency 25 \
  --max-sandboxes 110 --max-dollars 5 --provider-max-dollars boat=1 \
  --run publication-bursts-001 --out results/publication-bursts-001
```

K=25 is skipped on accounts whose configured cap is lower. A burst above `--concurrency` is also skipped; its K is never silently reduced. Do not raise those caps merely to complete the table. Reconnect and pause/resume each target 100 attempts when supported; snapshot, restore and each agent workload target 30. One sandbox serves multiple scenarios, so these are not independent fresh-machine samples per workload. To isolate a workload, collect a separate run with `--scenarios npm-install` or another scenario name.

## Measurements

| Scenario | Measurement |
| --- | --- |
| `cold` | Adapter create start through a successful bare adapter `true` in `/workspace`, before SDK handle initialization |
| `command` | One successful `true` round trip |
| `files-1kb`, `files-10mb` | Write + read with byte equality validation; 1,024 / 10,485,760 bytes |
| `fingerprint` | One guest exec for the hardware script, including one-second CPU steal sample |
| `perf` | Guest performance probe, with separate metric observations described below |
| `reconnect` | Connect by native ID through first successful command; close the previous handle after sandbox destruction in `reconnect-cleanup` |
| `pause-resume` | Pause, resume, first command, with pause and resume-ready phases; unsupported providers skip |
| `snapshot`, `create-from-snapshot` | Native snapshot API and restored first-command readiness measured separately; setup, total, and teardown separately recorded |
| `git-clone` | Depth-one clone and pinned fetch of `octocat/Hello-World`, commit `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`; checkout verified |
| `npm-install` | After the separately recorded `npm-install-prepare` fixture upload: committed React 19.1.0 / Vite 6.3.5 fixture and npm lockfile, `npm ci --ignore-scripts --no-audit --no-fund` |
| `dev-server` | Start fixture Vite server on port 3000 to listening log |
| `preview-first-byte` | Provider preview URL and access headers through first non-empty HTTP response chunk |
| `edit-loop` | Edit fixture HTML marker; poll public preview until the changed bytes are served, bypassing caches |
| `tool-replay` | After any separately recorded `tool-replay-prepare` fixture upload: 100 deterministic SDK operations: write, read/validate, edit, list, grep via run, Node test; per-operation timings retained |
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

Distributions retain all successful raw values and report nearest-rank p50/p95/p99, mean/min/max, population standard deviation, and deterministic 2,000-resample percentile bootstrap 95% intervals for p50 and mean. Failure counts remain in every summary. Success rate uses a Wilson 95% interval over successes + independent failures; skips and blocked dependencies are counted separately. Empty distributions are null, never zero or NaN. A small pilot validates the harness; it cannot rank providers reliably.

## Cleanup and recovery

Every created VM carries `sandbox-bench-run=<run ID>` in addition to the SDK label. Creation arrivals are tracked before SDK initialization; late arrivals receive ownership checks before deletion callbacks. Each iteration drains timed-out work before releasing its slot. Destruction runs in `finally` and retries. Snapshot deletion uses narrow provider-native hooks because the SDK has no common snapshot-delete method. Daytona snapshot creation uses its native nameable method: the harness journals a run-owned name before calling it with a bounded 600-second completion budget. The SDK wrapper also retains its generated name in errors, but cannot journal that name before submission. This path difference is disclosed in report methodology. Only IDs created by this run are journaled. Final cleanup checks both the run label and ownership journal, including snapshots. It polls the exact run label for up to 30 seconds (bounded by `--timeout-ms`) so asynchronous deletion can disappear from listing before reporting leftovers. Daytona snapshot listings receive the same bounded wait, scoped to each owned source. Source-linked snapshot discovery runs while the source is still live and its ownership labels can be verified. Unresolved source markers remain for manual review if the source disappears.

```sh
bun bench reap --run pilot-001 --out results/pilot-001
```

Reaping requires an explicit run ID. It checks exact label equality even if an adapter returns extra list results. Persistent snapshot recovery requires the matching output journal, a live verified parent, and source-linked snapshot metadata. A journal from another run is refused. Without the original journal, only labelled sandboxes can be reaped; do not delete account-wide snapshots. If native creation fails before ownership metadata can be attached, the SDK may return `outcome_unknown`; inspect that provider's account rather than assume label-based discovery is complete.

SIGINT/SIGTERM stop admission and cancel signal-aware operations, then run normal cleanup. Do not use SIGKILL unless necessary. A provider outage can prevent deletion: a nonempty `cleanup.remaining`, cleanup error, or ownership journal is a blocker. Re-run scoped cleanup after recovery. Never use an account-wide delete because other agents use the same keys.

## Schema v2 and compatibility

V2 is an intentional format change. `src/v2-model.ts` owns the model. Existing v1 results/readers and `src/model.ts` remain unchanged; run `bun bench --v1 ...` for the original harness, including mocked-native SDK CPU overhead measurements. See [the v1 reference](README-v1.md). V1 readers must gate on `schemaVersion` and reject v2 rather than interpret it as v1.

V2 top-level fields are `schemaVersion: 2`, `runId`, ISO timestamps, validated `config`, harness `host`, `providers` (ready/skipped plus notes), raw `samples`, `summaries`, `budgets`, `cleanup`, `methodology`, and the serialized pricing table. Each sample includes provider/iteration/scenario/unit, start/end timestamps, client monotonic `durationMs`, native ID, `outcome` (`sample` with numeric value, `failure` or `skipped` with note, or `blocked` with note and `blocked_by`), phases, host before/after, fingerprint, nullable estimated cost and scenario-specific details. Performance metrics use their native units; their `durationMs` records the enclosing performance probe time. Tool replay details contain per-op milliseconds. Samples, summaries and provider metadata include `track`, `requestedSize` and `template`. Summaries key on track + requested size + template + provider + scenario + unit and contain stats/CIs, Wilson success intervals, failure/skip counts, estimated cost, per-1000 estimate and performance-per-currency-unit.

```sh
bun run --cwd bench test
bun run --cwd bench typecheck
bun run --cwd bench lint
bun run --cwd packages/sdk build
```

Tests are offline. They exercise real memory-provider cleanup, scheduling limits, seeded order, percentile/bootstrap/Wilson arithmetic, cost conversion and rounding, and fingerprint boundary validation.

See [the validation pilot](PILOT.md) for observed failures, cost projections, and verification limits.

## Publication fairness updates

`--burst-cohorts N` repeats every configured burst size N times (default 3). Each aggregate carries its cohort index in `iteration` and `details.cohort`; cold samples have a unique iteration within that size. Three K=10 plus three K=25 cohorts require 105 sandbox attempts per provider, so the burst command reserves 110. Account and dollar caps still apply; a blocked admission is reported rather than silently reducing K. Three cohorts validate a distribution but are insufficient for a stable tail estimate; use more cohorts only within explicit account and spend budgets.

The default track uses provider default allocations and images, with the local Docker reference at medium size. The same-spec track uses the supplied per-provider sizes and templates. A track label alone does not establish equal hardware. Publish the hardware table beside timing results. Image, dependency, CDN and filesystem caches remain uncontrolled. Workloads on the same sandbox share installed files and process state.

A failed lifecycle transition marks later scenarios with outcome `kind: blocked` and `blocked_by: <scenario>`. App prerequisite failures propagate similarly. These rows appear separately from skips and independent failures; success-rate denominators include only successful and independently failed attempts. Latency distributions contain successful values only. Every expected guest performance metric receives a failure row when the probe fails, times out, returns invalid JSON, or omits that metric.

Cold and create-from-snapshot use the client monotonic clock immediately before `adapter.create` and stop after a bare `adapter.exec("true")` succeeds. Ownership is durably recorded before the bare command using a synced temporary file, atomic rename, and directory sync. `ownershipPersistMs` records that host interval and is excluded from cold and burst headline values. SDK handle initialization follows readiness. `adapterCreateMs` stops at the create return, `firstCommandMs` covers the bare command, and `coldMs` is the headline. `sdkReadyMs` covers create through the fully initialized SDK handle and is reported separately. `firstCommandOKMs` starts earlier, at iteration admission before host sampling and budget work. Burst all-ready uses the last member's bare-command endpoint, even when SDK setup finishes later. Failed bare commands retain failure rows and owned resources for cleanup.

Fixture preparation and uploads are separate `npm-install-prepare` and `tool-replay-prepare` rows, outside the headline workload windows. Preparation failures remain failures; the workload and its dependents become blocked rows.

File payloads are prepared once before scheduling. Reconnect preserves the previous handle if attachment fails; successful reconnections defer old-handle cleanup until after destruction because providers cache clients by sandbox ID. `preview-provisioning` measures public URL provisioning separately from `dev-server`. Each `preview-first-byte` row is a single HTTP attempt through its first nonempty chunk; up to three attempts retain failures separately. Reader cancellation and the 500 ms gap between attempts are outside that row’s timing. The edit loop depends on successful provisioning/start and, when collected, a successful first-byte attempt. `snapshot` measures only the native API; `snapshot-setup` exposes cleanup-client loading and durable journal preparation, and `snapshot-total` includes that setup and post-API journal work. Cost projections use the total, not a sum of overlapping snapshot rows.

Reports include configured provider regions, collection start/end, repository/harness/SDK git commits, a dirty-tree indicator, SDK/runtime versions and optional client public-egress geography from ipinfo. The SDK/harness commits identify the latest commits touching their respective directories; the repository commit identifies the complete checkout. A failed location lookup is null. Offline library consumers do not perform this lookup. The client-headroom section summarizes normalized load, host CPU busy fraction and network byte rates during each provider’s samples. Every raw sample has a `headroom` object and a high-load flag when load1/logical CPUs is at least 1 or measured host CPU busy fraction is at least 90%. Raw counters remain available. Overlapping windows and unrelated host traffic prevent attributing these counters solely to a provider; do not sum their traffic rates.

Percentiles use nearest rank. p50 and mean intervals use 2,000 seeded bootstrap resamples; independent success rates use Wilson 95% intervals. At n=100, p99 depends on roughly the two slowest observations and remains unstable. Publish raw data, counts, failures and blocked dependencies rather than presenting a precise tail ranking. Costs remain estimates with per-provider source retrieval dates. EUR and USD remain separate; subscriptions, credits and excluded charges are documented in the pricing table.

These additions extend schema v2: `metadata`, `providers[].configuredRegion`, `samples[].headroom`, blocked outcomes, and `summaries[].blocked`. Consumers must handle the new outcome variant. Older v2 pilot reports lack these fields and are historical artifacts; v1 compatibility is unchanged. The earlier pilot predates these fairness fixes and has not been rerun on cloud accounts.


## Collect and publish separate tracks

Use the same size/template mapping for every suite in a track. Templates map to `template` for E2B/Superserve, `snapshot` for Daytona, `snapshotId` for Freestyle, and `image` for Tenki/boxd/local. Boat and Upstash expose no template option and reject that flag. Omitted size means provider default; E2B and Freestyle allocations come from templates rather than a size argument. The SDK and harness accept omitted `diskGb` and pass no disk override. Each adapter uses its native default: boxd 100 GB, Daytona 10 GB, Tenki 5 GB. `requestedSize` retains the original request.

For a 4-vCPU / 8-GiB target, use a prebuilt E2B template, Daytona's `daytona-large` snapshot with `DAYTONA_TARGET=us`, Upstash `medium`, Boat default, boxd `4:16384` (its nearest allocation is 16 GiB), Freestyle default, Tenki `4:8192` (native 5-GB disk default), and no Superserve entry until a 4-vCPU template exists. Its account currently caps templates at 2 vCPU. E2B uses `sandbox-bench-same-spec` (`r1h7gud12rf1f6iu29r0`). This is a target comparison with disclosed exceptions, not exact hardware equivalence.

`bun bench merge` retains both tracks in JSON/NDJSON and writes separate `index.default.html`, `index.same-spec.html`, `results.default.md`, and `results.same-spec.md` when those tracks exist. `index.html` / `results.md` show default when present, otherwise same-spec. Every HTML/Markdown report uses only its selected track.

Export one site dataset per track, with an explicit output path so the files cannot overwrite each other:

```sh
bun bench site-data --report results/merged --track default --out results/site-default.json
bun bench site-data --report results/merged --track same-spec --out results/site-same-spec.json
```

The export includes `track` and requested allocations. Each export filters metrics, raw cold samples, hardware, costs and failures to that track. Multiple allocations for the same provider within one track are rejected by site-data; merge those allocations separately. Attempt-policy rules may specify `track`; omission selects default only. Conservative account caps still apply to both tracks: K=25 can remain skipped until account capacity has been verified, and start-rate quotas can require separate collection windows.


### Allocation contract for site-data consumers

Every `site-data --track ...` export contains `track` at the root and on every provider. Render `providers[].requestedAllocation` beside `providers[].measuredAllocations`:

- `requestedAllocation.size` is the original preset/custom request or null for provider defaults; `.template` is the requested factory template/snapshot/image or null; `.compute` records the provisioned CPU/RAM from an explicit size or a known template/default. `.provisioned` retains the checked-in template/default allocation, including disk when known; unknown templates remain unverified and unpriced.
- `measuredAllocations` contains every distinct source and restored fingerprint allocation as `{cpu, memoryGiB, diskGiB}`. An empty array means allocation was not measured.
- `equalSpec` is true only when no restore allocation mismatch was detected, at least one fingerprint exists, and **every** fingerprint has exactly 4 vCPU and usable memory between 7.6 and 8.4 GiB, inclusive. It does not follow from the track name or the requested allocation. Missing measurements, boxd 4/16, and Superserve at 2 vCPU all produce false. Show those exceptions in comparisons.
- `allocationVerification` contains `verified` (true/false for a known provisioned allocation with measurements, otherwise null) and `mismatches` (human-readable reasons). `pricingAllocation` is the compute allocation actually priced. Explicit sizes must agree with every fingerprint: CPU exactly; usable memory must not exceed provisioned RAM and may fall below it by at most the larger of 5% or 96 MiB for kernel overhead. Conflicts suppress `hourly` and `perVcpuHour`; absent fingerprints produce null prices. Known template/default resources come from `src/provisioned-allocations.ts` and must agree with fingerprints before pricing. Prices use provisioned RAM rather than kernel-usable RAM. Tenki has no documented default CPU/RAM, so its unspecified default still uses measured resources. Restored fingerprints participate in every safeguard, and an allocation-mismatched restore latency remains recorded as a failure instead of ranking.

The root `allocations[]` repeats this evidence per provider/track as `requested`, `measured`, `equalSpec`, and `verification`. Each provider's `hardware` view remains descriptive; do not use its first/mode observation to override these safeguards. A false `equalSpec` can still have a valid price for the actual allocation (for example, boxd 4/16).

Restores omit size overrides and inherit their snapshot's allocation. `restore-fingerprint.details.verification` records source and restored resources, `matches` (null if the source fingerprint is unavailable), and mismatched dimensions. CPU must match exactly; usable memory and disk allow 5%. A mismatch is a failed restore-fingerprint observation; its fingerprint and cleanup remain recorded.


### SBX-53 collection windows

The executable recommendations are in `src/collection-plan.sh` (also copied to `/tmp/swarm/core-commands.sh` for orchestration). Invoke the script by path from any working directory; it resolves the checkout root and writes absolute output paths under `bench/results`. Each run’s journal is `bench/results/RUN_ID/ownership.json`, including when invoked from the repository root. After all adapter merges, build and verify the SDK, then export `BENCH_COLLECTION_COMMIT` as that complete immutable commit. Every invocation refuses a different checkout or uncommitted collection code. Both tracks and all windows must use the same pinned commit.

```sh
# Preview exact commands without credentials, provider calls or waits:
BENCH_PLAN_DRY_RUN=1 bash bench/src/collection-plan.sh default-nonboat
BENCH_PLAN_DRY_RUN=1 bash bench/src/collection-plan.sh same-spec-nonboat
# Generate documented capability/quota exclusions for the offline merge:
bash bench/src/collection-plan.sh policy > /tmp/swarm/collection-policy.json
```

`default-nonboat` covers E2B, Daytona, Upstash, boxd, Freestyle, Tenki and Superserve. It collects 100 lifecycle/probe iterations, workloads on the first 30, a separate 30-iteration snapshot/restore suite, and three cohorts each for K=10/K=25, subject to verified account caps. Cold, fingerprint and destroy always run. The main list explicitly includes command, both file sizes, reconnect, pause/resume, performance, git-clone, npm-install, dev-server, preview-first-byte, edit-loop, tool-replay and pip-install. Across the three suites this covers all 27 site metric IDs. Missing capabilities or capacity remain documented exceptions. No old source data should be pooled into this rerun.

The default templates are E2B `base` and Superserve `sandbox-bench-node22-py311-1x1-pinned` (UUID `522daf7b-fec9-41d8-80cd-361f3b8b1fa8`), with Node and Python already built in. Superserve’s image digest and apt versions are pinned; its allocation remains 1 vCPU, 1024 MiB RAM and 4096 MiB disk. The allocation map also retains the old unpinned template name for historical reports. `same-spec-nonboat` uses E2B `sandbox-bench-same-spec` (`r1h7gud12rf1f6iu29r0`), Daytona `daytona-large` in target `us`, Upstash `medium`, boxd 4/16, Freestyle default, and Tenki `4:8192`. Boat defaults are collected separately in both tracks. Superserve stays out of same-spec until a 4-vCPU template exists; the current account cap is 2 vCPU. boxd remains explicitly unequal via `equalSpec: false`.

Boat requires an otherwise idle account, because its limits are shared with other callers: 12 creates/minute, 60/hour, 200/day. Each batch has at most 10 creates and waits 65 seconds after completion before another batch. Use these windows:

- Day 1: `boat-default-0` collects 60 main starts. At least 65 minutes after that window's last creation, `boat-default-1` collects 40 main and 20 snapshot-suite starts. After another gap of at least 65 minutes from the last creation, `boat-default-2` collects 10 snapshot-suite starts and three isolated K=10 cohorts, for 40 starts. Total: 160 starts. Only the first 30 main iterations run workloads.
- Day 2: wait at least 26 hours after Day 1's last creation, then run `boat-same-spec-0`, `boat-same-spec-1` and `boat-same-spec-2` with the same 65-minute gaps. Total: 160 starts.

Invoke a window with `bash bench/src/collection-plan.sh WINDOW`. Never attempt Boat K=25 on this plan: a simultaneous cohort would violate the 12-create/minute quota. The generated policy records both tracks' K=25 as not run and snapshots as unsupported. It also records Superserve's same-spec exclusion. Verify and add any other account-cap reasons before using this policy with `bun bench merge --policy ...`; do not raise caps simply to fill the metric table.

## Collect provider billing

Run `bun bench billing --report results/<run>` from `bench`, or use the same command from the repository root with a path relative to `bench`. The command writes `results/<run>/billing.json`; `--out <path>` selects another output. Export the provider credentials used by the benchmark. The collector makes read-only billing requests and creates no sandboxes. `--offline` disables all requests. Missing credentials, network failures, expired records and unsupported providers produce `null` costs with a reason, rather than zero or a time-based estimate.

The collector streams `samples.ndjson` when present, otherwise the `samples` array in `results.json`, then unions sandbox IDs from `ownership.json`. It deduplicates provider/ID ownership (E2B events are paginated). Re-run after settlement; `--wait-ms 1500000` optionally polls boxd for up to 25 minutes until the owned machines report complete. Without that flag it records pending meters immediately. Daytona prices remain pending until 48 hours after the queried window ends. The JSON stores the source, confidence, completion state, recovered subtotals and coverage. A lifetime total or cost per task stays `null` unless every attributed sandbox has a complete lifetime amount of the same kind. Daytona and boxd bounded-window amounts have `scope: "window"` and separate subtotals; settlement alone does not prove full lifetime coverage.

`billedUSD` means provider-reported usage charges before credits, tax and plan minimums, not a net invoice. `meteredUSD` is separate: Boat explicitly returns list-price usage dollars; E2B uses actual execution milliseconds and allocated resources with published rates; boxd prices its meter at current account rates. Superserve hourly charges and boxd billing activity are retained as account evidence, never divided among scenarios. Superserve's monthly summary separates charges, applied credits and expected invoice. Tenki and Freestyle have no verified billing endpoint.

A task means one distinct sandbox lifetime. Whole-sandbox charges belong to its `sandbox-lifetime` scenario, including burst variants, or its sole scenario when only one exists. Shared commands, files and other operations have no separate bill and retain `null` costs. Failed attempts with an ID are included; samples without IDs are counted separately and cannot be priced. Journal-only IDs and shared sandboxes without a lifetime scenario remain unallocated. Snapshot storage, unrelated account activity and subscription minimums are not assigned to tasks. Recovering selected sandbox charges does not establish the full benchmark invoice.


Boat's [machine documentation](https://docs.boat.dev/machines) lists 50 GB for the default machine as the maximum size of user files, excluding the operating system and pre-installed tools. The pilot measured a 68.58 GiB filesystem. Site exports keep those distinct: `requestedAllocation.provisioned.documentedDisk` carries the documented value, unit, scope and source, while `measuredAllocations[].diskGiB` carries the filesystem measurement. Boat disk differences do not affect allocation verification, restore eligibility or its fixed hourly price.


Every collection-plan command passes `--omit-network-download true`, matching the original publication. The public CDN download is not collected because the host rate-limits; guest `urllib` connection resets there do not measure provider performance. CPU, memory, disk and TCP probes remain enabled.


Daytona's verified `us` container account quota is 10 vCPU, 10 GiB RAM and 30 GiB disk. Same-spec main runs one `daytona-large` at a time (4/8/10). Same-spec snapshot/restore would require source plus restore at 8/16/20, so the plan excludes that suite and K=10/K=25 bursts until the quota increases. Default K=25 is also excluded; default K=10 stays enabled as a separate command using exactly 10 vCPU, 10 GiB RAM and 30 GiB disk on an otherwise idle account. The generated policy records all five exclusions with the quota numbers as documented account limits, not provider failures.

## Cost of one tool-replay task

Run `bun bench --providers e2b --scenarios cost --cost-runs 10 --bursts '' --out results/e2b-cost`, then `bun bench billing --report results/e2b-cost`. Use the same track, size and template flags as the matching latency collection. Merge that directory with the other suites before running `site-data`; merge reads its adjacent `billing.json`. Re-run billing and merge after delayed charges settle.

The cost suite defaults to 10 fresh sandboxes per provider. Each sandbox runs create, fixture upload, the same 100-call tool replay, and destroy. It performs no fingerprint, performance probe, snapshot or other workload. Fixture preparation and SDK setup contribute to the billed lifetime. Tasks run sequentially per provider even when provider concurrency is higher. Boat allows at most 10 tasks per invocation, with 6.5 seconds between tasks; use the scheduled collection windows for further batches. Both tracks include this suite. One Daytona same-spec sandbox at a time fits its 10-vCPU / 10-GiB / 30-GiB account quota.

Each site provider entry in each track exports `costPerTask: {usd, kind, source, confidence, n, settled}`. `usd` is the median cost of one completed sandbox task, or `null` when evidence is missing. `n` counts tasks supporting that median. A task must complete its replay and destruction. Native billing must identify every sandbox in the cost suite; mixed billed/metered evidence produces no median. `billed` means a provider-reported charge for each sandbox, before credits and tax. `metered` means provider usage multiplied by published rates. Account-wide charges are never divided among tasks. Per-sandbox window charges qualify only when the billing window encloses the complete sandbox lifetime.

Tenki and Freestyle use `estimate`: list price multiplied by each measured sandbox lifetime, using the matching allocation verified by fingerprints in the other suites. These estimates have low confidence and exclude subscriptions, credits and transfer. `settled: true` for an estimate means the task lifetime is final; it does not imply an invoice. Daytona charges can lag 48 hours, and boxd meters about 25 minutes. Pending values retain their current kind with `settled: false`; missing values have `usd: null`, `n: 0` and `confidence: "none"`. Superserve account-only billing remains unknown until per-task evidence is available.

Admission limits are coverage failures. Any budget-denied provider/scenario appears in `admissionStopped` in `results.json` and `results.md`, and the CLI exits nonzero. The collection script uses `set -e` to stop immediately. Documented capability/account restrictions belong in the collection policy, rather than being hidden by a budget stop.

A create/restore outer deadline remains a failed attempt even if native work later succeeds. During the bounded cleanup drain, its failure sample records `clockPhase` (`adapter-create`, `first-command`, or `sdk-init`) at the deadline and `lateSettlement` with the eventual native ID, reached stage, SDK code and allowlisted cause. Late IDs enter the durable ownership journal only after trusted admission and live ownership verification; other IDs enter cleanupReview. Native error bodies, headers and credentials are excluded. Work that cannot drain within the cleanup budget stops further scheduling and leaves recovery evidence.

Cleanup requires live ownership proof: a read-only provider listing must report both `sandbox-bench-run=<run>` and `sandbox-sdk=1` on the exact sandbox ID. A journal entry or an ID embedded in an error is insufficient. Rejected create IDs qualify for automatic recovery only when the adapter's create call throws an SDK `SandboxError` with the matching provider, `cause.operation="create"`, and `cause.admittedByThisCall=true`; live labels must still verify. Adapters that cannot supply this admission marker leave their IDs for review.

Unverified IDs remain untouched. Failure samples expose `unverifiedSandboxId`, and `cleanupReview` in `results.json` and `results.md` records the provider, ID, resource kind and reason. Collection exits nonzero when review is required. `bun bench reap --run RUN --out DIRECTORY ...` prints these entries and leaves them quarantined for a human; it never deletes a sandbox by bare journal ID. Corrupt journals permit only discovery scoped by both ownership labels. Snapshot recovery also requires a live labelled parent and source-linked snapshot metadata; unsupported metadata queries or a missing parent require manual review. Source-linked snapshot discovery runs before destroying its verified parent.

Live ownership checks and durable journal writes are excluded from cold and burst readiness clocks. Their elapsed times appear separately as `ownershipVerifyMs` and `ownershipPersistMs`.
