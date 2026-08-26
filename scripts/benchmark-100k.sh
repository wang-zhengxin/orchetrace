#!/usr/bin/env bash
set -euo pipefail

workspace_dir=$(cd "$(dirname "$0")/.." && pwd)
event_count=${ORCHETRACE_BENCH_EVENTS:-100000}
run_count=${ORCHETRACE_BENCH_RUNS:-100}
agents_per_run=${ORCHETRACE_BENCH_AGENTS_PER_RUN:-10}

cd "$workspace_dir"
cargo build --release -p orchetrace-cli --bin otrace-bench --offline

benchmark=(
  target/release/otrace-bench
  --events "$event_count"
  --runs "$run_count"
  --agents-per-run "$agents_per_run"
  "$@"
)

case "$(uname -s)" in
  Darwin) exec /usr/bin/time -l "${benchmark[@]}" ;;
  Linux) exec /usr/bin/time -v "${benchmark[@]}" ;;
  *) exec "${benchmark[@]}" ;;
esac
