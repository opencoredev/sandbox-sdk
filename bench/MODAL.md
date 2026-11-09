# Modal benchmark

SBX-103 adds Modal Sandboxes. The SDK entry point is `@opencoredev/sandbox-sdk/modal`, which loads Modal's official `modal` package (0.11.1, an optional peer; Modal's API is gRPC). Set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in the child process environment. `bench/src/providers.ts` registers both credentials, `image` as the template option, and `MODAL_SANDBOX_REGION` as the region key. The adapter reads that variable too, so setting it both labels and pins the run. Everything below was measured on November 9, 2026, from evo-1, unless a source says otherwise.

## Sizes

Modal documents `cpu` as physical cores and bills each as "2 vCPU equivalent" ([pricing](https://modal.com/pricing), [sandbox resources](https://modal.com/docs/guide/sandbox-resources)). Measured behavior does not match that wording. The sandbox runtime is gVisor (`uname -r` 4.19.0-gvisor), and there is no cgroupfs: `/sys/fs/cgroup/cpu.max`, `cpu.stat` and `memory.max` do not exist. CPU was therefore measured as throughput: one fixed single-threaded Node loop (about 10 s alone), then k copies at once, with effective threads = k × t1 / tk.

| Request                           | `nproc` | `/proc/cpuinfo` | `MemTotal`  | Effective threads (k = 1, 2, 4, 6, 8, 12) |
| --------------------------------- | ------- | --------------- | ----------- | ----------------------------------------- |
| `cpu: 1, cpuLimit: 1`, 4 GiB      | 1       | 2               | not printed | 1.00, 1.05, 1.03, 1.02                    |
| `cpu: 2, cpuLimit: 2`, 8 GiB      | 2       | 2               | 8 GiB       | 1.00, 1.99, 2.02, 2.02, 1.99, 2.06        |
| `cpu: 4, cpuLimit: 4`, 8 GiB      | 4       | 4               | 8 GiB       | 1.00, 2.04, 4.03, 4.17, 3.32, 4.11        |
| `cpu: 4`, no limit, 8 GiB request | 4       | 20              | host memory | 1.00, 2.04, 4.08, 6.10, 7.26, 11.00       |
| default (no `cpu`, no memory)     | 1       | 17              | host memory | not measured                              |

**Same-spec (4 vCPU / 8 GiB): `cpu: 4`, not 2.** Use `--size modal=4:8192`. The adapter turns it into `cpu: 4, cpuLimit: 4, memoryMiB: 8192, memoryLimitMiB: 8192`, and the guest then shows `nproc` 4, four CPUs in `/proc/cpuinfo` and `MemTotal` 8 GiB (8388608 kB).

Modal's docs call one `cpu` a physical core and bill it as "2 vCPU equivalent", which would make `cpu: 2` the 4 vCPU setting. The measurement says otherwise. A second check on November 9, 2026 compared Modal with an already-benchmarked 4 vCPU / 8 GiB sandbox (E2B template `sandbox-bench-same-spec`) on one fixed pure-CPU job: Python SHA-256 over an in-memory 64 MiB buffer, 24 times (no syscalls in the loop), as 1, 2, 4 and 8 concurrent copies, three repeats each, wall time from `date +%s.%N`. Effective threads = k × t1 / tk; throughput = copies per second at k = 8.

| Sandbox                            | `nproc` | t1 (s), 3 runs   | t4 (s)           | t8 (s)           | Effective threads k = 2 / 4 / 8 | Throughput at k = 8 vs E2B |
| ---------------------------------- | ------- | ---------------- | ---------------- | ---------------- | ------------------------------- | -------------------------- |
| Modal `cpu: 2, cpuLimit: 2`, 8 GiB | 2       | 1.29, 1.26, 1.26 | 2.01, 2.22, 2.69 | 5.14, 4.90, 5.20 | 2.0 / 2.2 / 2.0                 | 0.53×                      |
| Modal `cpu: 4, cpuLimit: 4`, 8 GiB | 4       | 1.27, 1.27, 1.27 | 1.27, 1.27, 1.27 | 2.47, 2.19, 2.68 | 2.0 / 4.0 / 4.1                 | 1.10×                      |
| E2B 4 vCPU / 8 GiB                 | 4       | 1.07, 1.10, 0.88 | 1.39, 1.40, 1.33 | 2.74, 2.69, 2.67 | 1.7 / 3.0 / 3.0                 | 1.00×                      |

`openssl speed -multi` was also run but is not used: it divides by CPU time, not wall time, so it overstates oversubscribed runs (Modal `cpu: 2` "reached" 4.7 GB/s at eight processes while the wall-clock job showed two threads).

Reading: `cpu: 4` gives four full-speed threads and does about 10% more parallel work than E2B's 4 vCPU, whose four vCPUs scale like two cores with hyperthreads (3.0 effective threads). `cpu: 2` delivers about half of E2B. So `cpu: 4` is the same-spec setting by guest view (4 CPUs, 8 GiB) and by throughput, and no "machine differs" label is needed. What it costs is four Modal cores, which Modal would call 8 vCPU equivalent, at $0.7596 an hour before any region multiplier. Disclose both on the site: requested `cpu: 4` (4 physical cores as Modal bills them), measured 4 threads of throughput. Caveat: one sandbox per setting, one day, three repeats. The live test `same-spec size shows 4 CPUs and 8 GiB and runs 4 threads of parallel throughput` re-checks effective threads above 3.4 on every live run.

**Default track.** With no `size`, Modal requests 0.125 CPU and 128 MiB ([sandbox resources](https://modal.com/docs/guide/sandbox-resources)) and lets the sandbox burst into spare host capacity, up to 16 CPUs above the request. The guest shows `nproc` 1, request + 16 processors in `/proc/cpuinfo`, and the host's whole memory in `MemTotal` (203 to 1,024 GiB across four hosts). Fingerprints will therefore not match a provisioned allocation: leave Modal's default out of `src/provisioned-allocations.ts` and expect allocation verification to report it as unknown. Burst capacity depends on the host, so default-track performance varies more than on providers with fixed defaults.

## Region

Without a region, four probe sandboxes landed in `us-east` (cloud unspecified), `us-east` (GCP), `us-east` (AWS) and `us-west` (AWS), per `MODAL_REGION` and `MODAL_CLOUD_PROVIDER` inside the guest. The closest option to a Florida caller is `us-east` (Virginia). `MODAL_SANDBOX_REGION=us-east` pinned every sandbox there, checked by the live test. Modal adds a region multiplier on top of base price: 1.15× for a broad region such as `us`, 1.75× for a narrow one such as `us-east` ([region selection](https://modal.com/docs/guide/region-selection)). Pinning `us-east` gives comparable latency at 1.75× cost; `us` costs 1.15× but can land on the West Coast. Disclose which one the run used.

## Lifetime, image and cleanup

- **Lifetime.** Modal stops a sandbox after 5 minutes without a lifetime ([sandbox guide](https://modal.com/docs/guide/sandbox)). `loadProvider` now passes `modal({ timeoutMs })`: by default `--timeout-ms` × 19 (15 scenarios plus create, fingerprint, restore and destroy), 57 minutes at the default 180 s, which covers a whole iteration and its restores. `--lifetime-ms modal=<ms>` overrides it (at most 24 hours; `src/lifetime.ts`). The realistic workloads (build plus the 60-minute held-open test) need more: pass, for example, `--lifetime-ms modal=7200000` there.
- **Image.** The default image is `node:22-bookworm` (git, Python 3, Node, GNU coreutils, util-linux). The first create in a workspace waits about 55 s while Modal imports it; later raw creates returned in 50 to 150 ms. Warm the image with one create before cold samples, and disclose it.
- **Create.** Modal's `create` returns once the sandbox is scheduled. Cold timing should stop at the first successful command, as the runner already does.
- **Destroy.** `destroy()` requests termination (about 100 to 300 ms), then waits until Modal reports the sandbox stopped, up to 60 s. Modal sometimes takes about 30 s to stop one (2 of 18 in a probe, both terminated right after create) and may bill until then. The `destroy` row therefore times the confirmed stop, and its phases split it: `terminateRequestMs` (Modal accepted the request) and `confirmedStopMs` (Modal reported it stopped), passed through the adapter's `onDestroy`. Other adapters' `destroy` rows time their native delete call and do not poll for a stop, so for a like-for-like "request" comparison publish `terminateRequestMs`; for "gone and no longer billing", the row itself. Say which on the site. An unconfirmed stop is a retryable `timeout` failure, and the sandbox stays in `list()` with state `stopped` so cleanup finds it.
- **Labels.** Modal allows ten tags and 1024 bytes. The SDK uses three (`sandbox-sdk`, `sandbox-sdk-created`, room for `sandbox-sdk-destroying`) and the bench one (`sandbox-bench-run`), leaving six.
- **App.** All sandboxes go to the App `sandbox-sdk` unless the factory sets `app`. For per-attempt billing, `modal({ createApp: ({ labels }) => ... })` picks an App per unkeyed create (keyed creates stay in `app`), and `list()` scans `app` plus every App the same provider instance has created into or prepared (Modal deprecates Environment-wide listing), so in-run ownership checks see every sandbox. Call `provider.prepareApp(name)` before the timed create, which also keeps the App lookup out of create timing, and again for each journaled App when a fresh process (`bench reap`, recovery) must list them.
- **Snapshots.** `src/snapshots.ts` cleans Modal snapshots (Images) with a fresh `ModalClient` (`images.delete`) and checks them with `images.fromId`, which throws `NotFoundError` once deleted. Modal Images record no source sandbox, so provenance rests on the ownership journal. Snapshots keep files, not CPU or memory: the runner passes the source's `--size` to the restore for Modal only (other providers' restores are unchanged), and `restore-fingerprint` verifies it.

## Pricing

Sandbox rates on [modal.com/pricing](https://modal.com/pricing), retrieved November 9, 2026, are three times the Function list rates, because sandboxes are billed as non-preemptible:

| Resource | Sandboxes                                     | Functions (for comparison) |
| -------- | --------------------------------------------- | -------------------------- |
| CPU      | $0.00003942 per CPU-second ($0.1419 per hour) | $0.0000131 per CPU-second  |
| Memory   | $0.00000667 per GiB-second ($0.0240 per hour) | $0.00000222 per GiB-second |

The account's own rate table (`workspaceBillingRates`, a gRPC call in Modal's SDK that is not public API) returned `cpu_hour_cost_sandbox` 0.141900 and `mem_gib_hour_cost_sandbox` 0.024000, matching. Billing is per second at `max(request, usage)` for CPU and memory, with a minimum request of 0.125 CPU ([sandbox resources](https://modal.com/docs/guide/sandbox-resources)). Disk has no separate charge in this setup. Plans include monthly credits ($30 Starter, $100 Team).

- Same-spec 4 CPU / 8 GiB: 4 × 0.1419 + 8 × 0.024 = **$0.7596 per hour** before any region multiplier, $1.329 per hour pinned to `us-east`.
- Default: at least 0.125 × 0.1419 + 0.125 × 0.024 = $0.0207 per hour, plus whatever the sandbox bursts to, because usage above the request is billed. Allocation × wall time is a lower bound, not an estimate.

`src/pricing.ts` encodes this: `cpuSecond: 0.00003942`, `memoryGiBSecond: 0.00000667`, `diskGiBSecond: 0`, one-second increment, `requestBilled` (minimum 0.125 CPU / 0.125 GiB) and `regionMultiplier` (1.15× for `us`, `eu`, `ap`; 1.75× for any narrower region; a list mixing both is charged at the smaller, as Modal documents). `src/billed-resources.ts` prices Modal on the requested allocation and never on the guest view: a sized sandbox is exact (request = limit, so usage cannot exceed it), and the default track is the 0.125 CPU / 128 MiB minimum, labelled a lower bound in the notes and methodology. Pricing the default track's guest view (1 CPU and the host's 203 to 1,024 GiB) instead reserves $4.80 (a 203 GiB host) to $23 (1,024 GiB) per main-suite iteration, $41 pinned to `us-east`, enough to stop collection under the $5 default; the admission guard now reserves the conservative 8 CPU / 16 GiB fallback for the default track (about $1.44 per iteration, $2.53 pinned to `us-east`) and charges the budget at it. Samples carry no region, so the summary's performance-per-dollar ratio leaves the region multiplier out; per-sample and lifetime estimates include it.

## Billing source

Modal's billing reports ([billing guide](https://modal.com/docs/guide/billing), [CLI](https://modal.com/docs/reference/cli/billing)) give cost per object (App) by hour or day, with tags, before credits, reservations and the egress allowance, within minutes of use. They are documented for the Team and Enterprise plans and reached through the Python SDK (`Workspace.billing.report()`) or `modal billing report`. Modal's JavaScript SDK has no billing method. Its raw gRPC client has `workspaceBillingReport`, `workspaceBillingSummary` and `workspaceBillingRates`, which Modal does not document as public API.

On this account, `workspaceBillingReport` for the last 2 days, hourly, all tags, returned no rows although the account had usage, which fits the plan restriction (not confirmed). `workspaceBillingSummary` returned the month's metered cost by category (`Deployed Apps`, `Volumes`, `Network Egress`, `LLM Tokens`) and a billed amount of $0, not per sandbox. So no per-sandbox charge is available here: treat Modal like Tenki and Freestyle in `bun bench billing` (estimate from list price × measured lifetime × observed allocation, low confidence) unless a Team plan and a per-run App allow App-level attribution.

## Verification on November 9, 2026

- `tests/modal.live.test.ts`: 25 of 25 passed, the full shared conformance suite plus same-spec size, snapshot restore and `deleteSnapshot`, a template build, `network: "none"` (hostname and raw IP blocked, preview still served) and allow lists, the `us-east` pin, a portless preview request, fast `destroy` with immediate key reuse, and a final check that no sandbox from the run was still running.
- Offline: `tests/modal.test.ts` runs the same suite against a mock backed by local processes.
