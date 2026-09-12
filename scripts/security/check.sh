#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for script in "$SCRIPT_DIR"/*.sh; do bash -n "$script"; done

"$SCRIPT_DIR/secret-scan.sh"
"$SCRIPT_DIR/sast-scan.sh"
"$SCRIPT_DIR/dependency-scan.sh"
