#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly TOOLS_ROOT="$REPO_ROOT/.tools/security"
readonly BIN_DIR="$TOOLS_ROOT/bin"
readonly DOWNLOAD_DIR="$TOOLS_ROOT/downloads"
readonly SEMGREP_CONSTRAINTS="$REPO_ROOT/security/semgrep-constraints.txt"

readonly GITLEAKS_VERSION="8.30.1"
readonly OSV_SCANNER_VERSION="2.4.0"
readonly SEMGREP_VERSION="1.177.0"

die() {
  printf 'security tool setup: %s\n' "$1" >&2
  exit 2
}

download_verified() {
  local url="$1"
  local destination="$2"
  local expected_sha256="$3"
  local temporary="$destination.download"

  curl --fail --location --silent --show-error "$url" --output "$temporary"
  printf '%s  %s\n' "$expected_sha256" "$temporary" | sha256sum --check --status || {
    rm -f -- "$temporary"
    die "checksum verification failed for $url"
  }
  mv -- "$temporary" "$destination"
}

install_gitleaks() {
  local machine="$1"
  local asset sha256
  case "$machine" in
    x86_64)
      asset="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
      sha256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
      ;;
    aarch64|arm64)
      asset="gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz"
      sha256="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
      ;;
    *) die "unsupported Linux architecture for Gitleaks: $machine" ;;
  esac

  local archive="$DOWNLOAD_DIR/$asset"
  download_verified \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/$asset" \
    "$archive" \
    "$sha256"
  tar -xzf "$archive" -C "$BIN_DIR" gitleaks
  chmod 0755 "$BIN_DIR/gitleaks"
  "$BIN_DIR/gitleaks" version | grep -Fq "$GITLEAKS_VERSION" || die "Gitleaks version verification failed"
}

install_osv_scanner() {
  local machine="$1"
  local asset sha256
  case "$machine" in
    x86_64)
      asset="osv-scanner_linux_amd64"
      sha256="15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0"
      ;;
    aarch64|arm64)
      asset="osv-scanner_linux_arm64"
      sha256="44e580752910f0ff36ec99aff59af20f65df1e859aa31e5605a8f0d055b496e9"
      ;;
    *) die "unsupported Linux architecture for OSV-Scanner: $machine" ;;
  esac

  download_verified \
    "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/$asset" \
    "$BIN_DIR/osv-scanner" \
    "$sha256"
  chmod 0755 "$BIN_DIR/osv-scanner"
  "$BIN_DIR/osv-scanner" --version | grep -Fq "osv-scanner version: $OSV_SCANNER_VERSION" || die "OSV-Scanner version verification failed"
}

install_semgrep() {
  local machine="$1"
  local venv="$TOOLS_ROOT/semgrep-venv"
  local wheel sha256
  case "$machine" in
    x86_64)
      wheel="semgrep-${SEMGREP_VERSION}-cp310.cp311.cp312.cp313.cp314.py310.py311.py312.py313.py314-none-manylinux_2_34_x86_64.whl"
      sha256="32d92d0cd2e18a1495b32abfef926be0ed3c972d8cd169bffe6cbb8418e3bb5e"
      ;;
    aarch64|arm64)
      wheel="semgrep-${SEMGREP_VERSION}-cp310.cp311.cp312.cp313.cp314.py310.py311.py312.py313.py314-none-manylinux_2_34_aarch64.whl"
      sha256="f27725632d468fb1a0d740ce5a98e406376a88de91fc6f902fb9fb3b1d6ed4d9"
      ;;
    *) die "unsupported Linux architecture for Semgrep: $machine" ;;
  esac

  python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || \
    die "Semgrep requires Python 3.10 or newer"
  python3 -m venv "$venv"
  PIP_CACHE_DIR="$TOOLS_ROOT/pip-cache" "$venv/bin/python" -m pip download \
    --disable-pip-version-check \
    --no-deps \
    --only-binary=:all: \
    --dest "$DOWNLOAD_DIR" \
    "semgrep==$SEMGREP_VERSION"
  printf '%s  %s\n' "$sha256" "$DOWNLOAD_DIR/$wheel" | sha256sum --check --status || \
    die "checksum verification failed for the Semgrep wheel"
  PIP_CACHE_DIR="$TOOLS_ROOT/pip-cache" "$venv/bin/python" -m pip install \
    --disable-pip-version-check \
    --no-input \
    --constraint "$SEMGREP_CONSTRAINTS" \
    "$DOWNLOAD_DIR/$wheel"
  "$venv/bin/semgrep" --version | grep -Fxq "$SEMGREP_VERSION" || die "Semgrep version verification failed"
  ln -sfn -- "../semgrep-venv/bin/semgrep" "$BIN_DIR/semgrep"
}

[[ "$(uname -s)" == "Linux" ]] || die "the pinned binary setup currently supports Linux only"
command -v curl >/dev/null || die "curl is required"
command -v sha256sum >/dev/null || die "sha256sum is required"
command -v tar >/dev/null || die "tar is required"
command -v python3 >/dev/null || die "python3 is required"

mkdir -p -- "$BIN_DIR" "$DOWNLOAD_DIR"
install_gitleaks "$(uname -m)"
install_osv_scanner "$(uname -m)"
install_semgrep "$(uname -m)"

printf 'Installed Gitleaks %s, OSV-Scanner %s, and Semgrep %s under %s\n' \
  "$GITLEAKS_VERSION" "$OSV_SCANNER_VERSION" "$SEMGREP_VERSION" "$TOOLS_ROOT"
