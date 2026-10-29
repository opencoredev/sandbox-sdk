# Superserve benchmark

SBX-51 adds Superserve to the same harness used for the other seven cloud providers. The SDK entry point is `@opencoredev/sandbox-sdk/superserve`, which needs no other package; set `SUPERSERVE_API_KEY` in the child process environment.

The public adapter default remains `superserve/node-22`: 1 vCPU, 1024 MiB RAM, and 4096 MiB disk, checked October 21, 2026. That template lacks Python. Creation now fails with `unsupported` unless you choose a Python-equipped template or explicitly set `installPython: true`. The opt-in restores the earlier apt installation of Python, pip, and venv during creation. That preparation inflated the original cold and burst measurements. Use the retained custom template below for benchmark reruns; keep the public SDK default unchanged because the custom template belongs to this account.

Custom templates own their resources; the adapter rejects explicit `size` requests. Pass their name or UUID through `superserve({ template })`. Runtime installation defaults to off. If Python is already present, creation does not run apt, including when installation is explicitly enabled. The account uses region token `use`, which the native SDK maps to `https://api.superserve.ai`.

Sources: [creation API](https://docs.superserve.ai/api-reference/sandboxes/create-a-new-sandbox), [template resources](https://docs.superserve.ai/sandbox/create), [SDK region routing](https://github.com/superserve-ai/superserve/blob/main/packages/sdk/src/config.ts), and [pricing](https://www.superserve.ai/pricing). All were retrieved October 21, 2026. Published pricing is $0.0504/vCPU-hour and $0.0162/GiB-hour. Harness estimates exclude credits, transfer, snapshot retention, and unspecified disk/minimum charges.

## Build the benchmark template

Use the retained pinned template `sandbox-bench-node22-py311-1x1-pinned` (ready, UUID `522daf7b-fec9-41d8-80cd-361f3b8b1fa8`) for reruns. The earlier unpinned template `sandbox-bench-node22-py311-1x1` (UUID `17f4ed04-5542-4956-8cc2-c17d25234e3e`) is retained for provenance. It has exactly 1 vCPU, 1024 MiB RAM, and 4096 MiB disk, preserving the provider default resource allocation.

The build script uses official `@superserve/sdk` 0.11.4 and starts from `node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`. Docker Hub returned this same digest for the original floating tag when checked. The digest fixes the base image; Debian and Debian-security use the dated `snapshot.debian.org` mirrors at `20261022T000000Z`, fixing dependency resolution. Archive signatures remain enabled; only snapshot expiry checks are disabled.

At build time it installs Python 3, venv, pip, git, tar, coreutils, procps, and CA certificates; creates `/dev/shm` with mode 1777; and checks the tools and Python multiprocessing. The live image has Node 22.23.4, npm 10.9.9, and Python 3.11.2.

The requested apt packages are additionally pinned to versions recovered from the original template: `python3=3.11.2-1+b1`, `python3-venv=3.11.2-1+b1`, `python3-pip=23.0.1+dfsg-1`, `git=1:2.39.5-0+deb12u3`, `tar=1.34+dfsg-1.2+deb12u1`, `coreutils=9.1-1`, `procps=2:4.0.2-3`, and `ca-certificates=20250419~deb12u2`. The rebuilt template's complete 141-package Debian inventory matches the original. This fixes the image and package inputs; Superserve's template infrastructure remains provider-controlled.

From the repo root, with `SUPERSERVE_API_KEY` exported:

```sh
bun install --cwd bench/templates/superserve --frozen-lockfile
timeout 960 bun bench/templates/superserve/build.ts 1x1
```

A successful build waits for ready, creates a temporary verification sandbox, checks the runtime versions, and writes the template name plus observed Node/npm/Python versions to stdout. It destroys the verification sandbox and retains the template. Expected output:

```text
sandbox-bench-node22-py311-1x1-pinned
Node v22.23.4
npm 10.9.9
Python 3.11.2
```

Reuse the ready template for reruns rather than invoking the build again with an existing name.

For the same-spec track, run the same command with `4x8`. The pinned recipe requests `sandbox-bench-node22-py311-4x8-pinned`, with 4 vCPU, 8192 MiB RAM, and 4096 MiB disk. **BLOCKED:** the original unpinned 4x8 attempt was rejected by the live API with `vcpu must be 1-2 (your team's limit)`. No 4x8 template was created; the pinned 4x8 recipe has not been retried against this unchanged limit. Retry after Superserve raises the account limit; do not substitute a smaller machine.

`superserve/python-3.11` lacks Node/npm and `/dev/shm`; `superserve/omnara` has different resources (2 vCPU / 4 GiB). Neither substitutes for this default-size template.

## Verification on October 21, 2026

Five serial samples per template measured adapter `provider.create()` through native `commands.run("true")`. This includes adapter bootstrap, but excludes core `createSandbox()` git checkpoint setup. The baseline uses the unchanged public default and its runtime apt installation.

- `superserve/node-22`: 16.207, 15.993, 15.826, 15.642, 15.886 seconds; median **15.886 seconds**.
- `sandbox-bench-node22-py311-1x1`: 0.679, 0.593, 0.436, 0.548, 0.395 seconds; median **0.548 seconds**.

A separate five-sample native `Sandbox.create()` → bare `true` check, excluding adapter setup, measured 0.299, 0.270, 0.160, 0.540, 0.194 seconds; median **0.270 seconds**. These are smoke measurements, not replacement publication distributions. Baseline, custom-template checks, and conformance overlapped on the account; each timing series itself was serial.

Live checks found node, npm, python3, git, tar, and nohup. `/dev/shm` had mode 1777 and `multiprocessing.Lock()` acquired and released successfully. The apt history timestamp remained at template build time. All 15 live adapter conformance tests passed against the custom template. A final native account listing contained zero sandboxes; the ready 1x1 template remains available.

Reruns change the guest image and repair its shared-memory directory. Resource allocation stays the same. Preserve the historical reports and identify the template in new report metadata; these numbers must not be pooled with the original template's results.

## Pinned-template verification on October 21, 2026

The pinned rebuild preserves the original resources and installed software versions. Five serial adapter create → native bare `true` samples measured 0.714, 0.690, 0.700, 0.506, 0.512 seconds; median **0.690 seconds**. Five separate serial native create → bare `true` samples measured 0.427, 0.207, 0.135, 0.290, 0.283 seconds; median **0.283 seconds**. The earlier unpinned medians were 0.548 seconds including adapter setup and 0.270 seconds native. These small smoke series establish usability, not a performance regression or improvement; they are not publication replacements.

Node 22.23.4, npm 10.9.9, Python 3.11.2, git, tar, and nohup were present. `/dev/shm` was mode 1777 and `multiprocessing.Lock()` acquired and released successfully. The apt history timestamp remained at pinned-template build time. The full 141-package installed Debian inventory matched the original template exactly. All 15 live adapter conformance tests passed against the pinned template. The final native listing contained zero sandboxes; both templates remain ready. Use the pinned template name in report metadata and keep historical results separate.

## Adapter setup reduction

Creation combines tool checks, directory creation, environment JSON, and supervisor installation into one guest command. Caller environment values travel in the command API's environment payload, outside the command string and argv. The environment file is mode 0600. The authoritative metadata read runs alongside setup because native SDK 0.11.4 discards `createdAt` from its create result.

The adapter no longer PATCHes an unset auto-pause timeout. Superserve's creation API documents that an omitted timeout leaves a fresh sandbox active until explicitly paused. A snapshot can inherit a configured timeout, so creation still clears one when the metadata read finds it. This preserves lifecycle behavior while removing an unnecessary request from normal fresh creates.

Five serial samples against the pinned 1x1 template measured adapter `create()` → bare adapter `exec("true")`, matching the harness readiness path and excluding core SDK handle initialization. Before: 0.889, 0.711, 0.666, 0.621, 0.614 seconds (median **0.666 seconds**). After combining setup: 0.707, 0.484, 0.455, 0.472, 0.461 seconds (median **0.472 seconds**). Unlike the earlier native-`true` checks, this path includes the adapter command supervisor. These are small smoke series, not published distributions. Live conformance passed 15/15 after the setup reduction.

## Python installation is explicit

The public template default remains `superserve/node-22`; it currently lacks Python. `superserve()` therefore fails fast with `unsupported` and a message explaining the choices. The failed allocation is destroyed. Use a template containing Python, git, tar, and nohup for benchmarks and normal creation. For legacy convenience, `superserve({ installPython: true })` explicitly permits apt to install Python, pip, and venv when absent. That time remains part of adapter creation; benchmark reruns must leave this option off and select the pinned template.

The final implementation measured adapter create → bare adapter `true` at 0.610, 0.473, 0.460, 0.468, 0.444 seconds across five fresh serial samples (median **0.468 seconds**, versus the unchanged before median **0.666 seconds**). The Python opt-in does not change the measured boundary. These checks exclude core SDK handle initialization and use the pinned template with installation disabled. Live default-template creation failed clearly in 0.596 seconds and left no allocation; a separate explicit opt-in installed Python 3.11.2 in 15.616 seconds. Final live conformance passed 15/15, and the final native sandbox listing was empty.

## Collection

Run SDK live conformance from `packages/sdk` with `timeout 1200 bunx vitest run tests/superserve.live.test.ts --maxWorkers=1`, with `SANDBOX_SUPERSERVE_LIVE=1`, `SANDBOX_SUPERSERVE_TEMPLATE=sandbox-bench-node22-py311-1x1-pinned`, and the key in that subprocess environment. List native sandboxes afterward and delete only run-owned leftovers.

Publication collection uses 100 main iterations and 30 workload iterations, serial within Superserve. Snapshot/restore uses a separate 30-iteration source. Bursts use three cohorts each at K=10 and K=25. The optional network-download probe is omitted. Each run uses the harness dollar and sandbox admission guards; the combined reserved budget is $14, below the $15 task limit. Commands and exact flags are retained in each source report's `config`.

Real provider failures count as attempts. Our-side account limits and third-party failures require replacement attempts. In the original collection, the guest performance probe failed creating Python multiprocessing semaphores because the shared-memory directory was absent. The harness retains one failure for every expected metric; it does not change the kernels or substitute host measurements.

## Report and cleanup

The new report is `bench/results/publication-final-v3/`. It uses v2's original sources and attempt policy plus the Superserve sources. Earlier reports must remain unchanged. Run `bun bench attempts results/publication-final-v3` from `bench` to check all eight cloud providers. `attempts.tsv` lists every target and documented not-run reason. Collection scripts, raw results, and verification audits remain local under the gitignored `bench/results/` tree.

Snapshots survive sandbox destruction. The harness journals the source before requesting a Superserve snapshot, and both final cleanup and `bench reap` list snapshots only for that owned source. An unknown snapshot outcome remains recoverable after source deletion. Completion requires empty ownership journals, native account listings, and source snapshot listings.

## Historical results

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
