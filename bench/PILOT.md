# SBX-45 validation pilot

The v2 harness collected 566 observations in `sbx45-pilot-v2-fixed-20261019`: 530 successful measurements, 30 failures and 6 skips. This is a validation dataset, not a provider ranking. The SDK overhead fix SBX-44 has not been merged here.

The report is `bench/results/pilot-v2-fixed/index.html`; raw JSON, Markdown and synchronized NDJSON are beside it. Generated reports remain ignored because they include egress IPs and hardware identifiers. The initial aborted run is in `bench/results/pilot-v2/`. The final snapshot-path check is in `bench/results/snapshot-check/`.

## Observed behavior

| Provider | Successful observations | Failures | Skips | Result |
|---|---:|---:|---:|---|
| local | 73 | 0 | 0 | All scenarios passed; Docker reference baseline. |
| e2b | 73 | 0 | 0 | All scenarios passed. |
| daytona | 64 | 6 | 0 | Snapshot timeout, subsequent busy-state operations, CDN reset; first pip sample used the superseded numpy pin. |
| upstash | 71 | 2 | 0 | 10 MiB file round trips rejected with invalid_argument. |
| boat | 57 | 6 | 4 | Preview URLs require an access token; transient unavailable errors in replay and file transfer. |
| boxd | 59 | 6 | 2 | Preview certificate verification failures; 10 MiB file transfer failures. |
| freestyle | 73 | 0 | 0 | All scenarios passed. |
| tenki | 60 | 10 | 0 | Both resumes exceeded the adapter deadline; first-iteration failures cascaded after resume. |

All eight providers completed K=3 with three successful cold samples. Railway and Vercel skipped because credentials are absent. Every provider completed the hardware and CPU/disk/memory probes; Daytona CDN downloads reset. Pip now pins numpy 2.3.5, which has Python 3.14 wheels: the second Daytona sample passed. The final local snapshot check passed snapshot, restore, restored hardware fingerprint and deletion. The same check reproduced Daytona’s 60-second native snapshot timeout.

## Adapter and provider evidence

- Boat: `packages/sdk/src/providers/boat/index.ts:390` returns only the host-port URL. Its preview replied HTTP 403 with “Access denied. This preview requires an access token.” The adapter drops the authentication information needed to access it.
- Upstash: both `files-10mb` samples failed with `Upstash Box request failed (invalid_argument)` in about one second. The small transfer passed. Native transfer limits need investigation.
- boxd: both preview attempts failed certificate verification; both large file transfers failed with the adapter’s generic request error. TLS verification remains enabled.
- Tenki: both `pause-resume` samples exceeded the adapter’s 30-second deadline. The first iteration’s later errors followed the failed resume and must not be treated as independent failures. Snapshot/restore and the workloads passed in the second iteration before resume.
- Daytona: its SDK snapshot wrapper generates a random name before creation and loses it when creation times out. An exact-source snapshot query recovered the initial timed-out snapshot, which was deleted. V2 now journals a chosen name before invoking the native snapshot method. The focused check reproduced the timeout and journaled the source VM for recovery.

No SDK source files were changed. These observations distinguish confirmed adapter behavior from provider/network failures that need further diagnosis.

## Estimated full-run usage cost

The following marginal estimates extrapolate pilot durations, including failures. Normal means 100 iterations of lifecycle/command/files/fingerprint/performance; workloads means 30 runs of each of the seven workload scenarios. Bursts are one cohort each. Restored hardware timing absent in the early pilot is estimated from source fingerprint duration for planning only. Unsupported operations are excluded. Account caps may skip the larger cohorts.

| Provider | Currency | Normal 100 | Each workload 30 | K=10 | K=25 | Total |
|---|---|---:|---:|---:|---:|---:|
| local | USD | 0.00000 | 0.00000 | 0.00000 | 0.00000 | 0.00000 |
| e2b | USD | 0.18655 | 0.05504 | 0.00183 | 0.00457 | 0.24800 |
| daytona | USD | 0.19149 | 0.05328 | 0.00231 | 0.00575 | 0.25284 |
| upstash | USD | 0.94371 | 0.15219 | 0.02670 | 0.06679 | 1.18939 |
| boat | USD | 0.18900 | 0.05550 | 0.00153 | 0.00383 | 0.24986 |
| boxd | EUR | 0.23888 | 0.07017 | 0.00289 | 0.00712 | 0.31905 |
| freestyle | USD | 0.49802 | 0.07700 | 0.00499 | 0.01239 | 0.59240 |
| tenki | USD | 0.40113 | 0.07710 | 0.00316 | 0.00784 | 0.48922 |

These are estimates, not quotes or invoices. They exclude fixed subscriptions, minimum monthly commitments (including Boat), credits, transfer and retained snapshot storage. Upstash active-CPU billing and boxd used-memory/written-disk billing make allocation-based estimates upper bounds. Local excludes host ownership and operating costs. Larger bursts can encounter limits and take longer. Allow at least 2× the projected total as a usage budget; the README commands deliberately retain higher conservative admission limits.

## Recommended collection

Use the two commands in [README.md](README.md): 100 normal iterations, 30 workload iterations, global concurrency 4 and per-provider concurrency 1; then isolated K=10 and K=25 bursts with global concurrency 25. Keep account caps until actual entitlements are verified. Keep the recorded seed at 45. Merge SBX-44 and resolve the preview/resume/transfer blockers before publishing a comparison.

The pilot loaded an earlier runner revision. Final cleanup retries, restored fingerprints, provisional-NDJSON finalization and preview readiness retries received offline regression checks afterward. Final local snapshot behavior was exercised live. The pilot’s raw failures remain unchanged; final reports were regenerated with the corrected summaries and planning math.

## Verification

- PASS: 30 offline tests, bench typecheck, bench lint and SDK build.
- PASS: final NDJSON exactly matches all 566 JSON samples, including burst aggregates.
- PASS: actual HTML opened and screenshotted at 1440×1000 and 390×844; page width equals viewport width, with tables scrolling within their own containers. Tested on this Linux host’s headless Chromium; no remote devices tested.
- PASS: scoped reap of the main corrected pilot returned zero leftovers on all eight providers. The initial aborted pilot was also reaped to zero.
- FAIL: all-provider, all-scenario success. The failures above remain data.
- NOT CHECKED: the large publication run, K=10/K=25, and the merged SBX-44 implementation. No big benchmark was run.

PASS: focused Daytona snapshot-check cleanup completed at 2026-10-19T18:36:00Z. Native recovery waited for the source to disappear, then deleted one late snapshot. A subsequent scoped reap returned zero leftovers on all eight providers; exact-source snapshot queries returned zero for both timed-out Daytona sources. The ownership journals are empty. Final local snapshot verification in `bench/results/local-final/` passed all nine observations with distinct source/restored IDs, populated fingerprints and zero leftovers.

The late Daytona snapshot is now covered by a durable `snapshot-source` marker and an offline regression: a snapshot that appears after its first deletion is removed after the source VM disappears. The final independent cleanup review found an early marker-removal case when deletion failed and listing omitted the source. Reap now retains the marker whenever deletion errors or a journaled source VM remain. Source-ownership markers contain only IDs created by this run; no account-wide snapshot cleanup is used.
