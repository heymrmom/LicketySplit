#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_dir="${TAKEOVER_HOUR_FIXTURE:-$repo_root/.superpowers/work/takeover/verification/full-hour-20261009}"
pnpm_wrapper="$repo_root/.superpowers/work/takeover/toolchain/pnpm22"
test_file="src/main/lickety/podcast/verification/full-hour-benchmark.test.ts"

if [[ -n "${TAKEOVER_PNPM:-}" ]]; then
  pnpm_command="$TAKEOVER_PNPM"
elif command -v pnpm >/dev/null 2>&1; then
  pnpm_command="$(command -v pnpm)"
elif [[ -x "$pnpm_wrapper" ]]; then
  pnpm_command="$pnpm_wrapper"
else
  printf 'pnpm was not found. Set TAKEOVER_PNPM to a pnpm executable (Node 22 is required).\n' >&2
  exit 2
fi

node_version="$("$pnpm_command" --filter @licketysplit/desktop exec node --version)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
if [[ "$node_major" != "22" ]]; then
  printf 'This benchmark requires Node 22; %s was selected. Set TAKEOVER_PNPM to a pnpm executable using Node 22.\n' "$node_version" >&2
  exit 2
fi

run_mode() {
  local mode="$1"
  printf 'Running %s\n' "$mode"
  TAKEOVER_HOUR_FIXTURE="$fixture_dir" \
  TAKEOVER_HOUR_FFMPEG="$repo_root/apps/desktop/resources/bin/darwin-arm64/ffmpeg" \
  TAKEOVER_HOUR_MODE="$mode" \
    "$pnpm_command" --filter @licketysplit/desktop exec vitest run "$test_file" --reporter=verbose
}

run_mode native-cold
run_mode native-corrected
run_mode native-warm
run_mode compact-cold
run_mode compact-warm

printf 'Evidence: %s/benchmark\n' "$fixture_dir"
