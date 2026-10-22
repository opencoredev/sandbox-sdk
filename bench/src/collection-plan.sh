#!/usr/bin/env bash
# Run this script by path from any working directory. Recommendations only; no collection runs without an explicit mode.
# Pin BENCH_COLLECTION_COMMIT after ALL adapter merges and checks, then use that same SDK/harness
# commit for every suite, window and track. Load credentials privately before invoking this script.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# The fallback also supports the orchestration copy in /tmp/swarm when called from this repo.
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel)
cd -- "$repo_root"
results_root="$repo_root/bench/results"
export DAYTONA_TARGET=us
mode=${1:-help}
dry=${BENCH_PLAN_DRY_RUN:-0}
if [[ $dry != 1 && $mode != help && $mode != policy ]]; then
  : "${BENCH_COLLECTION_COMMIT:?Set the final verified SDK/harness commit before collecting}"
  [[ $(git rev-parse HEAD) == "$BENCH_COLLECTION_COMMIT" ]] || { echo 'Checkout differs from pinned collection commit' >&2; exit 1; }
  git diff --quiet HEAD -- bench/src packages/sdk/src || { echo 'Collection code has uncommitted changes' >&2; exit 1; }
fi
main=command,files-1kb,files-10mb,reconnect,pause-resume,perf,git-clone,npm-install,dev-server,preview-first-byte,edit-loop,tool-replay,pip-install
lifecycle=command,files-1kb,files-10mb,reconnect,pause-resume,perf
account_limits=e2b=25,daytona=10,upstash=25,boat=10,boxd=50,freestyle=25,tenki=25,superserve=25
# Verified publication K25 cohorts; boxd used cap50. These are collection caps, not inferred plan maxima.
base=(--account-limits "$account_limits" --omit-network-download true --concurrency 4 --provider-concurrency 1 --seed 45 --max-dollars 25)
default_flags=(--track default --template e2b=base --template superserve=sandbox-bench-node22-py311-1x1-pinned)
spec_flags=(--track same-spec --template e2b=r1h7gud12rf1f6iu29r0 --template daytona=daytona-large --size upstash=medium --size boxd=4:16384 --size tenki=4:8192)
# E2B template alias: sandbox-bench-same-spec. Boat/Freestyle use defaults.
# Superserve is deliberately EXCLUDED from same-spec: account cap is 2 vCPU; no 4-vCPU template.
run() {
  if [[ $dry == 1 ]]; then printf '%q ' "$@"; printf '\n'; else "$@"; fi
}
wait_batch() {
  # Ten starts per batch, then >=65 seconds AFTER completion before any further starts.
  if [[ $dry == 1 ]]; then echo 'WAIT_SECONDS 65'; else sleep 65; fi
}
non_boat() {
  local track=$1 providers snapshot_providers burst_providers run_prefix
  local -a flags
  if [[ $track == default ]]; then
    providers=e2b,daytona,upstash,boxd,freestyle,tenki,superserve
    flags=("${default_flags[@]}")
  else
    providers=e2b,daytona,upstash,boxd,freestyle,tenki
    flags=("${spec_flags[@]}")
  fi
  snapshot_providers=$providers
  burst_providers=${providers//daytona,/}
  if [[ $track == same-spec ]]; then snapshot_providers=${providers//daytona,/}; fi
  run_prefix=sbx53-${track}
  run bun bench --providers "$providers" "${flags[@]}" "${base[@]}" --runs 100 --workload-runs 30 --scenarios "$main" --bursts '' --timeout-ms 180000 --max-sandboxes 110 --run "${run_prefix}-main" --out "$results_root/${run_prefix}-main"
  run bun bench --providers "$snapshot_providers" "${flags[@]}" "${base[@]}" --runs 30 --scenarios snapshot --bursts '' --timeout-ms 600000 --max-sandboxes 70 --run "${run_prefix}-snapshot" --out "$results_root/${run_prefix}-snapshot"
  run bun bench --providers "$providers" "${flags[@]}" "${base[@]}" --cost-runs 10 --scenarios cost --bursts '' --timeout-ms 180000 --max-sandboxes 10 --run "${run_prefix}-cost" --out "$results_root/${run_prefix}-cost"
  run bun bench billing --report "$results_root/${run_prefix}-cost"
  # Do not raise account caps simply to fill a table. Inspect skip notes and document actual limits.
  run bun bench --providers "$burst_providers" "${flags[@]}" --account-limits "$account_limits" --omit-network-download true --runs 1 --scenarios burst --bursts 10,25 --burst-cohorts 3 --concurrency 25 --seed 45 --timeout-ms 180000 --max-sandboxes 110 --max-dollars 25 --run "${run_prefix}-burst" --out "$results_root/${run_prefix}-burst"
  # An otherwise idle Daytona us/container account fits exactly ten default 1/1/3 machines.
  if [[ $track == default ]]; then
    run bun bench --providers daytona --track default --omit-network-download true --runs 1 --scenarios burst --bursts 10 --burst-cohorts 3 --concurrency 10 --provider-concurrency 1 --seed 45 --timeout-ms 180000 --max-sandboxes 40 --max-dollars 25 --account-limits daytona=10 --run "${run_prefix}-daytona-burst" --out "$results_root/${run_prefix}-daytona-burst"
  fi
}
boat_batch() {
  local track=$1 suite=$2 batch=$3 scenarios=$main run_id=sbx53-${1}-boat-${2}-${3}
  local -a args=(--providers boat --track "$track" "${base[@]}" --runs 10 --workload-runs 10 --bursts '' --timeout-ms 180000 --max-sandboxes 25)
  if [[ $suite == main && $batch -gt 3 ]]; then scenarios=$lifecycle; fi
  if [[ $suite == snapshot ]]; then scenarios=snapshot; args+=(--timeout-ms 600000); fi
  if [[ $suite == cost ]]; then scenarios=cost; args+=(--cost-runs 10 --provider-concurrency 1); fi
  if [[ $suite == burst ]]; then scenarios=burst; args+=(--runs 1 --bursts 10 --burst-cohorts 1 --concurrency 10); fi
  run bun bench "${args[@]}" --scenarios "$scenarios" --run "$run_id" --out "$results_root/$run_id"
  if [[ $suite == cost ]]; then run bun bench billing --report "$results_root/$run_id"; fi
  wait_batch
}
boat_window() {
  local track=$1 window=$2 batch
  case $window in
    0) for batch in 1 2 3 4 5 6; do boat_batch "$track" main "$batch"; done ;;
    1) for batch in 7 8 9 10; do boat_batch "$track" main "$batch"; done
       for batch in 1 2; do boat_batch "$track" snapshot "$batch"; done ;;
    2) boat_batch "$track" snapshot 3
       for batch in 1 2 3; do boat_batch "$track" burst "$batch"; done
       boat_batch "$track" cost 1 ;;
  esac
}
case $mode in
  default-nonboat) non_boat default ;;
  same-spec-nonboat) non_boat same-spec ;;
  boat-default-0) boat_window default 0 ;;
  boat-default-1) boat_window default 1 ;;
  boat-default-2) boat_window default 2 ;;
  boat-same-spec-0) boat_window same-spec 0 ;;
  boat-same-spec-1) boat_window same-spec 1 ;;
  boat-same-spec-2) boat_window same-spec 2 ;;
  policy) run bun -e 'import {collectionPolicy} from "./bench/src/collection-policy.ts"; console.log(JSON.stringify(collectionPolicy(), null, 2))' ;;
  help) cat <<'HELP'
Results and ownership.json journals are under REPOSITORY/bench/results/RUN_ID.
Non-Boat: run default-nonboat and same-spec-nonboat after pinning the final commit.
Boat requires an otherwise idle account (12 starts/minute, 60/hour, 200/day):
 Day 1: boat-default-0 (60 starts), then boat-default-1 (60), then boat-default-2 (50).
 Leave >=65 minutes AFTER the last creation of one window before starting the next window.
 Day 2: no earlier than 26 hours AFTER Day 1's final creation, run boat-same-spec-0/1/2,
 with the same >=65-minute gaps. Each track uses 170 starts, including 30 cold snapshot-suite
 probes that record unsupported snapshot capability, plus 10 sequential cost tasks paced 6.5 seconds apart.
 First 30 main iterations include workloads. Cost billing is collected immediately; repeat after settlement.
 Never run Boat K=25 on the current plan: 25 simultaneous creates violate 12 starts/minute.
 Record it as notRun, not a failed provider latency. K=10 uses three separate one-cohort commands.
 Daytona us/container quota: CPU 10 vCPU / memory 10 GiB / disk 30 GiB.
 One same-spec daytona-large (4/8/10) fits; source + restore need 8/16/20, so that suite is excluded.
 Same-spec Daytona K10/K25 and default K25 are excluded and recorded in policy.
 Default Daytona K10 remains enabled separately: exactly 10 vCPU / 10 GiB / 30 GiB; account must be idle.
 Superserve is excluded from same-spec until a 4-vCPU template is available (account capped at 2).
 Generate policy with `bash bench/src/collection-plan.sh policy > /tmp/swarm/collection-policy.json`.
 Other account-cap skips require verified reasons in that policy. All 27 site metric IDs are
 covered across main, snapshot and burst suites; provider capability/quota exceptions stay explicit.
 Preview commands without credentials, sleeps or cloud calls: BENCH_PLAN_DRY_RUN=1 bash SCRIPT MODE.
HELP
    ;;
  *) echo "Unknown mode: $mode" >&2; exit 2 ;;
esac
