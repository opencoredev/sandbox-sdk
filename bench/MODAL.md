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

**Same-spec (4 vCPU / 8 GiB): `cpu: 4`, not 2.** Use `--size modal=4:8192`. The adapter turns it into `cpu: 4, cpuLimit: 4, memoryMiB: 8192, memoryLimitMiB: 8192`, and the guest then shows `nproc` 4, four CPUs in `/proc/cpuinfo` and `MemTotal` 8 GiB (8388608 kB), which the live test `same-spec size gives 4 CPUs of throughput and 8 GiB` asserts. `cpu: 2` tops out at two threads. Single-thread speed was the same in every configuration (9.7 to 11.0 s per unit), so whether a Modal CPU unit is a whole physical core with an idle hyperthread sibling can't be told from inside.

**Default track.** With no `size`, Modal requests 0.125 CPU and 128 MiB ([sandbox resources](https://modal.com/docs/guide/sandbox-resources)) and lets the sandbox burst into spare host capacity, up to 16 CPUs above the request. The guest shows `nproc` 1, request + 16 processors in `/proc/cpuinfo`, and the host's whole memory in `MemTotal` (203 to 1,024 GiB across four hosts). Fingerprints will therefore not match a provisioned allocation: leave Modal's default out of `src/provisioned-allocations.ts` and expect allocation verification to report it as unknown. Burst capacity depends on the host, so default-track performance varies more than on providers with fixed defaults.

## Region

Without a region, four probe sandboxes landed in `us-east` (cloud unspecified), `us-east` (GCP), `us-east` (AWS) and `us-west` (AWS), per `MODAL_REGION` and `MODAL_CLOUD_PROVIDER` inside the guest. The closest option to a Florida caller is `us-east` (Virginia). `MODAL_SANDBOX_REGION=us-east` pinned every sandbox there, checked by the live test. Modal adds a region multiplier on top of base price: 1.15× for a broad region such as `us`, 1.75× for a narrow one such as `us-east` ([region selection](https://modal.com/docs/guide/region-selection)). Pinning `us-east` gives comparable latency at 1.75× cost; `us` costs 1.15× but can land on the West Coast. Disclose which one the run used.

## Lifetime, image and cleanup

- **Lifetime.** The runner passes no `timeoutMs`, and Modal stops a sandbox after 5 minutes without one ([sandbox guide](https://modal.com/docs/guide/sandbox)), so iterations with workloads would die mid-run. The factory takes `timeoutMs` (at most 24 hours), but `loadProvider` only forwards string and boolean template/product options. Wire `modal({ timeoutMs })` before collecting.
- **Image.** The default image is `node:22-bookworm` (git, Python 3, Node, GNU coreutils, util-linux). The first create in a workspace waits about 55 s while Modal imports it; later raw creates returned in 50 to 150 ms. Warm the image with one create before cold samples, and disclose it.
- **Create.** Modal's `create` returns once the sandbox is scheduled. Cold timing should stop at the first successful command, as the runner already does.
- **Destroy.** `destroy()` tags the sandbox `destroyed` and requests termination without waiting, in about 100 to 300 ms. Modal itself sometimes takes about 30 s to stop a sandbox (2 of 18 in a probe, both terminated right after create), so a `destroy` latency sample measures the request, not the stop. Modal may bill until the stop; that was not measured.
- **Labels.** Modal allows ten tags and 1024 bytes. The SDK uses two and the bench one (`sandbox-bench-run`), leaving seven.
- **App.** All sandboxes go to the App `sandbox-sdk` unless the factory sets `app`. A per-run App (`modal({ app: "sandbox-sdk-bench-<run>" })`) makes App-level billing attribution possible.

## Pricing

Sandbox rates on [modal.com/pricing](https://modal.com/pricing), retrieved November 9, 2026, are three times the Function list rates, because sandboxes are billed as non-preemptible:

| Resource | Sandboxes                                     | Functions (for comparison) |
| -------- | --------------------------------------------- | -------------------------- |
| CPU      | $0.00003942 per CPU-second ($0.1419 per hour) | $0.0000131 per CPU-second  |
| Memory   | $0.00000667 per GiB-second ($0.0240 per hour) | $0.00000222 per GiB-second |

The account's own rate table (`workspaceBillingRates`, a gRPC call in Modal's SDK that is not public API) returned `cpu_hour_cost_sandbox` 0.141900 and `mem_gib_hour_cost_sandbox` 0.024000, matching. Billing is per second at `max(request, usage)` for CPU and memory, with a minimum request of 0.125 CPU ([sandbox resources](https://modal.com/docs/guide/sandbox-resources)). Disk has no separate charge in this setup. Plans include monthly credits ($30 Starter, $100 Team).

- Same-spec 4 CPU / 8 GiB: 4 × 0.1419 + 8 × 0.024 = **$0.7596 per hour** before any region multiplier, $1.329 per hour pinned to `us-east`.
- Default: at least 0.125 × 0.1419 + 0.125 × 0.024 = $0.0207 per hour, plus whatever the sandbox bursts to, because usage above the request is billed. Allocation × wall time is a lower bound, not an estimate.

For `src/pricing.ts`: `cpuSecond: 0.1419 / 3600`, `memoryGiBSecond: 0.024 / 3600`, `diskGiBSecond: 0`, one-second increment, no creation fee listed, and notes covering the region multiplier, the 0.125-CPU minimum and usage-based burst billing.

## Billing source

Modal's billing reports ([billing guide](https://modal.com/docs/guide/billing), [CLI](https://modal.com/docs/reference/cli/billing)) give cost per object (App) by hour or day, with tags, before credits, reservations and the egress allowance, within minutes of use. They are documented for the Team and Enterprise plans and reached through the Python SDK (`Workspace.billing.report()`) or `modal billing report`. Modal's JavaScript SDK has no billing method. Its raw gRPC client has `workspaceBillingReport`, `workspaceBillingSummary` and `workspaceBillingRates`, which Modal does not document as public API.

On this account, `workspaceBillingReport` for the last 2 days, hourly, all tags, returned no rows although the account had usage, which fits the plan restriction (not confirmed). `workspaceBillingSummary` returned the month's metered cost by category (`Deployed Apps`, `Volumes`, `Network Egress`, `LLM Tokens`) and a billed amount of $0, not per sandbox. So no per-sandbox charge is available here: treat Modal like Tenki and Freestyle in `bun bench billing` (estimate from list price × measured lifetime × observed allocation, low confidence) unless a Team plan and a per-run App allow App-level attribution.

## Verification on November 9, 2026

- `tests/modal.live.test.ts`: 25 of 25 passed, the full shared conformance suite plus same-spec size, snapshot restore and `deleteSnapshot`, a template build, `network: "none"` (hostname and raw IP blocked, preview still served) and allow lists, the `us-east` pin, a portless preview request, fast `destroy` with immediate key reuse, and a final check that no sandbox from the run was still running.
- Offline: `tests/modal.test.ts` runs the same suite against a mock backed by local processes.
