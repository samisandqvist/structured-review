#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$FIXTURE_ROOT"' EXIT

fake_secret="$(printf 'crw-security-negative-probe' | sha256sum)"
fake_secret="${fake_secret%% *}"
printf 'const apiKey = "%s";\n' "$fake_secret" >"$FIXTURE_ROOT/secret.ts"

set +e
secret_output="$($SCRIPT_DIR/secret-scan.sh "$FIXTURE_ROOT" 2>&1)"
secret_status=$?
set -e
[[ $secret_status -eq 1 ]] || {
  printf 'security probe failed: secret fixture exited %s instead of 1\n' "$secret_status" >&2
  exit 1
}
if [[ "$secret_output" == *"$fake_secret"* ]]; then
  printf 'security probe failed: secret value appeared in scanner output\n' >&2
  exit 1
fi

printf 'export function unsafe(value: string) { return eval(value); }\n' >"$FIXTURE_ROOT/dangerous.ts"
set +e
"$SCRIPT_DIR/sast-scan.sh" "$FIXTURE_ROOT" >/dev/null 2>&1
sast_status=$?
set -e
[[ $sast_status -eq 1 ]] || {
  printf 'security probe failed: dangerous-code fixture exited %s instead of 1\n' "$sast_status" >&2
  exit 1
}

printf 'security negative probes: secret and dangerous-code fixtures were rejected; secret output stayed redacted\n'
