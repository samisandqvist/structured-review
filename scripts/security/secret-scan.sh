#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly GITLEAKS="$REPO_ROOT/.tools/security/bin/gitleaks"
readonly TARGET="${1:-$REPO_ROOT}"
readonly REPORT="$(mktemp)"
trap 'rm -f -- "$REPORT"' EXIT

[[ -x "$GITLEAKS" ]] || {
  printf 'secret scan unavailable: run scripts/security/setup-tools.sh\n' >&2
  exit 2
}

set +e
"$GITLEAKS" dir "$TARGET" \
  --config "$REPO_ROOT/security/gitleaks.toml" \
  --redact=100 \
  --no-banner \
  --report-format json \
  --report-path "$REPORT" \
  --exit-code 1 >/dev/null 2>&1
status=$?
set -e

if [[ $status -gt 1 ]]; then
  printf 'secret scan failed: Gitleaks exited %s\n' "$status" >&2
  exit 2
fi

set +e
node "$SCRIPT_DIR/report.mjs" gitleaks "$REPORT"
report_status=$?
set -e
[[ $report_status -le 1 ]] || exit 2
[[ $report_status -eq $status ]] || {
  printf 'secret scan failed: scanner and report statuses disagree\n' >&2
  exit 2
}
exit "$report_status"
