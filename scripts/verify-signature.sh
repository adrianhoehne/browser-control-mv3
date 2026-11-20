#!/usr/bin/env bash
# Checks one XPI the way Firefox does: load it in a throwaway profile and read
# `signedState` out of `extensions.json`. Spec 46, criterion 5.
#
# Not part of `npm test`: the signed artifact lives in `dist/signed/`, is
# gitignored and is produced by AMO — CI has nothing to check. A case that had to
# skip there would break the "no skipped cases" rule for the wrong reason.
#
# Usage: scripts/verify-signature.sh dist/signed/<name>.xpi
set -euo pipefail

fail() { printf 'error: %s\n' "$1" >&2; exit 1; }
usage() {
  cat <<'EOF'
usage: scripts/verify-signature.sh <xpi> [--keep]

Loads the XPI in a throwaway Firefox profile and reports what Firefox decided:
  signedState 2   validly signed (the only acceptable answer here)
  signedState -1  not signed
Exit 0 only for a signed artifact that Firefox actually loaded.

  --keep   leave the profile in place and print its path
EOF
}

artifact=""
keep=false
for arg in "$@"; do
  case "$arg" in
    --keep) keep=true ;;
    --help|-h) usage; exit 0 ;;
    -*) fail "unknown option: $arg" ;;
    *) artifact="$arg" ;;
  esac
done

[[ -n "$artifact" ]] || { usage >&2; exit 1; }
[[ -f "$artifact" ]] || fail "no such file: $artifact"
command -v firefox >/dev/null 2>&1 || fail "firefox is not on PATH"

id="$(unzip -p "$artifact" manifest.json 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (d) => { raw += d; });
  process.stdin.on("end", () => {
    const m = JSON.parse(raw);
    console.log(m.browser_specific_settings?.gecko?.id ?? "");
  });
')"
[[ -n "$id" ]] || fail "no extension id in $artifact"

profile="$(mktemp -d "${TMPDIR:-/tmp}/bc-verify-XXXXXX")"
cleanup() { [[ "$keep" == true ]] || rm -rf "$profile"; }
trap cleanup EXIT

mkdir -p "$profile/extensions"
cp "$artifact" "$profile/extensions/$id.xpi"
# Without these two, a hand-placed XPI waits for a click that headless cannot give:
# `active` stays false and the answer would be about the missing click, not the
# signature.
cat > "$profile/user.js" <<'EOF'
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
EOF

firefox --headless --no-remote --profile "$profile" about:blank >/dev/null 2>&1 &
ffpid=$!
sleep 25
kill "$ffpid" 2>/dev/null || true
wait "$ffpid" 2>/dev/null || true
sleep 2

answer="$(node - "$profile" "$id" <<'NODE'
const fs = require("node:fs");
const [profile, id] = process.argv.slice(2);
const file = `${profile}/extensions.json`;
if (!fs.existsSync(file)) { console.log("none|Firefox wrote no extensions.json"); process.exit(0); }
const addons = JSON.parse(fs.readFileSync(file, "utf8")).addons ?? [];
const addon = addons.find((a) => a.id === id);
if (!addon) { console.log("absent|the add-on was not loaded at all"); process.exit(0); }
console.log(`${addon.signedState}|active=${addon.active} userDisabled=${addon.userDisabled} version=${addon.version}`);
NODE
)"

state="${answer%%|*}"
detail="${answer#*|}"
printf 'artifact  %s\nprofile   %s\nfirefox   %s\nsignedState %s  (%s)\n' \
  "$artifact" "$( [[ "$keep" == true ]] && echo "$profile" || echo "removed" )" \
  "$(firefox --version 2>&1 | head -1)" "$state" "$detail"

case "$state" in
  2) printf '\nOK — Firefox accepts the signature.\n'; exit 0 ;;
  -1) fail "Firefox reports the XPI as UNSIGNED" ;;
  absent) fail "Firefox did not load the add-on at all" ;;
  *) fail "unexpected state: $state" ;;
esac
