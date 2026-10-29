# Live smoke

`scripts/live-smoke.ts` creates one small sandbox per provider and checks the basics against the real service. For each provider it:

1. creates a sandbox labelled `smoke-run=<run id>`, unique per run,
2. runs `echo ok` and checks stdout,
3. writes a file and reads it back,
4. streams a two-line command and checks the chunks and the final result,
5. asks for a preview URL on port 3000 (no HTTP probe, so it stays cheap),
6. destroys the sandbox in a `finally`.

Each provider gets a 120 s budget, and at most 4 run at once. After every provider finishes, the script lists sandboxes carrying the run label through both `listSandboxes` and the adapter's native `provider.list`. If any remain, it calls `reapSandboxes`, polls until the list is empty, and exits non-zero when something is still left.

## Results, 2026-10-29

Run `sbx69-mvu55r9k-a3a2ab1f` on the SBX-75 branch (1.0.0-beta.1 after the lint and slop cleanup), from ms-a2. Every registered provider ran; none was skipped. Times are wall-clock from the client, so they include network latency and lazy imports on first use. ms-a2 had a load average around 90 during the run.

| Provider       | Result | Create ms | First run ms | Note                                                                                                                                 |
| -------------- | ------ | --------: | -----------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| memory         | PASS   |        41 |            2 | In-process. Preview URL is synthetic.                                                                                                |
| local (Docker) | PASS   |       841 |          110 |                                                                                                                                      |
| agentOS        | PASS   |      2090 |         1346 | Embedded VM. Has no preview URLs, so the adapter reports `unsupported` as designed.                                                  |
| E2B            | PASS   |       586 |          253 |                                                                                                                                      |
| Daytona        | PASS   |      1676 |          331 |                                                                                                                                      |
| Upstash Box    | PASS   |      2306 |          142 |                                                                                                                                      |
| Boat           | PASS   |       783 |          399 |                                                                                                                                      |
| Tenki          | PASS   |       490 |          305 |                                                                                                                                      |
| boxd           | PASS   |      2099 |          262 |                                                                                                                                      |
| Freestyle      | PASS   |      1129 |          184 |                                                                                                                                      |
| Superserve     | PASS   |       197 |          228 | Uses template `sandbox-bench-node22-py311-1x1-pinned`. The default `superserve/node-22` has no python3 and fails with `unsupported`. |
| Sandboxer      | PASS   |       238 |          353 | Default region (nearest to the caller).                                                                                              |
| Vercel         | PASS   |       451 |          441 | OIDC token pulled fresh with `vercel env pull` from the `sandbox-sdk-v2` project.                                                    |
| Railway        | PASS   |      5260 |          673 | A dedicated `sandbox-sdk-live-smoke` project. The live conformance suite also runs; see below.                                       |

Leak check: 0 sandboxes left on every provider. After the run, `listSandboxes` and the adapter's native `provider.list` both returned 0 for the run label, so nothing needed reaping. `docker ps -a --filter label=sandbox-sdk=1` was empty.

### Adapter bugs found

The Railway live conformance suite (`tests/railway.live.test.ts`) found that connecting to a destroyed Railway sandbox failed with `outcome_unknown` instead of `not_found`. Railway keeps destroyed VMs, so `Sandbox.connect` still returns them with status `DESTROYED`, and reading the marker then fails as a lost connection. The adapter now checks the status first. The mock keeps destroyed VMs the same way, so the conformance check fails without the fix. Railway's sandbox API is marked experimental: each full live suite run loses one to three different tests to dropped connections (`outcome_unknown`), and each of those passes on rerun.

On the first run, Superserve failed with `outcome_unknown: Process cancellation could not be confirmed`. The template had no python3, so the bootstrap rejected the command before anything started. `execute()` then tried to cancel the command, the cancel hit the same bootstrap failure, and the useful `unsupported` error (which tells you to set `installPython`) was lost. Commit `1a13dba` rethrows `unsupported` without cancelling, and `tests/superserve.test.ts` covers it.

## Rerun

From `packages/sdk`, load the keys into the environment without printing them, then run the script:

```sh
for k in E2B_API_KEY DAYTONA_API_KEY UPSTASH_BOX_API_KEY BOXD_API_KEY BOXD_ORG FREESTYLE_API_KEY TENKI_API_KEY SUPERSERVE_API_KEY BOAT_API_KEY SANDBOXER_API_KEY; do
  export "$k=$(cat ~/.config/sandbox-bench/$k)"
done
export SANDBOX_SUPERSERVE_TEMPLATE=sandbox-bench-node22-py311-1x1-pinned
# Railway: any token with access to the sandbox-sdk-live-smoke project, plus its production environment.
export RAILWAY_API_TOKEN=... RAILWAY_ENVIRONMENT_ID=...
timeout --kill-after=60s 600 bun scripts/live-smoke.ts --json /tmp/live-smoke.json
```

Without `--providers`, the script runs every registered provider whose credentials are set and lists the rest as SKIP. To run only some, pass `--providers e2b,daytona`. Other flags are `--concurrency` (capped at 4), `--timeout-ms` (default 120000), and `--json` for raw results. The script exits 1 if a provider fails or anything is left behind.

## Adding a provider

Add one entry to `registry` in `scripts/live-smoke.ts`. Give it the environment variables it needs and a lazy import of its factory, like the existing `sandboxer` entry. Add its key to the `for k in ...` loop and rerun with `--providers <name>`. If the provider only previews ports declared at creation, as Vercel and Railway do, add `ports: [3000]`.
