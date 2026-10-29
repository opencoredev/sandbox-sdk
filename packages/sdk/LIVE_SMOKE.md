# Live smoke

`scripts/live-smoke.ts` creates one small sandbox per provider and checks the basics against the real service. For each provider it:

1. creates a sandbox labelled `smoke-run=<run id>`, unique per run,
2. runs `echo ok` and checks stdout,
3. writes a file and reads it back,
4. streams a two-line command and checks the chunks and the final result,
5. asks for a preview URL on port 3000 (no HTTP probe, so it stays cheap),
6. destroys the sandbox in a `finally`.

Each provider gets a 120 s budget, and at most 4 run at once. After every provider finishes, the script lists sandboxes carrying the run label through both `listSandboxes` and the adapter's native `provider.list`. If any remain, it calls `reapSandboxes`, polls until the list is empty, and exits non-zero when something is still left.

## Results, 2026-10-28

Run `sbx69-mvss0ti7-c137fe1c` on branch `v1-polish` after the Sandboxer, packaging and docs merges, from ms-a2. Times are wall-clock from the client, so they include network latency and lazy imports on first use. ms-a2 had a load average above 100 during the run.

| Provider | Result | Create ms | First run ms | Note |
| --- | --- | ---: | ---: | --- |
| memory | PASS | 170 | 3 | In-process. Preview URL is synthetic. |
| local (Docker) | PASS | 642 | 88 | |
| agentOS | PASS | 1298 | 945 | Embedded VM. Has no preview URLs, so the adapter reports `unsupported` as designed. |
| E2B | PASS | 713 | 234 | |
| Daytona | PASS | 1411 | 416 | |
| Upstash Box | PASS | 4363 | 168 | |
| Boat | PASS | 1193 | 364 | |
| Tenki | PASS | 491 | 435 | |
| boxd | PASS | 2132 | 263 | |
| Freestyle | PASS | 494 | 243 | |
| Superserve | PASS | 313 | 211 | Uses template `sandbox-bench-node22-py311-1x1-pinned`. The default `superserve/node-22` has no python3 and fails with `unsupported`. |
| Sandboxer | PASS | 360 | 217 | Default region (nearest to the caller). |
| Vercel | SKIP | - | - | The only token on the server (`VERCEL_OIDC_TOKEN`) expired on 2026-10-22. |
| Railway | SKIP | - | - | No `RAILWAY_API_TOKEN` or `RAILWAY_ENVIRONMENT_ID` on the server. |

Leak check: 0 sandboxes left on every provider. After the run, `listSandboxes` and the adapter's native `provider.list` both returned 0 for the run label on every provider, so nothing needed reaping. An earlier run the same day (`sbx69-mvsr6nqw-fb574ffa`, before the Sandboxer merge) also passed with 0 left. That run was confirmed separately by a sweep of each cloud account for `smoke-run=sbx69-*`, `not_found` on reconnect to every destroyed ID, and `docker ps -a`.

### Adapter bug found

On the first run, Superserve failed with `outcome_unknown: Process cancellation could not be confirmed`. The template had no python3, so the bootstrap rejected the command before anything started. `execute()` then tried to cancel the command, the cancel hit the same bootstrap failure, and the useful `unsupported` error (which tells you to set `installPython`) was lost. Commit `1a13dba` rethrows `unsupported` without cancelling, and `tests/superserve.test.ts` covers it.

## Rerun

From `packages/sdk`, load the keys into the environment without printing them, then run the script:

```sh
for k in E2B_API_KEY DAYTONA_API_KEY UPSTASH_BOX_API_KEY BOXD_API_KEY BOXD_ORG FREESTYLE_API_KEY TENKI_API_KEY SUPERSERVE_API_KEY BOAT_API_KEY SANDBOXER_API_KEY; do
  export "$k=$(cat ~/.config/sandbox-bench/$k)"
done
export SANDBOX_SUPERSERVE_TEMPLATE=sandbox-bench-node22-py311-1x1-pinned
timeout --kill-after=60s 600 bun scripts/live-smoke.ts --json /tmp/live-smoke.json
```

Without `--providers`, the script runs every registered provider whose credentials are set and lists the rest as SKIP. To run only some, pass `--providers e2b,daytona`. Other flags are `--concurrency` (capped at 4), `--timeout-ms` (default 120000), and `--json` for raw results. The script exits 1 if a provider fails or anything is left behind.

## Adding a provider

Add one entry to `registry` in `scripts/live-smoke.ts`. Give it the environment variables it needs and a lazy import of its factory, like the existing `sandboxer` entry. Add its key to the `for k in ...` loop and rerun with `--providers <name>`. If the provider only previews ports declared at creation, as Vercel and Railway do, add `ports: [3000]`.
