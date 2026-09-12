#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly SEMGREP="$REPO_ROOT/.tools/security/bin/semgrep"
if [[ $# -gt 0 ]]; then
  TARGETS=("$1")
else
  TARGETS=("$REPO_ROOT/packages" "$REPO_ROOT/scripts")
fi

[[ -x "$SEMGREP" ]] || {
  printf 'SAST scan unavailable: run scripts/security/setup-tools.sh\n' >&2
  exit 2
}

mkdir -p -- "$REPO_ROOT/.tools/security/cache"

SEMGREP_SEND_METRICS=off \
SEMGREP_SETTINGS_FILE="$REPO_ROOT/.tools/security/semgrep-settings.yml" \
SEMGREP_LOG_FILE="$REPO_ROOT/.tools/security/semgrep.log" \
XDG_CACHE_HOME="$REPO_ROOT/.tools/security/cache" \
  "$SEMGREP" scan \
  --config "$REPO_ROOT/security/semgrep.yml" \
  --metrics off \
  --error \
  --disable-version-check \
  --no-rewrite-rule-ids \
  --no-git-ignore \
  --exclude node_modules \
  --exclude dist \
  --exclude coverage \
  "${TARGETS[@]}"
