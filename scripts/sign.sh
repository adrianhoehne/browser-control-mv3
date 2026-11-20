#!/usr/bin/env bash
# Signs the extension for self-distribution (AMO, channel `unlisted`, spec 46).
#
# The keys never live in the repository. They are read from one file outside the
# tree, `~/.config/browser-control/amo.env`, and only the *names* of the variables
# appear here — a value in this file would be a leak the secret grep would catch.
#
# Usage: scripts/sign.sh [--dry-run]
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CREDENTIALS="${BC_AMO_ENV:-$HOME/.config/browser-control/amo.env}"
ARTIFACTS_DIR="$REPO_ROOT/dist/signed"

usage() {
  cat <<'EOF'
usage: scripts/sign.sh [--dry-run]

Signs extension/ for self-distribution and writes the signed XPI to
dist/signed/. The API credentials are read from
~/.config/browser-control/amo.env (AMO_JWT_ISSUER, AMO_JWT_SECRET).

  --dry-run   build the unsigned XPI and stop before contacting AMO
  --help      this text
EOF
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

dry_run=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

# The credentials first: a missing file is the likeliest failure, and it must be
# named by its path — "AMO_JWT_ISSUER is not set" would send the operator looking
# in the wrong place.
[[ -f "$CREDENTIALS" ]] || fail "no API credentials at $CREDENTIALS (AMO_JWT_ISSUER, AMO_JWT_SECRET)"
# shellcheck disable=SC1090
set -a
. "$CREDENTIALS"
set +a

[[ -n "${AMO_JWT_ISSUER:-}" ]] || fail "AMO_JWT_ISSUER is empty in $CREDENTIALS"
[[ -n "${AMO_JWT_SECRET:-}" ]] || fail "AMO_JWT_SECRET is empty in $CREDENTIALS"

command -v zip >/dev/null 2>&1 || fail "zip is missing"

# The unsigned artifact first: `web-ext` gets a directory, but the same build has
# to be the one the release job produces, or the signed XPI would be a different
# extension than the one that was tested.
"$REPO_ROOT/scripts/package.sh" >/dev/null
version="$(node -p "require(\"$REPO_ROOT/extension/manifest.json\").version")"
printf 'built   dist/browser-control-%s.xpi (unsigned)\n' "$version"

if [[ "$dry_run" == true ]]; then
  printf 'dry run — AMO was not contacted\n'
  exit 0
fi

mkdir -p "$ARTIFACTS_DIR"
printf 'signing version %s for channel unlisted\n' "$version"
npx --yes web-ext sign \
  --channel=unlisted \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET" \
  --source-dir "$REPO_ROOT/extension" \
  --artifacts-dir "$ARTIFACTS_DIR"

# AMO names the file after its own submission (`<hash>-<version>.xpi`). That hash is
# an upload id, not part of the signature: the COSE signature sits inside the
# package and covers its content, so renaming it keeps it valid (measured
# 2026-11-20, `scripts/verify-signature.sh` after a rename). A stable name is what a
# downloader expects.
for produced in "$ARTIFACTS_DIR"/*-"$version".xpi; do
  [[ -e "$produced" ]] || continue
  [[ "$(basename "$produced")" == "browser-control-$version.xpi" ]] && continue
  mv "$produced" "$ARTIFACTS_DIR/browser-control-$version.xpi"
  printf 'renamed %s -> browser-control-%s.xpi\n' "$(basename "$produced")" "$version"
done

printf '\nsigned artifacts in dist/signed:\n'
ls -1 "$ARTIFACTS_DIR"
printf '\nInstall it with a double click, then restart Firefox and check the bridge log:\n'
printf '  journalctl --user -u browser-control.service -n 5 | grep "extension connected"\n'
