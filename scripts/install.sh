#!/usr/bin/env bash
#
# Server-side installer: token, systemd user unit, service start, check.
#
# It bundles section 2 and section 3 of INSTALL.md into one run. It does *not*
# replace them as the truth — whoever wants to see the individual commands finds
# them there. The four Firefox steps stay manual work, because neither a page nor
# a script may touch `about:debugging` or the extension's `storage.local`.
#
# Rules this file keeps, and why:
#
# - Nothing is written outside `~/.config/browser-control/`,
#   `~/.config/systemd/user/` and `~/.local/bin/` (plus the parents `mkdir -p`
#   creates). Every write goes through `guard_path()`, so "nothing outside" is a
#   property of the code and not of good intentions.
# - It builds nothing. The bridge is a statically linked binary built by `cargo`;
#   this script copies the artefact of that build and starts the unit that runs it.
#   A missing artefact is a preflight error — not a start that dies in the journal.
# - An existing token is read and checked, never replaced. Rotation is the
#   operator's decision (INSTALL.md, "Rotating the token").
# - The token is printed once, when it is created; otherwise only with --print-token,
#   and never handed to another program as an argument — no `set -x`, no `systemctl`
#   argument, no log line.
# - The script is sourceable: sourcing it defines the functions and starts
#   nothing, which is what makes the path guard falsifiable in the tests.
#
# Exit codes: 0 success, 1 aborted (preflight, option, service not active, write
# target outside the allowed set), 2 token missing, unreadable or too short — the
# same code the bridge uses for the same state.

set -euo pipefail

SCRIPT_PATH=${BASH_SOURCE[0]}
REPO_ROOT=$(cd -- "$(dirname -- "$SCRIPT_PATH")/.." && pwd)

TOKEN_DIR=$HOME/.config/browser-control
TOKEN_FILE=$TOKEN_DIR/token
SYSTEMD_DIR=$HOME/.config/systemd
UNIT_DIR=$SYSTEMD_DIR/user
UNIT_FILE=$UNIT_DIR/browser-control.service
UNIT_SOURCE=$REPO_ROOT/deploy/browser-control.service
BIN_DIR=$HOME/.local/bin
BIN_FILE=$BIN_DIR/browser-control-bridge
SERVICE_NAME=browser-control
CLONE_DIR=$HOME/browser-control
# Both this path and the clone check hang off $CLONE_DIR and not off the directory
# this script happens to run from: the artefact and the unit belong to the clone
# INSTALL.md §4 creates (see bridge-rs/README.md, "Building"). A second clone
# elsewhere must fail loudly instead of installing a build nobody measured.
BINARY_SOURCE=$CLONE_DIR/bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge
EXTENSION_PORT=8110
HTTP_PORT=8111

# The bridge's own contract: `bridge-rs/src/config.rs` (`MIN_TOKEN_LENGTH`) accepts
# 32 hex characters at the least. A stricter number here would refuse a token the
# bridge happily starts with — a false alarm is worse than a hint.
MIN_TOKEN_LENGTH=32
# What INSTALL.md writes. Anything shorter than this is usable but worth a hint.
TOKEN_LENGTH_HINT=64

WANT_HELP=0
DRY_RUN=0
MODE=install

say() {
  printf '%s\n' "$*"
}

# Hints and warnings belong on stderr: stdout carries the progress lines and the
# one line with the token, which must not be diluted by commentary.
note() {
  printf 'Hinweis: %s\n' "$*" >&2
}

step() {
  printf '\n%s\n' "$*"
}

die() {
  local code=$1
  shift
  printf 'Fehler: %s\n' "$*" >&2
  exit "$code"
}

usage() {
  cat <<'USAGE'
install.sh — richtet die Server-Seite von browser-control ein.

Aufruf: scripts/install.sh [OPTION]

Ohne Option: das gebaute Bridge-Binary nach ~/.local/bin kopieren, Token anlegen
oder prüfen, die systemd-User-Unit installieren, den Dienst aktivieren, starten und
prüfen. Danach steht da, was in Firefox noch Handarbeit ist.

Voraussetzung: das Binary ist gebaut —
cargo build --release --target x86_64-unknown-linux-musl in bridge-rs/
(bridge-rs/README.md, "Building"). Node.js wird weder gebraucht noch geprüft.

Optionen:
  (ohne)        installieren oder reparieren, dann prüfen und den Rest ansagen
  --dry-run     alles nur ansagen; nichts schreiben, nichts starten
  --print-token das vorhandene Token ausgeben und sonst nichts tun
  --uninstall   den Dienst stoppen und deaktivieren, die Unit entfernen; das Token bleibt
  --help        diese Übersicht

Exit-Codes:
  0  Erfolg
  1  abgebrochen — Vorprüfung gescheitert (Binary nicht gebaut, belegter Port,
     Klon nicht unter ~/browser-control, $HOME nicht beschreibbar), unbekannte
     Option, Dienst nach dem Start nicht active, oder ein Schreibziel außerhalb
     der erlaubten Pfade
  2  Token fehlt, ist nicht lesbar oder zu kurz

Geschrieben wird nur unter ~/.config/browser-control/, ~/.config/systemd/user/
und ~/.local/bin/ — kein systemweiter Dienst, kein systemweites Token. Ein
vorhandenes Token wird nie überschrieben; ein vorhandenes Binary nur, wenn es
sich vom gebauten unterscheidet.
USAGE
}

usage_short() {
  printf 'Aufruf: scripts/install.sh [--dry-run|--print-token|--uninstall|--help]\n' >&2
}

parse_args() {
  local -a modes=()
  local arg

  for arg in "$@"; do
    case $arg in
      -h|--help) WANT_HELP=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --print-token|--uninstall) modes+=("${arg#--}") ;;
      *)
        printf 'Unbekannte Option: %s\n' "$arg" >&2
        usage_short
        exit 1
        ;;
    esac
  done

  # Two modes at once have no meaning: installing and uninstalling in one run is
  # not a repair, it is a typo. `--dry-run` is not a mode, it modifies one.
  if (( ${#modes[@]} > 1 )); then
    printf 'Mehrere Modi auf einmal gehen nicht: %s\n' "${modes[*]}" >&2
    usage_short
    exit 1
  fi

  MODE=${modes[0]:-install}
}

# The path guard is the whole write boundary. It refuses anything that is not one
# of the three places from the spec or one of their parents — including a path that
# tries to climb out with "..". `$BIN_DIR` is `~/.local/bin` and nothing above it:
# `~/.local/share` stays out even though it shares a parent.
guard_path() {
  local target=$1
  local normalised=$target

  case $target in
    *..*) die 1 "Schreibziel enthält '..' und wird abgelehnt: $target" ;;
  esac

  while [[ $normalised == */ && $normalised != / ]]; do
    normalised=${normalised%/}
  done

  case $normalised in
    "$TOKEN_DIR"|"$SYSTEMD_DIR"|"$UNIT_DIR"|"$BIN_DIR") return 0 ;;
  esac

  if [[ $normalised == "$TOKEN_DIR/"* || $normalised == "$UNIT_DIR/"* || $normalised == "$BIN_DIR/"* ]]; then
    return 0
  fi

  die 1 "Schreibziel außerhalb der erlaubten Pfade: $target (erlaubt sind $TOKEN_DIR, $UNIT_DIR und $BIN_DIR)"
}

ensure_dir() {
  local target=$1
  local mode=$2

  guard_path "$target"
  [[ -d $target ]] && return 0
  mkdir -p -- "$target"
  chmod "$mode" -- "$target"
}

# The only function that writes content. The mode is set afterwards so that a
# leaky umask — or a pre-existing file with wider bits — cannot leave a token
# readable for others.
put_file() {
  local target=$1
  local mode=$2

  guard_path "$target"
  cat >"$target"
  chmod "$mode" -- "$target"
}

remove_file() {
  local target=$1

  guard_path "$target"
  if [[ -e $target ]]; then
    rm -f -- "$target"
    say "Entfernt: $target"
  fi
}

# The service runs exactly one file, so that file has to exist before anything is
# written. Building is deliberately not part of this script: `cargo build` takes
# minutes and a fresh machine needs the toolchain first, so the operator runs it and
# this check only names what is missing.
check_binary() {
  if [[ ! -e $BINARY_SOURCE ]]; then
    die 1 "Das Bridge-Binary ist nicht gebaut: $BINARY_SOURCE fehlt. Zuerst 'cargo build --release --target x86_64-unknown-linux-musl' in bridge-rs/ laufen lassen (bridge-rs/README.md, Building)."
  fi

  if [[ ! -f $BINARY_SOURCE || ! -x $BINARY_SOURCE ]]; then
    die 1 "Das Bridge-Binary ist nicht ausführbar: $BINARY_SOURCE. Ein Artefakt ohne Ausführungsrecht wird nicht kopiert — der Dienst käme damit nicht über den Start hinaus."
  fi

  say "Bridge-Binary: $BINARY_SOURCE"
}

# The artefact and the unit belong to the clone INSTALL.md §4 creates, so a clone
# somewhere else is a preflight error with both paths in the message — not a service
# that systemd reads and then loses.
check_repo_path() {
  if [[ ! -r $UNIT_SOURCE ]]; then
    die 1 "Die Vorlage der systemd-Unit fehlt: $UNIT_SOURCE. Läuft das Skript aus einem vollständigen Klon?"
  fi

  if [[ ! -d $CLONE_DIR ]]; then
    die 1 "Der Klon liegt nicht unter $CLONE_DIR: dieses Skript läuft aus $REPO_ROOT, und Binary wie Unit werden in $CLONE_DIR erwartet (INSTALL.md §4 klont dorthin)."
  fi
}

check_home_writable() {
  if [[ ! -w $HOME || ! -x $HOME ]]; then
    die 1 "\$HOME ist nicht beschreibbar: $HOME. Ohne Schreibrecht lassen sich Token und Unit nicht anlegen."
  fi

  if [[ -e $HOME/.config && ! -w $HOME/.config ]]; then
    die 1 "Das Verzeichnis $HOME/.config ist nicht beschreibbar: $HOME/.config."
  fi
}

# The line of `ss -ltnp` that listens on the given port, or nothing. Field 4 is the
# local address; matching on the end of the field keeps `:81110` from counting as
# `:8110`.
listening_line() {
  local port=$1
  local listing=$2

  printf '%s\n' "$listing" | awk -v suffix=":$port" '
    /LISTEN/ {
      for (field = 1; field <= NF; field++) {
        if (length($field) >= length(suffix) && substr($field, length($field) - length(suffix) + 1) == suffix) {
          print
          exit
        }
      }
    }'
}

owner_pid() {
  printf '%s\n' "$1" | sed -n 's/.*pid=\([0-9]\{1,\}\).*/\1/p'
}

owner_name() {
  printf '%s\n' "$1" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p'
}

# Asked only when a port is actually taken: a dry run on a free machine must not
# talk to systemd at all.
own_service_pid() {
  # An unknown or stopped unit answers with an empty PID — the caller compares it,
  # it does not treat it as a failure.
  systemctl --user show --property=MainPID --value "$SERVICE_NAME" 2>/dev/null | tr -d '[:space:]' || true
}

check_ports() {
  local listing port line pid name own

  if ! command -v ss >/dev/null 2>&1; then
    note "ss ist nicht vorhanden — die Ports $EXTENSION_PORT und $HTTP_PORT bleiben ungeprüft."
    return 0
  fi

  # Without `-p` permission `ss` still lists what it can see; a failing `ss` reads
  # as "no listener", and a taken port turns up again when the service starts.
  listing=$(ss -ltnp 2>/dev/null || true)

  for port in "$EXTENSION_PORT" "$HTTP_PORT"; do
    line=$(listening_line "$port" "$listing")
    [[ -n $line ]] || continue

    pid=$(owner_pid "$line")
    name=$(owner_name "$line")

    if [[ -z $pid ]]; then
      die 1 "Port $port ist belegt, Besitzer nicht ermittelbar (ss -ltnp nannte keine PID). Nächster Schritt: 'ss -ltnp | grep :$port' zeigt die Zeile. Den Dienst beendet 'systemctl --user stop browser-control.service'; einen von Hand gestarteten Bridge beendet 'kill <pid>' mit der PID aus genau dieser Zeile — kein 'pkill -f browser-control-bridge', das trifft auch den laufenden Dienst."
    fi

    own=$(own_service_pid)
    if [[ -n $own && $own == "$pid" ]]; then
      say "Port $port gehört zum eigenen Dienst (PID $pid) — kein Konflikt."
      continue
    fi

    die 1 "Port $port ist belegt von ${name:-einem unbekannten Prozess} (PID $pid). Nächster Schritt: den Prozess beenden (kill $pid); ein von Hand gestarteter Bridge aus INSTALL.md §3 ist der übliche Fall."
  done
}

run_preflight() {
  step "Vorprüfung"
  check_repo_path
  check_binary
  check_home_writable
  check_ports
  say "Vorprüfung bestanden."
}

# An unreadable token file is a token problem, not a preflight finding: exit 2 with
# the path and the command that usually fixes it, instead of bash's raw
# "Keine Berechtigung".
require_readable_token() {
  if [[ -f $TOKEN_FILE && ! -r $TOKEN_FILE ]]; then
    die 2 "Tokendatei ist nicht lesbar: $TOKEN_FILE. Meist hilft: chmod 600 $TOKEN_FILE"
  fi
}

# The content of the token file without whitespace at its edges — what `.trim()` does
# in `read_token()` (`bridge-rs/src/config.rs`). Inner whitespace stays, deliberately: a
# token with a space in the middle is refused here because the bridge refuses it
# too. Trimming line by line with `sed` would be shorter and wrong for a file whose
# first line is empty — the bridge still accepts what stands on the second.
read_token_value() {
  local content

  content=$(cat -- "$TOKEN_FILE")
  content=${content#"${content%%[![:space:]]*}"}
  content=${content%"${content##*[![:space:]]}"}
  printf '%s' "$content"
}

# Same threshold as `bridge-rs/src/config.rs`: 32 hex characters are the minimum. A
# shorter token cannot work, and pretending otherwise would only move the failure
# into the service log.
validate_token() {
  local value=$1

  if [[ ! $value =~ ^[0-9a-fA-F]+$ ]] || (( ${#value} < MIN_TOKEN_LENGTH )); then
    die 2 "Tokendatei ist unbrauchbar (zu kurz oder kein Hex): $TOKEN_FILE. Nötig sind mindestens $MIN_TOKEN_LENGTH Hex-Zeichen, INSTALL.md legt $TOKEN_LENGTH_HINT an."
  fi

  if (( ${#value} < TOKEN_LENGTH_HINT )); then
    note "das Token hat ${#value} Hex-Zeichen, INSTALL.md legt $TOKEN_LENGTH_HINT an. Die Bridge startet damit; das Skript lässt es stehen und überschreibt es nicht."
  fi
}

check_token_permissions() {
  local mode

  mode=$(stat -c '%a' "$TOKEN_FILE")
  if [[ $mode != 600 ]]; then
    note "die Tokendatei hat die Rechte $mode, erwartet sind 600 — das Skript ändert sie nicht, weil das eine Entscheidung des Betreibers ist. Bitte selbst: chmod 600 $TOKEN_FILE"
  fi
}

# An existing token is read and checked, never written over. Rotation stays manual
# work (INSTALL.md, "Rotating the token") — a reinstall must not silently log the
# extension out.
ensure_token() {
  local value

  ensure_dir "$TOKEN_DIR" 700

  if [[ -f $TOKEN_FILE ]]; then
    require_readable_token
    value=$(read_token_value)
    validate_token "$value"
    check_token_permissions
    say "Token bleibt unverändert: $TOKEN_FILE"
    return 0
  fi

  say "Token anlegen: $TOKEN_FILE (600, $TOKEN_LENGTH_HINT Hex-Zeichen)"
  # Only a run that creates the token may print it; `cmd_install` reads this flag.
  TOKEN_CREATED=1
  # `umask 077` in a subshell: globally it would hand the unit mode 600 too, and a
  # unit is not a secret.
  (
    umask 077
    openssl rand -hex 32 | put_file "$TOKEN_FILE" 600
  )
}

cmd_print_token() {
  local value

  if [[ ! -f $TOKEN_FILE ]]; then
    die 2 "Tokendatei fehlt: $TOKEN_FILE. Ohne Token startet die Bridge nicht; ein Lauf ohne Option legt eins an."
  fi

  require_readable_token
  value=$(read_token_value)
  validate_token "$value"
  # Exactly the token on stdout, nothing else: this is the line an operator copies.
  printf '%s\n' "$value"
}

cmd_install() {
  local value

  TOKEN_CREATED=0

  step "1/5 Bridge-Binary"
  install_binary

  step "2/5 Token"
  ensure_token

  step "3/5 systemd-Unit"
  ensure_unit

  step "4/5 Dienst"
  start_service

  step "5/5 Token und Endpunkt für Firefox"
  say "Endpunkt: ws://127.0.0.1:$EXTENSION_PORT"
  # A repair run ends up in logs, tickets and transcripts; the value belongs to the
  # run that created it. `--print-token` is the way back and stays an express
  # question. `$REPO_ROOT` is absolute, `$SCRIPT_PATH` is not.
  if (( TOKEN_CREATED )); then
    value=$(read_token_value)
    say "Token neu angelegt, jetzt einfügen (später nur mit --print-token): $value"
  else
    say "Token unverändert (nicht gedruckt). Zum Einfügen: $REPO_ROOT/scripts/install.sh --print-token"
  fi

  step "Firefox — Handarbeit, das Skript kann sie nicht übernehmen"
  say "1. about:debugging#/runtime/this-firefox öffnen und \"Load Temporary Add-on…\" wählen."
  say "2. $REPO_ROOT/extension/manifest.json auswählen."
  say "3. In den Einstellungen der Erweiterung Endpunkt und Token eintragen."
  say "4. Speichern und die Erweiterung in about:debugging einmal neu laden."
}

# The binary is copied, never built and never moved: the unit starts
# `%h/.local/bin/browser-control-bridge`, so that file is the whole product on this
# machine. A second run is a no-op when bytes and execute bit already match —
# `cmp -s` is what makes the rerun cheap and the modification time stable.
install_binary() {
  local staging=$BIN_FILE.new

  ensure_dir "$BIN_DIR" 755

  if [[ -f $BIN_FILE ]] && cmp -s -- "$BINARY_SOURCE" "$BIN_FILE" && [[ -x $BIN_FILE ]]; then
    say "Bridge-Binary ist schon aktuell: $BIN_FILE"
    return 0
  fi

  say "Bridge-Binary installieren: $BIN_FILE"
  # Written beside the target and renamed into place. A running service keeps its
  # old inode alive, and writing over the file it executes would meet ETXTBSY;
  # the rename also means a half-copied file can never be what systemd starts.
  put_file "$staging" 755 <"$BINARY_SOURCE"
  mv -f -- "$staging" "$BIN_FILE"
}

# The unit is copied byte for byte: it names a fixed install path, and rewriting it
# here would produce a second truth next to `deploy/`. `cmp -s` is what makes a
# second run a no-op on an unchanged file — including its modification time.
ensure_unit() {
  ensure_dir "$UNIT_DIR" 755

  if [[ -f $UNIT_FILE ]] && cmp -s -- "$UNIT_SOURCE" "$UNIT_FILE"; then
    say "Systemd-Unit ist schon aktuell: $UNIT_FILE"
    return 0
  fi

  say "Systemd-Unit installieren: $UNIT_FILE"
  put_file "$UNIT_FILE" 644 <"$UNIT_SOURCE"
}

# `daemon-reload` first: without the reload systemd does not know the file yet, and
# `enable` would only report that the unit does not exist.
#
# A *running* service gets `restart`, not `enable --now`. `enable --now` leaves an
# active unit untouched, so a reinstall would keep the old binary in memory and
# serve the old texts (measured 2026-11-22: 0.7.0 was copied, the process kept
# answering with 0.6.1's sentences). `enable` stays in both paths: the unit must
# come up after a reboot either way.
start_service() {
  systemctl --user daemon-reload || die 1 "systemctl --user daemon-reload ist gescheitert."
  systemctl --user enable "$SERVICE_NAME" || die 1 "systemctl --user enable $SERVICE_NAME ist gescheitert."

  if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    say "Dienst läuft — neu starten mit dem neuen Binary: $SERVICE_NAME"
    systemctl --user restart "$SERVICE_NAME" || die 1 "systemctl --user restart $SERVICE_NAME ist gescheitert."
  else
    say "Dienst starten: $SERVICE_NAME"
    systemctl --user start "$SERVICE_NAME" || die 1 "systemctl --user start $SERVICE_NAME ist gescheitert."
  fi

  if ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
    die 1 "Der Dienst läuft nach dem Start nicht (is-active meldet nicht 'active'). Protokoll ansehen: journalctl --user -u $SERVICE_NAME"
  fi

  say "Dienst ist aktiv."
}

main() {
  parse_args "$@"

  if (( WANT_HELP )); then
    usage
    exit 0
  fi

  # A preview has to be answered before the mode is carried out: a `--dry-run
  # --uninstall` that removes the unit is not a preview, and a `--dry-run
  # --print-token` that prints the token is not one either. Removing and printing
  # need no preflight, so their dry run is the announcement and nothing else.
  if (( DRY_RUN )) && [[ $MODE != install ]]; then
    cmd_dry_run
    exit 0
  fi

  if [[ $MODE == print-token ]]; then
    cmd_print_token
    exit 0
  fi

  # Removing has to work after the clone moved, so it runs without any preflight:
  # the binary and the clone path are irrelevant to stopping a unit.
  if [[ $MODE == uninstall ]]; then
    cmd_uninstall
    exit 0
  fi

  run_preflight

  if (( DRY_RUN )); then
    cmd_dry_run
    exit 0
  fi

  cmd_install
}

# A dry run says every step and touches nothing. Which steps it says depends on the
# mode it previews: installing, removing, printing.
cmd_dry_run() {
  case $MODE in
    uninstall) dry_run_uninstall ;;
    print-token) dry_run_print_token ;;
    *) dry_run_install ;;
  esac
}

# The token step of an install is only announced: exiting with 2 because no token
# exists yet would be a strange answer to "what would you do".
dry_run_install() {
  step "Probelauf — geschrieben und gestartet wird nichts"

  step "Bridge-Binary"
  if [[ -f $BIN_FILE ]] && cmp -s -- "$BINARY_SOURCE" "$BIN_FILE" && [[ -x $BIN_FILE ]]; then
    say "Bridge-Binary ist schon aktuell: $BIN_FILE"
  else
    say "Bridge-Binary würde installiert: $BIN_FILE (0755, aus $BINARY_SOURCE)."
  fi

  step "Token"
  if [[ -f $TOKEN_FILE ]]; then
    say "Token bleibt: $TOKEN_FILE (Rechte $(stat -c '%a' "$TOKEN_FILE"))."
  else
    say "Token würde angelegt: $TOKEN_FILE (600, $TOKEN_LENGTH_HINT Hex-Zeichen)."
  fi

  step "systemd-Unit"
  if [[ -f $UNIT_FILE ]] && cmp -s -- "$UNIT_SOURCE" "$UNIT_FILE"; then
    say "Systemd-Unit ist schon aktuell: $UNIT_FILE"
  else
    say "Systemd-Unit würde installiert: $UNIT_FILE"
  fi

  step "Dienst"
  say "systemctl --user daemon-reload, dann enable $SERVICE_NAME; läuft er schon: restart, sonst start; danach is-active."

  step "Danach in Firefox"
  say "Handarbeit: about:debugging öffnen, extension/manifest.json laden, Endpunkt ws://127.0.0.1:$EXTENSION_PORT und das Token eintragen."
}

# The removal preview names the same steps `cmd_uninstall` would take — and stops at
# naming them. The token line mirrors the real run, so the preview does not promise
# a token that is not there.
dry_run_uninstall() {
  step "Probelauf — geschrieben und gestartet wird nichts"

  step "Dienst und Unit entfernen"
  say "Dienst würde deaktiviert und gestoppt: systemctl --user disable --now $SERVICE_NAME"
  say "Entfernt würde: $UNIT_FILE."
  say "Das Binary bleibt liegen: $BIN_FILE."
  if [[ -f $TOKEN_FILE ]]; then
    say "Token bleibt: $TOKEN_FILE"
  else
    say "Kein Token vorhanden — nichts zu behalten."
  fi
  say "Die Erweiterung in Firefox wird von Hand entfernt (about:debugging)."
}

# The length is all a preview may reveal. Printing the value would turn the preview
# into the real answer, and `--print-token` exists for one line the operator copies
# knowingly.
dry_run_print_token() {
  local value

  step "Probelauf — geschrieben und gestartet wird nichts"

  if [[ ! -f $TOKEN_FILE ]]; then
    say "Tokendatei fehlt: $TOKEN_FILE — der Probelauf hat nichts auszugeben. Ein Lauf ohne Option legt eins an."
    return 0
  fi

  require_readable_token
  value=$(read_token_value)
  say "Token würde ausgegeben (${#value} Zeichen, ohne Inhalt)."
}

cmd_uninstall() {
  step "Dienst und Unit entfernen"

  # A unit that was never started is not an error: this is still the right state to
  # end in. `|| note` keeps the message without stopping the removal.
  systemctl --user disable --now "$SERVICE_NAME" || note "disable --now meldete einen Fehler — vermutlich lief der Dienst nicht; das Entfernen geht weiter."

  remove_file "$UNIT_FILE"

  # Claiming the token stays when no file exists would be a promise the operator
  # cannot check without looking — and looking is what this line is for.
  if [[ -f $TOKEN_FILE ]]; then
    say "Token bleibt: $TOKEN_FILE"
  else
    say "Kein Token vorhanden — nichts zu behalten."
  fi
  say "Das Binary bleibt liegen: $BIN_FILE."
  say "Fertig. Die Erweiterung in Firefox wird von Hand entfernt (about:debugging)."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
