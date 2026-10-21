# Superserve benchmark

SBX-51 adds Superserve to the same harness used for the other seven cloud providers. The SDK entry point is `@opencoredev/sandbox-sdk/superserve`; install optional peer `@superserve/sdk` 0.11.4 or later and set `SUPERSERVE_API_KEY` in the child process environment.

The adapter defaults to `superserve/node-22`, with 1 vCPU, 1 GiB RAM, and 4 GiB disk when checked on October 21, 2026. Native `superserve/base` lacked the Python and Node runtimes advertised by the API reference. The Node 22 template supplies Node; SDK creation installs Python, pip, and venv when absent. Cold latency includes this runtime preparation. Custom templates own their resources; the adapter rejects explicit `size` requests. The account used region token `use`, which the native SDK maps to `https://api.superserve.ai`.

Sources: [creation API](https://docs.superserve.ai/api-reference/sandboxes/create-a-new-sandbox), [template resources](https://docs.superserve.ai/sandbox/create), [SDK region routing](https://github.com/superserve-ai/superserve/blob/main/packages/sdk/src/config.ts), and [pricing](https://www.superserve.ai/pricing). All were retrieved October 21, 2026. Published pricing is $0.0504/vCPU-hour and $0.0162/GiB-hour. Harness estimates exclude credits, transfer, snapshot retention, and unspecified disk/minimum charges.

## Collection

Run SDK live conformance from `packages/sdk` with `timeout 1200 bunx vitest run tests/superserve.live.test.ts --maxWorkers=1`, with `SANDBOX_SUPERSERVE_LIVE=1` and the key in that subprocess environment. List native sandboxes afterward and delete only run-owned leftovers.

Publication collection uses 100 main iterations and 30 workload iterations, serial within Superserve. Snapshot/restore uses a separate 30-iteration source. Bursts use three cohorts each at K=10 and K=25. The optional network-download probe is omitted. Each run uses the harness dollar and sandbox admission guards; the combined reserved budget is $14, below the $15 task limit. Commands and exact flags are retained in each source report's `config`.

Real provider failures count as attempts. Our-side account limits and third-party failures require replacement attempts. The guest performance probe failed creating Python multiprocessing semaphores because the shared-memory directory is absent. The harness retains one failure for every expected metric; it does not change the kernels or substitute host measurements.

## Report and cleanup

The new report is `bench/results/publication-final-v3/`. It uses v2's original sources and attempt policy plus the Superserve sources. Earlier reports must remain unchanged. Run `bun bench attempts results/publication-final-v3` from `bench` to check all eight cloud providers. `attempts.tsv` lists every target and documented not-run reason. Collection scripts, raw results, and verification audits remain local under the gitignored `bench/results/` tree.

Snapshots survive sandbox destruction. The harness journals the source before requesting a Superserve snapshot, and both final cleanup and `bench reap` list snapshots only for that owned source. An unknown snapshot outcome remains recoverable after source deletion. Completion requires empty ownership journals, native account listings, and source snapshot listings.

## Results

Collection finished October 21, 2026. The attempt checker passed all 208 cells across eight providers, including inherited, documented not-run cells. Superserve had no not-run cells among the required targets.

| Superserve test | Attempts | Successful | Failed |
| --- | ---: | ---: | ---: |
| Each main lifecycle/file test (7 tests) | 100 each | 100 each | 0 |
| Each performance metric, including TCP (8 metrics) | 100 each | 0 | 100 each |
| Each workload (7 workloads) | 30 each | 30 each | 0 |
| Snapshot | 30 | 30 | 0 |
| Create from snapshot | 30 | 30 | 0 |
| K=10 burst cohorts | 3 | 3 | 0 |
| K=25 burst cohorts | 3 | 3 | 0 |

Main lifecycle/file tests are cold, command, files-1kb, files-10mb, reconnect, pause-resume, and destroy. Every successful pause/resume row includes pause, resume-returned, and resume-ready phases. Performance metrics are cpu-single, cpu-all, memory-mbps, disk-write-mbps, disk-read-mbps, disk-4k-write-iops, disk-4k-read-iops, and tcp-ms. All 105 burst members created successfully. The performance failures are the shared-memory problem described above, retained as provider failures. The optional network-download test was omitted as in SBX-49.

The merged report contains 26,440 selected rows. Its JSON and NDJSON match, all prior-provider rows equal v2, and the original v1/v2 artifact hashes are unchanged. The merge preserves source provenance and reconciles every input row with selected or documented removed rows.

Estimated benchmark usage was $0.117818: main $0.051139, snapshot/restore $0.014181, and bursts $0.052498. Adding a conservative $0.25 allowance for earlier live verification gives less than $0.37, below the $15 limit. This estimate uses published compute rates and is not a billing statement.

Every source finished with empty cleanup and ownership records and an empty native sandbox list. A final independent account list was empty; listing persistent snapshots for all 30 collection source IDs also found zero. SDK live conformance passed 15/15; offline SDK tests passed 454 with 163 gated skips, and benchmark tests passed 75. The focused adapter suite passed 20 with two live-only skips. The final independent review reported no findings.
