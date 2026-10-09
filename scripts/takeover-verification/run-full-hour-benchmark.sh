#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_dir="${TAKEOVER_HOUR_FIXTURE:-$repo_root/.superpowers/work/takeover/verification/full-hour-20261009}"
pnpm_wrapper="$repo_root/.superpowers/work/takeover/toolchain/pnpm22"
test_file="src/main/lickety/podcast/verification/full-hour-benchmark.test.ts"

run_mode() {
  local mode="$1"
  printf 'Running %s\n' "$mode"
  TAKEOVER_HOUR_FIXTURE="$fixture_dir" \
  TAKEOVER_HOUR_FFMPEG="$repo_root/apps/desktop/resources/bin/darwin-arm64/ffmpeg" \
  TAKEOVER_HOUR_MODE="$mode" \
    "$pnpm_wrapper" --filter @openreel/desktop exec vitest run "$test_file" --reporter=verbose
}

run_mode native-cold
run_mode native-corrected
run_mode native-warm
run_mode compact-cold
run_mode compact-warm

printf 'Evidence: %s/benchmark\n' "$fixture_dir"
