#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly OSV_SCANNER="$REPO_ROOT/.tools/security/bin/osv-scanner"
readonly DATABASE_ROOT="$REPO_ROOT/.tools/security/osv-db"
readonly FRESHNESS_FILE="$DATABASE_ROOT/UPDATED_AT"
readonly MAX_AGE_SECONDS="${OSV_DATABASE_MAX_AGE_SECONDS:-604800}"
readonly REPORT="$(mktemp)"
readonly SCANNER_LOG="$(mktemp)"
trap 'rm -f -- "$REPORT" "$SCANNER_LOG"' EXIT

[[ -x "$OSV_SCANNER" ]] || {
  printf 'dependency scan unavailable: run scripts/security/setup-tools.sh\n' >&2
  exit 2
}
[[ -f "$REPO_ROOT/pnpm-lock.yaml" ]] || {
  printf 'dependency scan failed: pnpm-lock.yaml is missing\n' >&2
  exit 2
}
[[ -f "$FRESHNESS_FILE" ]] || {
  printf 'dependency scan unavailable: run scripts/security/update-advisories.sh\n' >&2
  exit 2
}

set +e
node "$SCRIPT_DIR/report.mjs" freshness "$FRESHNESS_FILE" "$MAX_AGE_SECONDS"
freshness_status=$?
set -e
if [[ $freshness_status -eq 2 ]]; then
  printf 'dependency scan failed: invalid advisory freshness metadata or policy\n' >&2
  exit 2
elif [[ $freshness_status -eq 3 ]]; then
  printf 'dependency scan unavailable: advisory data is stale; run scripts/security/update-advisories.sh\n' >&2
  exit 2
fi

set +e
OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY="$DATABASE_ROOT" \
  "$OSV_SCANNER" scan source \
    --offline \
    --lockfile="$REPO_ROOT/pnpm-lock.yaml" \
    --format=json >"$REPORT" 2>"$SCANNER_LOG"
status=$?
set -e

if [[ $status -gt 1 ]]; then
  printf 'dependency scan failed: OSV-Scanner exited %s\n' "$status" >&2
  sed -n '1,20p' "$SCANNER_LOG" >&2
  exit 2
fi

node "$SCRIPT_DIR/report.mjs" osv "$REPORT" 7
