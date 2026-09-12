#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly OSV_SCANNER="$REPO_ROOT/.tools/security/bin/osv-scanner"
readonly DATABASE_ROOT="$REPO_ROOT/.tools/security/osv-db"
readonly REPORT="$(mktemp)"
trap 'rm -f -- "$REPORT"' EXIT

[[ -x "$OSV_SCANNER" ]] || {
  printf 'advisory update unavailable: run scripts/security/setup-tools.sh\n' >&2
  exit 2
}
[[ -f "$REPO_ROOT/pnpm-lock.yaml" ]] || {
  printf 'advisory update failed: pnpm-lock.yaml is missing\n' >&2
  exit 2
}

mkdir -p -- "$DATABASE_ROOT"
set +e
OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY="$DATABASE_ROOT" \
  "$OSV_SCANNER" scan source \
    --offline \
    --download-offline-databases \
    --lockfile="$REPO_ROOT/pnpm-lock.yaml" \
    --format=json >"$REPORT"
status=$?
set -e

if [[ $status -gt 1 ]]; then
  printf 'advisory update failed: OSV-Scanner exited %s\n' "$status" >&2
  exit 2
fi

date -u +%Y-%m-%dT%H:%M:%SZ >"$DATABASE_ROOT/UPDATED_AT"
printf 'advisory database updated; dependency metadata was matched locally\n'
