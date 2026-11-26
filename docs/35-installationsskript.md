---
description: Ein Installationsskript für die Server-Seite — Token, systemd-Unit, Dienststart und Prüfung in einem Befehl, idempotent, ohne Firefox-Automatisierung; die vier Schritte in der Extension bleiben Handarbeit.
status: active
---

# Das Installationsskript

Die Einrichtung der Server-Seite besteht heute aus den Befehlen in
`INSTALL.md` §2 (Token) und §3 (Unit, Dienst). Sie sind einzeln richtig, aber in der falschen
Reihenfolge gefährlich (Dienst vor Token ⇒ Exit 2) und in der Summe
fehleranfällig. Diese Spec bündelt sie in **einem** Befehl.

**Was das Skript nicht kann und nicht versucht:** die Extension in Firefox laden
oder ihre Optionen füllen. Firefox erlaubt keiner Seite und keinem Skript den
Zugriff auf `about:debugging`, und `storage.local` gehört der Extension. Diese
vier Schritte bleiben Handarbeit — das Skript bereitet sie vor und sagt, was
fehlt.

## Ziel

**Stand 2026-11-15: gebaut, abgenommen und in `v0.2.0` veröffentlicht** — 21
Tests, fünf Mutationsproben, Code-Review `✅` nach einem Muss-Befund.

**Stand 2026-11-17, nachgezogen in Stufe 4a von `docs/38`:** die Bridge ist ein
statisch gelinktes Rust-Binary, also prüft und kopiert das Skript ein **Binary**
statt einer Node-Installation. Es hat damit **22 `install_`-Fälle**; zusammen mit
den neun Unit-Fällen aus `test/deploy.test.js` sind es **31**. Neu sind
`install_copiesTheBinaryToLocalBin` und
`install_withMissingBinary_abortsBeforeWriting`; `--fix-path` ist entfallen
(`## Die Optionen`), und der frühere `install_withOldNode_abortsBeforeWriting`
heißt jetzt `install_withOldNodeOnThePath_ignoresTheVersion` und belegt das
Gegenteil: eine alte Node-Version stört nicht mehr, weil Node keine
Betriebsvoraussetzung ist.

**Stand 2026-11-26, nachgezogen aus `docs/68`:** **24 `install_`-Fälle**, zusammen **33**.
Das Token erscheint beim Anlegen genau einmal, ein Reparaturlauf nennt nur
`--print-token`. Neu ist `install_withAnExistingToken_doesNotPrintIt`.

- **Ein Befehl** auf dem Server: `./scripts/install.sh` kopiert das gebaute
  Bridge-Binary nach `~/.local/bin`, legt das Token an, installiert die
  systemd-User-Unit, aktiviert den Dienst, startet oder **startet neu** und prüft
  ihn. Danach steht
  da, was in Firefox noch zu tun ist — beim Anlegen mit Endpunkt und Token,
  sonst mit Endpunkt und dem Hinweis auf `--print-token`.
- **Idempotent.** Ein zweiter Lauf ändert nichts, was schon stimmt. Ein
  **vorhandenes Token wird nie überschrieben** — Rotation bleibt Handarbeit
  und eine Entscheidung des Betreibers.
- **Das Token erscheint beim Anlegen genau einmal**; ein Reparaturlauf druckt es nicht und nennt `--print-token`.
  Nicht in einer Datei außer der Tokendatei, nicht im Journal, nicht in einer Logzeile des Skripts.
- **Nichts außerhalb von drei Orten.** Geschrieben wird nur nach
  `~/.config/browser-control/`, `~/.config/systemd/user/` und `~/.local/bin/`.
  Dazu gehören die Elternverzeichnisse, die ein `mkdir -p` dabei anlegt
  (`~/.config`, `~/.config/systemd`, `~/.local`) — sie stehen ausdrücklich in der
  erlaubten Menge, sonst wäre die eigene Zusage nicht erfüllbar. **Kein `sudo`**,
  kein systemweiter Dienst.
- **Vorprüfungen vor dem ersten Schreibvorgang:** gebautes Bridge-Binary
  (`bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge`,
  vorhanden **und** ausführbar), freie Ports `8110`/`8111` (mit Nennung des
  Besitzers), lesbarer Klon-Pfad, beschreibbares `$HOME`. Was fehlt, wird **vor**
  dem Schreiben gemeldet.
- **Deutsche Ausgabe**, englische Kommentare im Code — wie im Projekt üblich.
- **Kein neues Werkzeug, keine Abhängigkeit.** Bash und die Werkzeuge, die
  ohnehin gebraucht werden (`openssl`, `systemctl`, `ss`, `cmp`, `mv`). Der
  Rust-Build ist **Vorbedingung, nicht Teil des Skripts**: `cargo build` dauert
  Minuten und braucht auf einer frischen Maschine erst die Werkzeugkette, deshalb
  läuft er von Hand (`bridge-rs/README.md`, "Building").

## Non-goals

- **Keine Firefox-Automatisierung.** Kein `about:debugging`, kein Policy-File,
  kein Native Messaging.
- **Kein Caddy, kein TLS.** Der öffentliche Endpunkt bleibt der optionale
  Anhang in `INSTALL.md`.
- **Keine Token-Rotation.** Das Skript legt ein Token an, wenn keins da ist;
  ein vorhandenes rührt es nicht an.
- **Kein `git clone`.** Das Skript läuft aus dem Klon.
- **Kein `loginctl enable-linger`.** Ob der Dienst ohne Login laufen soll, bleibt
  eine Entscheidung des Betreibers (`INSTALL.md` §3), nicht eine des Skripts.
- **Kein zweiter Installationsweg.** Wer die Einzelbefehle will, findet sie
  weiter in `INSTALL.md`; das Skript ersetzt sie nicht als Wahrheit, sondern
  bündelt sie.

## Die Entscheidungen

| Frage | Entscheidung |
|---|---|
| Wird ein vorhandenes Token überschrieben? | **nein** — es wird geprüft (Länge, Rechte) und sonst gemeldet |
| Darf das Skript `sudo` benutzen? | **nein** — User-Unit, User-Token, User-State |
| Darf es das Bridge-Binary kopieren? | **ja** — von `<clone>/bridge-rs/target/x86_64-unknown-linux-musl/release/` nach `$HOME/.local/bin`, `0755`, idempotent; fehlt das Artefakt, bricht der Lauf mit Exit `1` und dem `cargo build`-Befehl ab |
| Darf es den Dienst entfernen? | **nur mit `--uninstall`**, und das Token bleibt dabei stehen |
| Token-Schwelle | **32 Hex-Zeichen**, wie `bridge/config.mjs` — was die Bridge akzeptiert, lehnt das Skript nicht ab; 32–63 Zeichen mit Hinweis |
| Was passiert bei belegten Ports? | Meldung mit Besitzer (`ss`), Abbruch **vor** dem Schreiben; ein laufender eigener Dienst zählt nicht als Konflikt |

## Die Optionen

| Option | Wirkung |
|---|---|
| *(ohne)* | installieren oder reparieren, dann prüfen und den Rest ansagen |
| `--dry-run` | alles zeigen, nichts schreiben, nichts starten |
| `--print-token` | das vorhandene Token ausgeben, sonst nichts tun |
| `--uninstall` | Dienst stoppen und deaktivieren, Unit entfernen; Token und Binary bleiben |
| `--help` | die Optionen und was sie tun |

Die frühere Option für eine `PATH`-Drop-in-Datei gibt es **nicht mehr** (Stufe 4a
von `docs/38`): die Unit startet ein Binary und braucht dafür keinen `PATH`. Wer
sie aufruft, bekommt die Meldung über die unbekannte Option und Exit `1`.

**Exit-Codes:** `0` Erfolg; `1` der Lauf wurde abgebrochen — Vorprüfung
gescheitert (Binary nicht gebaut oder nicht ausführbar, Klon-Pfad, `$HOME`,
Ports), unbekannte Option, der Dienst nach dem Start nicht `active`, oder ein
Schreibziel außerhalb der erlaubten Menge (`guard_path`); `2` Token fehlt oder
ist zu kurz —
derselbe Code, den die Bridge für denselben Zustand benutzt. Die Meldung sagt
jeweils, welche der Ursachen es war; die Zahl allein ist absichtlich grob.

**Kombinationen sind nicht vorgesehen:** mehr als ein Modus außer `--dry-run`
nebeneinander ⇒ Meldung mit Kurzhilfe, Exit `1`.

**Belegter Port:** die Meldung nennt Port und Besitzer-PID **und** den nächsten
Schritt — bei einem handgestarteten Bridge aus `INSTALL.md` §3 ist das
`kill <pid>`.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/install.test.js` | `install_helpPrintsTheOptionsAndWritesNothing` | `--help`: Exit `0`, alle Optionen genannt, nichts geschrieben |
| `test/install.test.js` | `install_withOldNodeOnThePath_ignoresTheVersion` | `node` mit `v20` auf dem `PATH` (und ein Lauf ganz ohne `node`) ⇒ Exit `0`: Node ist keine Betriebsvoraussetzung mehr |
| `test/install.test.js` | `install_withMissingBinary_abortsBeforeWriting` | kein Artefakt **oder** eines ohne Ausführungsrecht ⇒ Exit `1` mit `cargo build`-Befehl, keine Datei |
| `test/install.test.js` | `install_copiesTheBinaryToLocalBin` | Binary liegt unter `~/.local/bin` mit `0755`, byte-gleich; zweiter Lauf schreibt nicht, ein neuer Build schon |
| `test/install.test.js` | `install_withOpenPort_abortsBeforeWriting` | belegter Port ⇒ Exit `1`, Meldung mit Port und PID, kein Token |
| `test/install.test.js` | `install_withMissingUnitTarget_abortsBeforeWriting` | Klon nicht unter `~/browser-control` ⇒ Exit `1`, Meldung nennt beide Pfade |
| `test/install.test.js` | `install_guardPathRejectsAPathOutsideTheAllowedSet` | der Pfadwächter bricht bei `/etc/passwd` mit Exit `1` ab |
| `test/install.test.js` | `install_withUnknownOption_printsHelpAndExitsOne` | unbekannte Option ⇒ Kurzhilfe, Exit `1`, nichts geschrieben |
| `test/install.test.js` | `install_withUnwritableHome_abortsBeforeWriting` | `$HOME` nicht beschreibbar ⇒ Exit `1`, keine Datei |
| `test/install.test.js` | `install_withLooseTokenPermissions_reportsWithoutFixing` | Token mit `644` wird **gemeldet**, nicht stillschweigend korrigiert |
| `test/install.test.js` | `install_dryRunWritesNothing` | `--dry-run`: Schritte genannt, `readTree(home)` unverändert, kein `systemctl` |
| `test/install.test.js` | `install_createsTokenWithTightPermissions` | Tokendatei `600`, 65 Bytes, Verzeichnis `700` |
| `test/install.test.js` | `install_withAnExistingToken_doesNotTouchIt` | zweiter Lauf: `sha256`, `mtimeNs` und Modus unverändert |
| `test/install.test.js` | `install_withAnExistingToken_doesNotPrintIt` | vorhandenes Token: die Zeichenfolge steht nicht auf `stdout`, die Zeile nennt `--print-token` und den absoluten Pfad |
| `test/install.test.js` | `install_withTooShortToken_exitsTwo` | 10-Zeichen-Token ⇒ Exit `2`, Datei byte-gleich |
| `test/install.test.js` | `install_withAShortButUsableToken_keepsGoing` | 32 Zeichen ⇒ Exit `0` mit Hinweis (die Bridge akzeptiert es) |
| `test/install.test.js` | `install_printTokenPrintsOnlyTheToken` | `--print-token`: nur das Token, kein `systemctl`, kein Schreiben |
| `test/install.test.js` | `install_installsAndStartsTheUnit` | Unit liegt unter `~/.config/systemd/user/`; `daemon-reload` vor `enable --now`, danach `is-active` |
| `test/install.test.js` | `install_withAStoppedService_startsItInsteadOfRestarting` | gestoppter Dienst: `start` statt `restart` |
| `test/install.test.js` | `install_isIdempotent` | zweiter Lauf: `openssl` einmal, Unit-`mtimeNs` gleich, der zweite Lauf druckt das Token nicht, eigener Dienst kein Portkonflikt |
| `test/install.test.js` | `install_dryRunUninstallKeepsTheUnit` | `--dry-run --uninstall` sagt an und entfernt nichts |
| `test/install.test.js` | `install_uninstallKeepsTheToken` | `--uninstall`: `disable --now`, Unit weg, Token bleibt |
| `test/install.test.js` | `install_printsTheTokenOnce` | Token genau einmal auf stdout, nirgends sonst |
| `test/install.test.js` | `install_writesOnlyUnderHome` | jede neue Datei liegt unter den drei erlaubten Pfaden |
| `npm test` | `# fail 0`, `# cancelled 0`, `# skipped 0` | nichts ist kaputt (auf einem Host mit nicht-interner IPv4) |
| `bash -n scripts/install.sh` | Exit 0 | Syntax |

Die Tests fahren das Skript als **Prozess** mit einem temporären `HOME` und einem
**Stub-Verzeichnis am Anfang von `PATH`** (`systemctl`, `ss`, `openssl`; ein
`node`-Stub nur in dem Fall, der beweist, dass die Version keine Rolle mehr
spielt) — nichts am echten System. Die Sandbox legt `home/browser-control/` mit
einem **Ersatz-Artefakt** unter `bridge-rs/target/…/release/` an: ein
ausführbares Skript, damit kein Test einen `cargo`-Build braucht. Die
Stub-Antworten werden **je Fall** über die Umgebung gesetzt
(`BC_INSTALL_STUB_SS`, `BC_INSTALL_STUB_IS_ACTIVE`, `BC_INSTALL_STUB_MAINPID`);
`runInstall(sandbox, args, extraEnv = {})` reicht sie durch. `test/install.test.js` ist neu; das Skript selbst bindet keinen
Port, `test/ports.js` bleibt unberührt.

## Acceptance criteria

**Jedes Kriterium nennt zwei Belege:** dass der Fall im Dateitext steht —
`grep -cE '^test\("<name>' test/install.test.js` ⇒ **1** (mit Datei-Operand;
ohne ihn liest `grep` stdin und zählt immer `0`) — **und** dass er grün läuft:
`node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - <name>'`
⇒ **1**. Ein Name im Text beweist nichts.

1. **Ein Befehl richtet ein.** Auf leerem, temporärem `HOME` (mit Stubs)
   hinterlässt `./scripts/install.sh`: das Binary unter `~/.local/bin` (`0755`,
   byte-gleich zum Build), Tokendatei `600` mit 65 Bytes, Unit unter
   `~/.config/systemd/user/`, und `systemctl --user daemon-reload` sowie
   `enable --now browser-control` wurden gerufen, danach `is-active`.
   Beweis: `install_installsAndStartsTheUnit`,
   `install_copiesTheBinaryToLocalBin` **und**
   `install_createsTokenWithTightPermissions` (Datei `600`, 65 Bytes = 64
   Hex-Zeichen plus Zeilenumbruch).
2. **Idempotent, Token unangetastet.** Zweiter Lauf: Tokendatei byte-gleich
   (`sha256`), Unit nicht neu geschrieben (`mtimeNs`), `openssl` genau einmal.
   Beweis: `install_withAnExistingToken_doesNotTouchIt`, `install_isIdempotent`.
3. **`--dry-run` schreibt nichts — auch nicht in den Modi, die löschen.**
   Beweis: `install_dryRunWritesNothing`; `install_dryRunUninstallKeepsTheUnit`
   (`--dry-run --uninstall` sagt an, die Unit bleibt, kein `systemctl`) — und
   `--dry-run --print-token` sagt an, statt das Token auszugeben.
4. **Vorprüfungen greifen vor dem ersten Schreibvorgang.** Ein fehlendes oder
   nicht ausführbares Binary, ein belegter Port und ein Klon außerhalb
   `~/browser-control` enden mit Exit `1`, ohne Datei. Beweis:
   `install_withMissingBinary_abortsBeforeWriting`,
   `install_withOpenPort_abortsBeforeWriting`,
   `install_withMissingUnitTarget_abortsBeforeWriting`. Dass Node dafür **nicht**
   mehr befragt wird, belegt `install_withOldNodeOnThePath_ignoresTheVersion`.
5. **Token-Codes wie die Bridge.** Unter 32 Hex-Zeichen ⇒ Exit `2` mit Pfad,
   Datei unverändert; 32–63 Zeichen ⇒ akzeptiert (die Bridge startet damit) mit
   einem Hinweis auf die 64 Zeichen aus `INSTALL.md`. Beweis:
   `install_withTooShortToken_exitsTwo`, `install_withAShortButUsableToken_keepsGoing`.
6. **Das Token bleibt geheim.** Es erscheint beim Anlegen genau einmal, ein
   Reparaturlauf druckt keinen Wert. Sonst steht es nur in der Tokendatei — nicht
   in einer zweiten Datei, nicht in `stderr`, nicht in einem Stub-Log. Beweis:
   `install_printsTheTokenOnce` (zählt vier Stellen);
   `install_printTokenPrintsOnlyTheToken` belegt zusätzlich, dass die Option
   nichts anderes tut; `install_withAnExistingToken_doesNotPrintIt` belegt den
   Reparaturlauf.
7. **`--uninstall` lässt das Token stehen.** Beweis:
   `install_uninstallKeepsTheToken`.
8. **Das Binary liegt dort, wo die Unit es startet, und wird nicht bei jedem
   Lauf neu geschrieben.** `~/.local/bin/browser-control-bridge`, `0755`,
   byte-gleich zum Artefakt; der zweite Lauf lässt die `mtimeNs` stehen, ein
   neuer Build kommt an. Beweis: `install_copiesTheBinaryToLocalBin`; die
   installierte Unit trägt `ExecStart=%h/.local/bin/browser-control-bridge
   --http` (dieselbe Zeile pinnt `test/deploy.test.js`).
9. **Nichts außerhalb der drei Orte, kein `sudo`.** Dynamisch: jede neue Datei
   liegt unter `~/.config/browser-control/`, `~/.config/systemd/user/` oder
   `~/.local/bin/` — dazu die Eltern `~/.config`, `~/.config/systemd` und
   `~/.local`, die `mkdir -p` anlegt (`install_writesOnlyUnderHome`).
   Statisch: der Wächter ist **falsifizierbar** — das Skript lässt sich
   quellen (`if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi`) und ein
   Fall ruft `guard_path /etc/passwd` ⇒ Exit `1`. Dazu
   `grep -cE '(>|>>)[[:space:]]*/(etc|usr|var|opt|srv|root)' scripts/install.sh`
   ⇒ **0** und `grep -c 'sudo' scripts/install.sh` ⇒ **0** — beide **mit**
   Exit-Code geprüft (`… ; echo $?` ⇒ `0` bzw. `1`), sonst ist der Beleg bei
   fehlender Datei scheinbar grün.
10. **Syntax und Abnahme.** `bash -n scripts/install.sh` ⇒ **0**;
    `npm test` ⇒ `# fail 0`, `# cancelled 0`, `# skipped 0` (auf einem Host mit
    nicht-interner IPv4-Adresse — `test/bridge.test.js` überspringt sich sonst
    selbst, unabhängig von diesem Inkrement); `npm run check` ⇒ 0.
11. **Die Doku verweist darauf.** `INSTALL.md` nennt das Skript als **einfachen**
    Weg und die Einzelbefehle als Weg daneben; `README.md` nennt es im
    „Quick start". Beweis: `grep -c 'scripts/install.sh' INSTALL.md` ⇒ **≥ 1**;
    `grep -c 'scripts/install.sh' README.md` ⇒ **≥ 1**.
12. **Kein Produktcode außerhalb der Grenze.** Beweis — die erlaubte Menge
    **und** ein positiver Anker, denn „nur diese Dateien" ist heute schon wahr:
    `git status --porcelain | grep -cE '^(A|\?\?| M) (scripts/install\.sh|test/install\.test\.js)$'`
    ⇒ **2**; `git status --porcelain | grep -vE '^(A|\?\?| M) (scripts/install\.sh|test/install\.test\.js|INSTALL\.md|README\.md|docs/)'`
    ⇒ **keine Ausgabe**; `git diff -- package.json` ⇒ leer; `git diff --
    extension/ bridge/` ⇒ leer.
13. **Die Hilfsoptionen sind belegt.** `--help` nennt die vier Flags, ändert
    nichts und ruft kein `systemctl`. Beweis:
    `install_helpPrintsTheOptionsAndWritesNothing`.
14. **Die Randfälle verhalten sich wie beschrieben.** Unbekannte Option ⇒
    Kurzhilfe und Exit `1`; nicht beschreibbares `$HOME` ⇒ Exit `1` ohne
    Schreiben; ein Token mit zu offenen Rechten wird **gemeldet** und nicht
    korrigiert. Beweis: `install_withUnknownOption_printsHelpAndExitsOne`,
    `install_withUnwritableHome_abortsBeforeWriting`,
    `install_withLooseTokenPermissions_reportsWithoutFixing`.

## Dev plan

**Der Zuschnitt.** Eine neue Datei `scripts/install.sh` bündelt die Schritte aus
`INSTALL.md` §2/§3 zu einem Lauf, und eine neue Testdatei
`test/install.test.js` fährt sie als Prozess mit temporärem `HOME` und Stubs.
Kein Produktcode im engeren Sinn, kein `package.json`-Eingriff, keine neue
Abhängigkeit.

**Was den Plan bindet** (aus den Dateien gelesen, nicht vermutet):

- `deploy/browser-control.service` trug damals
  `ExecStart=/usr/bin/env node %h/browser-control/bridge/bridge.mjs --http`. Mit
  Stufe 4a von `docs/38` trägt sie
  `ExecStart=%h/.local/bin/browser-control-bridge --http` — der feste Pfad ist
  damit `$HOME/.local/bin`, nicht der Klon. Die Unit wird weiter **byte-gleich
  kopiert**, nicht umgeschrieben; ein Klon an anderem Ort bleibt ein
  Vorprüfungsfehler, kein stiller Defekt.
- `test/deploy.test.js` pinnt die Unit-Zeilen und verbietet `/home/` und
  tokenförmige Strings — die *Quelle* bleibt unangetastet, das Skript liest sie
  nur.
- `bridge/config.mjs` (`MIN_TOKEN_LENGTH = 32`, `HEX_ONLY`) und
  `bridge/bridge.mjs` (`token file missing or too short: <pfad>`,
  `process.exit(2)`) sind der Token-Vertrag; Exit `2` im Skript meint dasselbe.
- `bridge/port-owner.mjs` nennt Besitzer über `/proc`, **nicht** über `ss`. Das
  Skript fragt `ss` (Spec) — zwei Wege für dieselbe Auskunft; die Meldung des
  Skripts darf nicht wie die der Bridge aussehen.
- `ss -ltnp` liefert auf diesem Host
  `LISTEN 0 512 127.0.0.1:49374 0.0.0.0:* users:(("opencode",pid=…,fd=8))` —
  genau diese Form muss der `ss`-Stub nachbilden, sonst prüft der Test den Stub.
- `test/ports.js` hält `8110`/`8111` für den Betreiber frei; `test/install.test.js`
  **bindet keinen Port** (nur Stubs) ⇒ kein neuer Eintrag, `test/ports.test.js`
  bleibt unberührt.
- `package.json` (`test/*.test.js`) nimmt die neue Datei automatisch mit;
  `scripts/check.mjs` prüft nur `.js`/`.mjs` ⇒ `install.sh` fällt dort nicht
  hinein.
- Testhaus: `spawnSync`/`mkdtempSync` mit `t.after`-Aufräumen
  (`test/check.test.js`), `spawn(..., { env })` mit **nur** den gesetzten
  Variablen (`test/bridge.test.js`).
- `README.md` („736 cases") und `docs/PROJECT-STATE.md` („736 Tests") werden
  durch die neuen Fälle falsch; die README-Zeile fällt unter Kriterium 11.

**Vier Entscheidungen, die die Spec offenließ** (der Plan legt sie fest):

1. **Token-Schwelle = 32 Hex-Zeichen**, wie `bridge/config.mjs`. Ein Token mit
   32–63 Zeichen wird **akzeptiert** (die Bridge startet damit) und mit einem
   deutschen Hinweis auf die 64 Zeichen aus `INSTALL.md` quittiert; unter 32
   ⇒ Exit `2`. Eine strengere Grenze im Skript wäre ein Fehlalarm: sie würde
   ein Token ablehnen, das die Bridge akzeptiert.
2. **Repo-Pfad-Vorprüfung**: (a) das Unit-Template in `deploy/` ist lesbar,
   (b) `$HOME/browser-control` existiert (dort liegt der Klon, aus dem Binary und
   Unit kommen). Fehlt (b), Exit `1` mit beiden Pfaden. **Nachtrag Stufe 4a**
   (`docs/38`): das frühere `ExecStart`-Ziel `home/browser-control/bridge/bridge.mjs`
   gibt es nicht mehr; an seine Stelle tritt (c) das **Artefakt**
   `<clone>/bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge`,
   vorhanden **und** ausführbar. Folge für die Tests: die Sandbox legt
   `home/browser-control/` mit einem ausführbaren Ersatz-Artefakt an.
3. **Kein `PATH`-Drop-in mehr (Stufe 4a).** Der ursprüngliche Plan wollte mit
   der früheren Option eine `PATH`-Datei schreiben, erster Eintrag
   `%h/.local/share/pi-node/current/bin` oder `dirname "$(command -v node)"`.
   Beides ist mit dem Binary entfallen: die Unit startet einen absoluten Pfad
   und braucht keinen `PATH`. Das Skript kopiert das Artefakt nach
   `$HOME/.local/bin` (`0755`, über eine Staging-Datei und `mv`, damit ein
   laufender Dienst nicht `ETXTBSY` trifft).
4. **Unbekannte Option** ⇒ deutsche Meldung + Kurzhilfe + Exit `1`.

**Schreibgrenze als Mechanik.** Alle Schreibvorgänge laufen durch die zwei
Funktionen mit Pfadwächter — `ensure_dir(path, mode)` und
`put_file(path, mode)` —, die vor dem Schreiben prüfen, dass `path` unter
`$HOME/.config/browser-control/`, `$HOME/.config/systemd/user/` oder
`$HOME/.local/bin/` liegt (samt deren Eltern `$HOME/.config`,
`$HOME/.config/systemd`, `$HOME/.local`), und sonst mit Exit `1` abbrechen. Nur so ist „nichts außerhalb der drei Orte"
eine Eigenschaft des Codes.

---

**1. Gerüst: Optionen, Ausgabe, Exit-Codes, Vorprüfungen — und das Testgerüst**
(Umsetzer)

**Nachtrag Stufe 4a (`docs/38`, 2026-11-17):** die folgenden Zeilen beschreiben
den Stand, in dem diese Stufe gebaut wurde. Mit dem Rust-Binary ist
`check_node_version()` zu `check_binary()` geworden (Artefakt vorhanden **und**
ausführbar, sonst Exit `1` mit dem `cargo build`-Befehl), `parse_args()` kennt
keinen `fix-path`-Modus mehr, die Sandbox legt statt `bridge/bridge.mjs` ein
Ersatz-Artefakt unter `bridge-rs/target/…/release/` an, `runInstall` kommt ohne
`path.dirname(process.execPath)` aus (das Skript ruft kein `node` mehr),
`install_helpPrintsTheOptionsAndWritesNothing` nennt vier Flags und
`install_withOldNode_abortsBeforeWriting` heißt
`install_withOldNodeOnThePath_ignoresTheVersion`.

Dateien: `scripts/install.sh` (neu), `test/install.test.js` (neu).

- `scripts/install.sh`: `#!/usr/bin/env bash`, `set -euo pipefail`; Konstanten
  für die Pfade; `repo_root()` über `${BASH_SOURCE[0]}` (nie `$(pwd)`);
  `usage()`; `parse_args()` mit den Modi `install`, `dry-run`, `print-token`,
  `fix-path`, `uninstall`, `help` (der `fix-path`-Modus ist mit Stufe 4a
  entfallen); `say()/step()/die()`; `guard_path()`;
  `ensure_dir()`/`put_file()` (in dieser Stufe nur definiert, noch kein Aufruf).
- Vorprüfungen **vor** jedem Schreiben, mit Bash-Builtins plus `ss`:
  `check_node_version()` (Major ≥ 22; seit Stufe 4a `check_binary()` — Artefakt
  vorhanden **und** ausführbar), `check_repo_path()` (Entscheidung 2),
  `check_home_writable()`, `check_ports()` (`ss -ltnp`, Ports `8110`/`8111`,
  Besitzer aus `users:(("name",pid=N`; „Besitzer nicht ermittelbar", wenn `-p`
  nichts liefert), `own_service_pid()` (`systemctl --user show
  --property=MainPID --value browser-control`) — ein belegter Port mit der
  `MainPID` des eigenen Dienstes ist **kein** Konflikt.
- `--help`: Exit `0`, keine Vorprüfung, kein Schreibzugriff. `--dry-run`:
  Vorprüfungen laufen, dann je Schritt eine deutsche Zeile, kein
  `systemctl`-Aufruf, kein Schreibzugriff — **auch der Token-Schritt sagt nur
  an** („Token würde angelegt" / „Token bleibt") und bricht nicht mit `2` ab,
  wenn keins da ist. `own_service_pid()` wird nur gefragt, wenn ein Port
  belegt ist; ohne Konflikt ruft der trockene Lauf kein `systemctl`.
- `test/install.test.js`: `makeSandbox(t)` → `{ root, home, stubs, logPath }`
  (`mkdtempSync`, `home/browser-control/bridge/bridge.mjs` angelegt — seit
  Stufe 4a stattdessen `home/browser-control/` mit ausführbarem Ersatz-Artefakt
  unter `bridge-rs/target/…/release/`,
  `t.after` räumt auf); `writeStub(dir, name, body)` (Modus `0o755`);
  `runInstall(sandbox, args, extraEnv = {})` = `spawnSync(BASH, [SCRIPT, ...args],
  { env: { HOME, PATH: [stubs, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  BC_INSTALL_STUB_LOG, ...extraEnv }, encoding: "utf8" })` — nur diese
  Variablen, nie `process.env`; die Stub-Antworten (`BC_INSTALL_STUB_SS`,
  `BC_INSTALL_STUB_IS_ACTIVE`, `BC_INSTALL_STUB_MAINPID`) kommen über
  `extraEnv` je Fall. Jeder Fall ist ein **Top-Level**-`test("install_…"`
  (Spalte 0), sonst liest der Beleg `^test\("` ihn nicht. **`path.dirname(process.execPath)` ist Pflicht:** auf diesem
  Host liegt `node` nicht in `/usr/bin`, ohne diesen Eintrag fände jeder
  Happy-Path-Lauf kein Node und endete mit Exit `1`. Der `v20`-Stub liegt im
  Stub-Verzeichnis und gewinnt durch die Reihenfolge. `readTree(home)` gehört
  deshalb in diese Stufe. Seit Stufe 4a fällt der `PATH`-Eintrag weg — das
  Skript ruft kein `node` mehr, der `PATH` ist `[stubs, "/usr/bin", "/bin"]`.
- Stubs, mit definierten Antworten: `systemctl` protokolliert `--user $*` und
  antwortet je Subkommando — `daemon-reload` ⇒ `0`, `enable …` ⇒ `0`,
  `is-active --quiet` ⇒ `$BC_INSTALL_STUB_IS_ACTIVE` (Default `0`),
  `show --property=MainPID --value` ⇒ `$BC_INSTALL_STUB_MAINPID` (Default
  `4242`), `disable …` ⇒ `0`. Ohne diese Tabelle könnte
  `install_installsAndStartsTheUnit` nicht grün werden, und der
  Fehlerpfad `is-active ≠ 0` wäre unprüfbar. `ss` gibt
  `$BC_INSTALL_STUB_SS` aus; `openssl` erzeugt **zur Laufzeit** 64 Hex-Zeichen
  (`head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'`) und protokolliert den
  Aufruf. **Kein 64-Hex-Literal in der Datei** — es würde den Secret-Grep der
  Abnahme rot machen.
- Fälle: `install_helpPrintsTheOptionsAndWritesNothing` (Exit `0`, die fünf
  Flags `--dry-run`, `--print-token`, `--fix-path`, `--uninstall`, `--help`
  genannt — seit Stufe 4a vier, weil die `PATH`-Option entfällt; `readTree(home)`
  unverändert, keine `systemctl`-Zeile),
  `install_withOldNode_abortsBeforeWriting` (Node-Stub `v20.11.1` ⇒ Exit `1`,
  keine Datei; zweiter Lauf ohne `node` im `PATH` ⇒ dieselbe Meldung; seit
  Stufe 4a umgekehrt: `install_withOldNodeOnThePath_ignoresTheVersion` ⇒ Exit
  `0`),
  `install_withOpenPort_abortsBeforeWriting` (Port `8110` mit fremder PID ⇒
  Exit `1`, Meldung mit Port und PID, kein Token),
  `install_withMissingUnitTarget_abortsBeforeWriting` (Sandbox ohne
  `home/browser-control` ⇒ Exit `1`, keine Datei, Meldung nennt beide Pfade),
  `install_withUnknownOption_printsHelpAndExitsOne`,
  `install_withUnwritableHome_abortsBeforeWriting`,
  `install_guardPathRejectsAPathOutsideTheAllowedSet` (Skript quelbar, Wächter
  direkt auf `/etc/passwd` ⇒ Exit `1`), `install_dryRunWritesNothing` (Exit `0`,
  Schritte genannt, `readTree` gleich, kein `systemctl`).

Proof:

```
bash -n scripts/install.sh; echo $?                                    # ⇒ 0
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_'          # ⇒ 8
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_(help|withOldNode|withOpenPort|withMissingUnitTarget|dryRun|withUnknownOption|withUnwritableHome|guardPath)'   # ⇒ 8
```

---

**2. Das Token — anlegen, prüfen, nie überschreiben** (Umsetzer)

Dateien: `scripts/install.sh`, `test/install.test.js`.

- `token_is_usable()`: Inhalt trimmen, `^[0-9a-f]+$` (case-insensitiv),
  Länge ≥ 32 (Entscheidung 1); zu kurz ⇒ deutsche Meldung mit Pfad, Exit `2` —
  dasselbe Wort „zu kurz" wie `bridge/bridge.mjs`.
- `ensure_token()`: existiert die Datei, wird sie **gelesen und geprüft**, nie
  angefasst; Rechte ≠ `600` werden gemeldet, nicht stillschweigend korrigiert.
  32–63 Zeichen ⇒ Hinweis, weiter. Sonst `umask 077` **in einer Subshell**,
  `openssl rand -hex 32 > "$TOKEN_FILE"`, danach `chmod 600`.
- `--print-token`: Token lesen und nur ausgeben; fehlt es ⇒ Exit `2`.
- Fälle: `install_createsTokenWithTightPermissions` (Datei `600`, 65 Bytes,
  Verzeichnis `700`, Inhalt `^[0-9a-f]{64}\n$`);
  `install_withAnExistingToken_doesNotTouchIt` (`sha256`, `mtimeNs` und Modus
  vor/nach gleich, Ausgabe sagt „bleibt");
  `install_withTooShortToken_exitsTwo` (10 Zeichen ⇒ Exit `2`, Inhalt
  byte-gleich);
  `install_withAShortButUsableToken_keepsGoing` (32 Zeichen, **zur Laufzeit
  gebaut** — `"ab".repeat(16)`, denn ein 32-Hex-Literal macht den Secret-Grep
  der Abnahme rot — ⇒ Exit `0`, Hinweis, Datei unverändert);
  `install_printTokenPrintsOnlyTheToken` (`stdout` ist die Tokendatei, keine
  `systemctl`-Zeile; ohne Token Exit `2`);
  `install_withLooseTokenPermissions_reportsWithoutFixing` (Token `644` ⇒
  Meldung, Modus bleibt `644`).

Proof:

```
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_'          # ⇒ 14
git grep --untracked -nE '[0-9a-f]{32,}' -- scripts/install.sh test/install.test.js              # keine Ausgabe, Exit 1
```

---

**3. Unit installieren, Dienst starten und prüfen — idempotent** (Umsetzer)

Dateien: `scripts/install.sh`, `test/install.test.js`.

- `ensure_unit()`: `ensure_dir "$UNIT_DIR"`; Ziel fehlt ⇒ `put_file` mit dem
  **byte-gleichen** Inhalt von `${repo_root}/deploy/browser-control.service`
  (Modus `644`); Ziel vorhanden und identisch (`cmp -s`) ⇒ Zeile „Systemd-Unit
  ist schon aktuell", kein Schreiben.
- `start_service()`: `daemon-reload`, `enable --now`, dann
  `is-active --quiet`; nicht `active` ⇒ deutsche Meldung mit
  `journalctl --user -u browser-control`, Exit `1`.
- Fälle: `install_installsAndStartsTheUnit` (Datei vorhanden, Log zeigt
  `daemon-reload` vor `enable --now browser-control`, danach `is-active`);
  `install_isIdempotent` (zweiter Lauf: `openssl` genau **einmal**, Unit-
  `mtimeNs` unverändert, Token-`sha256` gleich; der `ss`-Stub meldet im zweiten
  Lauf die `MainPID` des eigenen Dienstes ⇒ kein Konflikt).
- Zwischen den Läufen ≥ 50 ms, damit `mtimeNs` als Beweis trägt.

Proof:

```
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_'          # ⇒ 16
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_(installsAndStartsTheUnit|isIdempotent)'   # ⇒ 2
```

---

**4. `--uninstall` und `--fix-path`** (Umsetzer)

**Nachtrag Stufe 4a (`docs/38`, 2026-11-17): `--fix-path` ist ersatzlos
entfallen** — samt `ensure_dropin()`, dem Drop-in-Verzeichnis und dem zugehörigen
Fall. Die Unit startet ein Binary und braucht keinen `PATH`. `--uninstall`
entfernt weiter nur Dienst und Unit; Binary und Token bleiben liegen. Die
Schritte unten bleiben als Protokoll stehen.

Dateien: `scripts/install.sh`, `test/install.test.js`.

- `uninstall()`: `systemctl --user disable --now` (Fehler tolerieren: ein nie
  gestarteter Dienst ist kein Abbruch), `rm -f` der Unit, `rmdir` des leeren
  Drop-in-Verzeichnisses. `TOKEN_DIR` und `TOKEN_FILE` bleiben.
  **Keine Vorprüfungen** — Entfernen muss auch nach einem Umzug des Klons gehen.
- `ensure_dropin()`: nur im Modus `fix-path`, nur wenn
  `dirname "$(command -v node)"` nicht `/usr/bin` ist; schreibt nur, wenn die
  Datei fehlt oder abweicht.
- Fälle: `install_dryRunUninstallKeepsTheUnit` (`--dry-run --uninstall`: Unit
  bleibt, keine `systemctl`-Zeile im Log, Ausgabe sagt an, was passieren würde);
  `install_uninstallKeepsTheToken` (`disable --now` im Log, Unit weg,
  Token mit gleichem `sha256` und Modus `600` da);
  `install_fixPathWritesTheDropInOnlyWhenNeeded` (mit `--fix-path` und
  Node-Stub außerhalb `/usr/bin`: `path.conf` mit `[Service]` und
  `Environment=PATH=<stubs>:…`; ohne `--fix-path`: kein
  `browser-control.service.d`; zweiter Lauf: `mtimeNs` unverändert).

Proof:

```
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_'          # ⇒ 19
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_(uninstall|fixPath)'   # ⇒ 2
```

---

**5. Grenze und Geheimnis — die zwei Nachweise über den ganzen Lauf**
(Umsetzer)

Dateien: `test/install.test.js` (`readTree()`, `sha256()`, `textFilesUnder()`);
`scripts/install.sh` nur, wenn ein Befund etwas zu reparieren gibt.

- `install_printsTheTokenOnce`: voller Lauf; Token aus der Tokendatei; Vorkommen
  in `stdout` ⇒ `1`, in `stderr` ⇒ `0`, in den Stub-Logs ⇒ `0`, in jeder Datei
  unter `home` **außer** der Tokendatei ⇒ `0`.
- `install_writesOnlyUnderHome`: `readTree(home)` vor/nach; jede **neue** Datei
  und jedes neue Verzeichnis unter den erlaubten Pfaden — `~/.config/browser-control/`,
  `~/.config/systemd/user/` samt `browser-control.service.d/` und die
  Elternverzeichnisse `~/.config`, `~/.config/systemd`, die `mkdir -p` anlegt.

Proof:

```
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_'          # ⇒ 21
grep -c 'sudo' scripts/install.sh; echo $?                                                       # ⇒ 0, Exit 1
grep -cE '(>|>>)[[:space:]]*/(etc|usr|var|opt|srv|root)' scripts/install.sh; echo $?             # ⇒ 0, Exit 1
```

---

**6. Die Doku verweist darauf** (Umsetzer; `INSTALL.md` und `README.md` sind
öffentlich und bleiben englisch)

Dateien: `INSTALL.md`, `README.md`.

- `INSTALL.md`: ein Unterabschnitt am Anfang von §3 (dort, wo Unit und Dienst
  stehen; das Skript deckt §2 und §3 ab) — `./scripts/install.sh`
  als **einfacher** Weg, die Einzelbefehle darunter als der Weg, der zeigt, was
  passiert; Optionstabelle und Exit-Codes `0`/`1`/`2`; der Satz, dass ein
  vorhandenes Token nie überschrieben wird.
- `README.md`: in „Quick start" `./scripts/install.sh` als erster Schritt, die
  Handbefehle als „what it does"; die Testzahl aus der `# tests N`-Zeile des
  Laufs **ablesen**, nicht schätzen.

Proof:

```
grep -c 'scripts/install.sh' INSTALL.md                     # ⇒ ≥ 1
grep -c 'scripts/install.sh' README.md                      # ⇒ ≥ 1
npm test 2>&1 | grep -E '^# (tests|fail|cancelled|skipped)' # tests N; fail/cancelled/skipped = 0
npm run check; echo $?                                      # ⇒ 0
git status --porcelain                                      # nur scripts/install.sh, test/install.test.js, INSTALL.md, README.md
```

Nicht Teil der Stufen: `docs/README.md` (Status-Zeile), `docs/PROJECT-STATE.md`
und `status: active` — das ist Schritt 7 beim Orchestrator.

---

### What had to change in the Acceptance criteria

Acht Punkte waren nicht so prüfbar, wie sie dastanden; sie sind in
`## Acceptance criteria` korrigiert:

1. **Kriterium 12 widersprach Kriterium 11** (`git status` erlaubte `INSTALL.md`
   und `README.md` nicht, obwohl Kriterium 11 sie verlangt) → beide sind jetzt
   in der Liste.
2. **Kriterien 1–9 bewiesen ihre Fälle nicht:** `grep -c 'install_x'` zählt
   einen Namen im Dateitext. Jetzt je Kriterium **zwei** Belege: die scharfe
   Form `grep -cE '^test\("install_x'` ⇒ 1 **und** der grüne Lauf
   `grep -cE '^ok [0-9]+ - install_x'` ⇒ 1.
3. **Kriterium 6/9, „nichts außerhalb":** dynamisch nur innerhalb `$HOME`
   prüfbar → zusätzlich eine statische Probe auf Schreibziele außerhalb
   (`grep -cE '(>|>>)[[:space:]]*/(etc|usr|var|opt|srv|root)'` ⇒ 0).
4. **Kriterium 9, `sudo`:** das Wort darf im Skript **gar nicht** vorkommen —
   auch nicht in einer Ausgabezeile „kein sudo nötig".
5. **Kriterium 8** ist nur halb prüfbar gewesen: den Fall „Node liegt in `/usr/bin`"
   kann ein Stub-Test nicht herstellen (Root nötig). Mit Stufe 4a von `docs/38`
   ist die Frage gegenstandslos — es gibt kein Drop-in mehr, und Kriterium 8
   prüft jetzt das kopierte Binary.
6. **Kriterium 10, `# skipped 0`** ist hostabhängig (`test/bridge.test.js`
   überspringt sich auf Hosts ohne nicht-interne IPv4-Adresse) → Kriterium
   nennt den Abnahme-Host.
7. **`--help` und `--print-token`** standen in der Optionstabelle, aber in
   keinem Fall → zwei Zusatzfälle (`…_helpPrintsTheOptionsAndWritesNothing`,
   `…_printTokenPrintsOnlyTheToken`).
8. **Die Repo-Pfad-Vorprüfung hatte kein Kriterium** → `…_withMissingUnitTarget_abortsBeforeWriting`.

### What could go wrong

- **`grep` unter `set -euo pipefail`.** `ss … | grep -q ':8110'` liefert `1`,
  wenn der Port frei ist, und beendet mit `pipefail` das Skript, bevor es
  schreibt. Jede solche Zeile braucht `|| true` **mit** Kommentar.
- **`umask 077` leckt.** Global gesetzt bekäme die Unit `600` statt `644` — sie
  gehört in eine Subshell um den Token-Schreibvorgang.
- **Das Token im Prozessargument.** Nie als Argument an `openssl`, `systemctl`
  oder `ss`; nur Redirect beim Anlegen, nur die eine `printf`-Zeile beim
  Ausgeben, kein `set -x`.
- **`mtimeNs` als Beweis.** Inhalt allein beweist „nicht neu geschrieben" nicht,
  und grobe Dateisysteme legen zwei Schreibvorgänge in dieselbe Marke → ≥ 50 ms
  zwischen den Läufen und **beide** Zusicherungen.
- **Der `ss`-Stub prüft sich selbst,** wenn er die Spaltenform nicht nachbildet.
  Zusätzlich ein Fall mit `-p`-loser Ausgabe, damit „Besitzer nicht
  ermittelbar" nicht in einen `set -u`-Abbruch läuft.
- **Der tokenförmige String im Repo.** Ein fest verdrahtetes 64-Hex-Token im
  Stub macht den Secret-Grep der Abnahme rot — **und die 32-Zeichen-Grenze
  genügt schon**: der Grep schlägt ab 32 Hex-Zeichen an. Beide Fixtures werden
  deshalb zur Laufzeit gebaut.
- **Sandbox ohne Klon.** Ohne `home/browser-control` samt ausführbarem Artefakt
  scheitert jede Stufe an der Vorprüfung → `makeSandbox` legt beides an, und
  `install_writesOnlyUnderHome` zählt nur **neue** Einträge.
- **Ein laufender Dienst und `ETXTBSY`.** Das Binary wird neben das Ziel
  geschrieben und per `mv` ersetzt; ein `cat > $BIN_FILE` träfe einen
  laufenden Prozess und bräche den Lauf ab. Der Rename hält außerdem davon ab,
  dass eine halb kopierte Datei die ist, die systemd startet.

### Ordering and dependencies

1 → 2 → 3 → 4 → 5 → 6. Stufe 1 legt Wächter, Vorprüfungen und Sandbox an —
**vor** dem ersten Schreibvorgang; ohne sie ist „Vorprüfung vor dem Schreiben"
nicht nachrüstbar. Stufe 2 ist der erste Schreiber (Token); Stufe 3 setzt sie
voraus (ohne Token startet der Dienst nicht). Stufe 4 setzt Stufe 3 voraus.
Stufe 5 prüft das Ganze und darf reparieren, aber keine Funktionen bringen.
Stufe 6 kommt zuletzt, weil die README-Zahl aus dem fertigen Lauf kommt.
Nicht angefasst: `package.json`, `test/ports.js`, `deploy/`, `bridge/`,
`extension/`, `scripts/check.mjs`.

### What the next increment inherits

- **Token-Rotation** als eigener Befehl — hier bewusst nicht (`## Non-goals`).
- **Der echte systemd-Lauf** auf einer fremden Distribution: die Tests prüfen
  Aufrufe, nicht Wirkung.
- **Der `is-active`-Fehlschlag** ist nur im echten Lauf entscheidbar.
- **Klon an anderem Ort als `~/browser-control`**: heute Exit `1` mit Meldung;
  ein `ExecStart=`-Drop-in wäre der saubere Ausweg, ist aber eine eigene Spec.
- **Der Rust-Build** bleibt Handarbeit (`cargo build`, `bridge-rs/README.md`);
  das Skript baut nichts und sagt nur, was fehlt.
- **macOS/Windows, Caddy, `ss`-lose Systeme** bleiben in `## Bekannte Lücken`.

## Bekannte Lücken

Stand 2026-11-17, nach Stufe 4a von `docs/38`. **Eingeordnet am 2026-11-23:** die drei
ungenmessenen Pfade sind Betreiber-Messungen, keine offenen Aufgaben im Code. Der
`/usr/bin`-Zweig von `--fix-path` und der `is-active`-Fehlschlag sind implementiert und
per Stub geprüft; ein echter systemd-Lauf auf einer fremden Distribution braucht einen
zweiten Rechner. Gemessen wird beim nächsten Installationslauf dort, nicht hier.

- **Kein Test gegen ein echtes systemd.** Die Tests prüfen die Aufrufe über
  Stubs; ob der Dienst auf einer fremden Distribution wirklich startet, sagt
  erst der Lauf dort.
- **Nicht abgedeckt: macOS und Windows.** Das Skript ist Linux + systemd.
- **Caddy bleibt Handarbeit** — das Skript kennt keinen Proxy.
- **`~/.local/bin` ist ein dritter Schreibort** (Stufe 4a von `docs/38`). Der
  Pfadwächter deckt ihn, `install_writesOnlyUnderHome` prüft ihn — aber ein
  bereits laufender Dienst wird beim Kopieren nur deshalb nicht angefasst, weil
  das Binary über eine Staging-Datei und `mv` ersetzt wird. Der Dienst läuft bis
  zu seinem nächsten Neustart weiter mit dem alten Inode.
- **`cargo build` ist Vorbedingung, nicht Teil des Skripts.** Ein Test, der einen
  Release-Build startet, wäre Minuten statt Sekunden lang; die Sandbox legt
  stattdessen ein ausführbares Ersatz-Artefakt an.
- **`is-active` schlägt fehl** (Dienst startet nicht): der Pfad ist implementiert
  und dokumentiert, aber kein Test stellt ihn her.
- **Ein Klon außerhalb `~/browser-control`** endet mit Exit `1`; ein
  `ExecStart=`-Drop-in wäre der saubere Ausweg, ist aber eine eigene Spec.
- **`ss` fehlt auf manchen Systemen.** Dann kann der Portbesitzer nicht genannt
  werden; die Spec verlangt eine Meldung, nicht den Namen.

## Open questions

**Keine offenen, die den Bau blockieren.** Entschieden am 2026-11-12 vom
Betreiber: Skript bauen, mit Tests und Review; Firefox-Schritte bleiben
Handarbeit.

## Review

### Code-Review Runde 2 — 2026-11-12: Bedingung erfüllt

Der Code-Review fand einen **Muss**-Befund: `--dry-run --uninstall` löschte
wirklich, weil `uninstall` vor dem Dry-Run-Zweig abgefertigt wurde. Behoben mit
Fall `install_dryRunUninstallKeepsTheUnit` (Mutationsprobe rot); dazu B3–B5
(unlesbare Tokendatei mit Exit `2`, `--uninstall` ohne Token, Trimmen nur an den
Rändern wie die Bridge). Der Reviewer hatte festgehalten: „fix B1 …, dann
`✅ Ship it`" — die Bedingung ist erfüllt und belegt.

### Runde 1 — 2026-11-12, `grizzled-senior-dev`: 🔧 (3 Blocker)

Ziel und Kriterien hat der Betreiber am 2026-11-12 abgesprochen, der Dev-Plan
lag vor, dann ging die Spec durch das Gate. Drei Blocker, sechs Major, elf
Minor, vier Nits — **alle übernommen**; die Einzelzeilen stehen in `## Log`.

## Log

- **2026-11-12, Betreiberentscheid:** Installationsskript bauen (statt nur die
  Anleitung zu kürzen), mit Tests und Review; die Extension bleibt Handarbeit.
- **Runde 1 — B1 übernommen:** die Test-`PATH` enthielt kein `node`; jetzt
  `path.dirname(process.execPath)` plus Stub-Reihenfolge.
- **Runde 1 — B2 übernommen:** `mkdir -p` legt `~/.config` an, also Elternpfade
  in die erlaubte Menge; der frühere dritte Ort (State-Verzeichnis) fällt weg,
  weil ihn keine Stufe schreibt.
- **2026-11-17, Stufe 4a von `docs/38` — Binary statt Node:** `check_node_version()`
  wird `check_binary()` (Artefakt vorhanden **und** ausführbar, sonst Exit `1`
  mit `cargo build --release --target x86_64-unknown-linux-musl`),
  `install_binary()` kopiert nach `$HOME/.local/bin` (`0755`, über eine
  Staging-Datei und `mv`), `guard_path()` bekommt `$HOME/.local/bin` als dritten
  erlaubten Ort, und **die frühere `PATH`-Option entfällt ersatzlos** samt
  Drop-in-Schreiblogik und Testfall. In `test/install.test.js` sind zwei Fälle
  neu (`install_copiesTheBinaryToLocalBin`,
  `install_withMissingBinary_abortsBeforeWriting`, der zweite prüft auch das
  fehlende Ausführungsrecht), `install_withOldNode_abortsBeforeWriting` heißt
  jetzt `install_withOldNodeOnThePath_ignoresTheVersion` und belegt, dass Node
  keine Betriebsvoraussetzung mehr ist. Die Sandbox legt `home/browser-control/`
  mit einem ausführbaren Ersatz-Artefakt an statt `bridge/bridge.mjs`, und
  `runInstall` kommt ohne `path.dirname(process.execPath)` aus. Neue Zahl: **31**
  (`22 install_` + 9 Unit-/`ExecStart_`).
- **Runde 1 — B3 übernommen:** das 32-Zeichen-Fixture wird zur Laufzeit gebaut
  (`"ab".repeat(16)`), sonst wird der Secret-Grep der eigenen Stufe rot.
- **Runde 1 — M1 übernommen:** der Beleg-Baukasten nennt den Datei-Operanden
  (`grep … test/install.test.js`), sonst liest `grep` stdin und zählt `0`.
- **Runde 1 — M2 übernommen:** „vierzehn Befehle in drei Abschnitten" ist durch
  die benannten Abschnitte ersetzt (die Zahl war nicht belegbar).
- **Runde 1 — M3 übernommen:** die Exit-Tabelle nennt alle vier `1`-Ursachen;
  Kombinationen von Modi sind ausgeschlossen.
- **Runde 1 — M4 übernommen:** drei Fälle für unbekannte Option, nicht
  beschreibbares `$HOME` und zu offene Tokenrechte (Kriterium 14).
- **Runde 1 — M5 übernommen:** `--dry-run` sagt den Token-Schritt nur an und
  bricht nicht mit `2` ab; `own_service_pid()` nur bei belegtem Port.
- **Runde 1 — M6 übernommen:** der `systemctl`-Stub hat definierte Antworten je
  Subkommando (`is-active` per Env, `MainPID` per Env).
- **Runde 1 — m1 bis m11 übernommen:** `readTree` in Stufe 1; Kriterium 1 nennt
  beide Fälle; Kriterium 6 stützt sich auf `printsTheTokenOnce`; Wächter wird
  falsifizierbar (Skript quelbar, `guard_path /etc/passwd` ⇒ 1) und die Greps
  werden mit Exit-Code geprüft; Kriterium 12 hat einen positiven Anker; das
  falsche Temp-`HOME`-Muster ist korrigiert; der `/usr/bin`-Zweig ist über
  `existsSync` verzweigt; `STATE_DIR` fällt; die Doku steht in §3; Meldung bei
  belegtem Port nennt `kill <pid>`.
- **Code-Review Runde 1 — B1 übernommen (Muss):** `--dry-run --uninstall`
  löschte die Unit, weil `uninstall` vor dem Dry-Run-Zweig abgefertigt wurde.
  Jetzt sagt der trockene Lauf in **jedem** Modus an, was er täte; Fall
  `install_dryRunUninstallKeepsTheUnit`, Kriterium 3 erweitert.
- **Code-Review Runde 1 — B3 bis B5 übernommen:** unlesbare Tokendatei bekommt
  eine deutsche Meldung mit dem `chmod 600`-Hinweis; `--uninstall` behauptet
  nicht mehr, ein Token zu behalten, wenn keins da ist; das Token wird an den
  Rändern getrimmt wie in der Bridge, nicht innen entkernt.
- **Nits übernommen:** „die fünf Flags" statt „sechs Optionen"; „65 Bytes"
  einheitlich; Runde 1 mit Datum und Verdict; `loginctl enable-linger` bleibt
  außerhalb des Skripts (`## Non-goals`).
- **2026-11-22, laufender Dienst wird neu gestartet.** `enable --now` lässt einen
  aktiven Dienst unangetastet; nach einer Neuinstallation lief deshalb weiter das
  alte Binary (gemessen: 0.7.0 kopiert, der Prozess antwortete mit den Texten von
  0.6.1). `start_service` fragt jetzt `is-active`, nimmt `restart` bei laufendem
  und `start` bei gestopptem Dienst; `enable` bleibt in beiden Wegen. Fälle:
  `install_installsAndStartsTheUnit` (aktiv ⇒ reload, enable, restart, is-active,
  kein `enable --now`) und `install_withAStoppedService_startsItInsteadOfRestarting`
  (gestoppt ⇒ start, kein restart). Der systemctl-Stub führt dafür einen
  Zustand, damit `is-active` nach dem Start `0` meldet.
- **2026-11-26, nachgezogen aus `docs/68`.** Ein Lauf, der ein vorhandenes Token
  vorfindet, druckt den Wert nicht mehr; nur der Lauf, der das Token anlegt, zeigt
  es — einmal, mit dem Zusatz `später nur mit --print-token`. Schritt 5 nennt
  stattdessen `--print-token` mit absolutem Pfad; Schritt 2 behält seine Meldung
  `Token bleibt unverändert`. Die Testing-Liste trägt
  `install_withAnExistingToken_doesNotPrintIt` und
  `install_withAStoppedService_startsItInsteadOfRestarting`, und die Zählung in
  `## Ziel` nennt 24 `install_`-Fälle (33 mit den neun Unit-Fällen).
