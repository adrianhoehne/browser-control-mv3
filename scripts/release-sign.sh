#!/usr/bin/env bash
# Signs a released version and puts the signed XPI where a downloader can find it.
#
# Order matters: the tag first, then CI builds it, then this. Signing before the
# release would sign a build that is not the published one.
#
# Nothing here touches git: the artifact lives in dist/ (gitignored) and belongs to
# the GitHub release, not to the repository (decision 2026-11-20).
#
# Usage: scripts/release-sign.sh <tag> [--no-upload]
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'EOT'
usage: scripts/release-sign.sh <tag> [--no-upload]

Signs the extension, verifies the signature in a throwaway Firefox profile and
uploads the signed XPI to the GitHub release of <tag>.

  --no-upload   sign and verify, stop before uploading
  --fix-zips    after uploading, replace the UNSIGNED xpi inside the portable
                zips with the signed one and upload them again (the CI builds
                them before signing exists, so they would otherwise carry an
                xpi that a release Firefox refuses)
EOT
}

tag=""; upload=true; fix_zips=false
for arg in "$@"; do
  case "$arg" in
    --no-upload) upload=false ;;
    --fix-zips) fix_zips=true ;;
    --help|-h) usage; exit 0 ;;
    -*) fail "unknown option: $arg" ;;
    *) tag="$arg" ;;
  esac
done
[[ -n "$tag" ]] || { usage >&2; exit 1; }

version="$(node -p "require('$REPO_ROOT/extension/manifest.json').version")"
[[ "$tag" == "v$version" ]] || fail "tag $tag does not match manifest version $version"

"$REPO_ROOT/scripts/sign.sh"
signed="$REPO_ROOT/dist/signed/browser-control-$version.xpi"
[[ -f "$signed" ]] || fail "no signed artifact at $signed"

# Verified before it is published: an upload of an unsigned or broken file would be
# worse than no upload, because a downloader would trust the name.
"$REPO_ROOT/scripts/verify-signature.sh" "$signed"

if [[ "$upload" == false ]]; then
  printf '\n--no-upload: %s was not uploaded\n' "$signed"
  exit 0
fi

repo="$(git -C "$REPO_ROOT" remote get-url mv3 | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
gh release upload "$tag" "$signed" --clobber --repo "$repo"
printf '\nuploaded %s to %s\n' "$(basename "$signed")" "$tag"

if [[ "$fix_zips" == true ]]; then
  work="$(mktemp -d "${TMPDIR:-/tmp}/bc-zips-XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  for asset in $(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' | grep -E -- "-$version-.*\.zip$"); do
    printf '\nfixing %s\n' "$asset"
    gh release download "$tag" --repo "$repo" --pattern "$asset" --dir "$work"
    unzip -q "$work/$asset" -d "$work/unpacked"
    inner="$(find "$work/unpacked" -name "browser-control-$version.xpi" | head -1)"
    [[ -n "$inner" ]] || fail "no xpi inside $asset"
    cp "$signed" "$inner"
    ( cd "$work/unpacked" && zip -qr "$work/$asset" ./* )
    gh release upload "$tag" "$work/$asset" --clobber --repo "$repo"
    rm -rf "$work/unpacked"
    printf '  replaced %s with the signed xpi\n' "$(basename "$inner")"
  done
  printf '\nfinal assets:\n'
  gh release view "$tag" --repo "$repo" --json assets --jq '.assets[] | "\(.name) \(.size)"'
fi
gh release view "$tag" --json assets --jq '.assets[] | "\(.name) \(.size)"'
