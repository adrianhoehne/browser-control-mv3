---
description: Der Bridge-Prozess läuft auf Windows ohne systemd und ohne /proc, startet aus einer Konsole und endet dort geordnet — Teil 1b, im Rust-Port gebaut (Ctrl+Break, stilles stdio im Terminal, Portbesitzer über GetExtendedTcpTable), aufbauend auf Spec 29.
status: active
---

# Windows-Betrieb, Teil 1b: der Prozess und die Konsole

Der Betreiber will pi, die Bridge und Firefox auf **einem Windows-Rechner**. Diese
Spec ist der zweite Teil davon: der Bridge-Prozess startet dort aus einer
**Konsole**, arbeitet und endet geordnet. Er ist nicht auf einen Dienst angewiesen;
der Dienst bleibt eine Option, die weiter funktionieren muss.

**Voraussetzung: `docs/29-windows-betrieb.md`.** Dort wandert `npm run check` auf
ein Node-Skript — ohne das gibt es auf Windows keine Abnahme, und alle Proof-Zeilen
hier benutzen den Befehl.

Diese Spec ist am 2026-11-06 aus einer gemeinsamen Fassung herausgeteilt worden,
nachdem das Spec-Gate sie in der dritten Runde erneut blockiert hatte; die Blocker
betrafen genau diesen Teil (siehe `## Review` und `## Log`).

**Nachtrag 2026-11-17 (der Schnitt, `docs/38` Stufe 4b):** die Node-Bridge ist
gelöscht, betrieben wird `browser-control-bridge` (`bridge-rs/`). Die Dateinamen
`bridge/*.mjs` unten sind der Stand, gegen den diese Spec geschrieben wurde; das
Verhalten ist portiert — die Signal- und stdin-Regeln stehen in
`bridge-rs/src/main.rs` und `bridge-rs/src/stdio.rs`, der Portbesitzer in
`bridge-rs/src/platform/windows.rs` (`GetExtendedTcpTable`). Node bleibt nur für
`npm test`, `npm run check` und `scripts/parity.sh`. Die Startbefehle unten nennen
deshalb das Binary; der Weg über den Task Scheduler steht in
`deploy/windows/browser-control-bridge.xml`.

**Stand 2026-11-18: gebaut und abgenommen, im Rust-Port.** Zwei Dinge fehlten noch, beide
sind jetzt drin: `Strg+Untbr` beendet die Bridge wie `Strg+C`
(`bridge-rs/src/main.rs:422`–`:423`, Zeile `received SIGBREAK, shutting down`, Exit 0), und
das MCP über stdio schweigt in einer Konsole (`main.rs:129`, `bridge-rs/src/stdio.rs:186`).
Portbesitzer auf Windows, Startzeilen, Exit-Codes und die Besitzerzeile waren schon mit
`docs/38` Stufe 3 gebaut. Die Node-Dateien, gegen die diese Spec geschrieben wurde, gibt es
nicht mehr; was an den Abschnitten unten überholt ist, ist dort markiert, und
`## Prüfung gegen den Rust-Stand` nennt je Punkt und je Kriterium den Beleg. Offen bleibt
die Messung auf einem Windows-Rechner (Kriterien 1, 5 und die Windows-Hälfte von 7) — das
ist Betreiberarbeit, nicht Code.

## Ziel

- **Die Konsole ist der Normalfall, der Dienst die Option.** Die Bridge läuft im
  Vordergrund eines Terminals und endet mit `Strg+C`; sie braucht keinen Dienst, keinen
  Autostart und kein Hintergrundprogramm.
- **Konsole heißt: stdout bleibt still.** Im Vordergrundbetrieb darf das MCP über
  stdio nicht mitlaufen. **Gebaut am 2026-11-18:** der stdio-Dienst startet nur, wenn
  stdin **keine Konsole** ist (`main.rs:129`, `stdio::stdin_is_a_console` in
  `bridge-rs/src/stdio.rs:186`). In der Node-Vorlage lief er unbedingt; die Datei ist mit
  `docs/38` gelöscht.
- **Geordnetes Ende.** `Strg+C` liefert `SIGINT`, und den Handler gibt es seit dem
  ersten Inkrement — das ist Bestand (`main.rs:422`). Neu ist `SIGBREAK`
  (`Strg+Untbr`), das Windows zusätzlich kennt, und die Ehrlichkeit im Kommentar,
  dass `SIGTERM` dort nie vom System kommt (erst ein Dienst-Wrapper in Teil 2
  entscheidet, was er schickt). **Gebaut am 2026-11-18:** `ctrl_break` neben `ctrl_c`
  (`main.rs:423`), beide Arme schreiben dieselbe Zeile und enden mit 0. `docs/38`
  Stufe 3 hatte `SIGBREAK` bewusst ausgelassen, um zeichengleich zur Vorlage zu bleiben;
  der Paritätsmaßstab läuft auf Linux und sieht keinen der beiden Handgriffe.
- **Der Konflikt wird benannt, nicht verhindert.** Läuft der Dienst, endet ein
  zweiter Start mit Exit 1 und der Zeile, die den Portbesitzer nennt — oder, wo das
  nicht ermittelbar ist, die sagt, dass er es nicht ist. Kein Portwechsel, kein
  stiller Doppelbetrieb.
- **Blind heißt ehrlich.** Die Besitzersuche antwortet nur, wenn sie es weiß; jeder
  Zweifel ergibt „Besitzer nicht ermittelbar" statt eines erfundenen PID
  (`main.rs:339`, `bridge-rs/src/platform/windows.rs:6`–`:8`). **Auf Windows liest sie
  inzwischen wirklich** (`GetExtendedTcpTable`, `platform/windows.rs:63`), die Zeile nennt
  dort also meist einen Namen — der ehrliche Zweifelsfall bleibt.
- **Dieselbe Abnahme.** Die Bridge hat ihre Liste in **`cargo test`**
  (`--test-threads=1`), Erweiterung und Skripte in `npm test`, das Verhalten gegen die
  eingefrorenen Artefakte in `scripts/parity.sh --impl rust --check`. Was plattformbedingt
  nicht prüfbar ist, wird benannt statt stillschweigend übersprungen. (Ursprünglich stand
  hier „`npm test` bleibt auf beiden Plattformen eine Liste" — das galt, solange die
  Bridge in Node lief.)

## Prüfung gegen den Rust-Stand (2026-11-18)

Diese Spec wurde am 2026-11-06 gegen die **Node-Bridge** geschrieben (`bridge/bridge.mjs`).
Seit `docs/38` Stufe 4b gibt es die nicht mehr; betrieben wird `browser-control-bridge`
(`bridge-rs/`). Deshalb wurde jeder Punkt und jedes Kriterium **vor** dem Bau gegen den
Rust-Stand geprüft. Soll (`gilt`) und Ist (`erfüllt`) sind getrennt gehalten; „überholt"
heißt: der Satz hat kein Subjekt mehr, weil die Datei oder der Prüfweg verschwunden ist.

`## Ziel` trägt **sechs** Punkte, nicht sieben.

| Ziel-Punkt | Verdikt | Beleg |
|---|---|---|
| Die Konsole ist der Normalfall, der Dienst die Option | **gilt, erfüllt** | `--http` ist ein reines Flag (`main.rs:48`, `:252`); der Start braucht keinen Dienst (`INSTALL.md` § 10.4) |
| Konsole heißt: stdout bleibt still | **war offen, jetzt gebaut** | `main.rs:129` startet stdio nur bei `!stdin_is_a_console()`; `stdio.rs:186` fragt `IsTerminal` — bis 2026-11-18 lief `stdio::serve` unbedingt |
| Geordnetes Ende (`SIGINT`, `SIGBREAK`, ehrliches `SIGTERM`) | **`SIGINT` erfüllt, `SIGBREAK` gebaut** | `main.rs:422` (`SIGINT`), `:423` (`SIGBREAK`); der Kommentar `main.rs:377`–`:391` sagt, dass `SIGTERM` auf Windows nie vom System kommt |
| Der Konflikt wird benannt, nicht verhindert | **erfüllt** | `main.rs:331`–`:341` schreibt zwei Zeilen und endet mit 1 (`:97`–`:98`, `:312`–`:313`); Paritätsvergleich 5 pinnt die Besitzerzeile |
| Blind heißt ehrlich | **erfüllt, teils überholt** | Zweifel ⇒ „Besitzer nicht ermittelbar" (`main.rs:339`); auf Windows wird jetzt wirklich gelesen (`platform/windows.rs:63`) |
| Dieselbe Abnahme | **überholt im Wortlaut, erfüllt im Geist** | Bridge: `cargo test` (283 Fälle, 0 failed); Erweiterung und Skripte: `npm test` (522, `# fail 0`); Verhalten: Parität 7/7 |

| Kriterium | Verdikt | Beleg |
|---|---|---|
| 1 Start und Ende auf Windows | **gilt; Code belegt, Lauf = Betreiber** | Token-Vorbedingung: `config.rs:26`, `:75`, `:106`, Exit 2 in `main.rs:70`–`:73`; Startzeilen `main.rs:101`–`:104`, `:305`–`:308`; `Strg+C` ⇒ `main.rs:422`, `Strg+Untbr` ⇒ `:423`, beide über `main.rs:187` nach 0. Windows-Lauf: `INSTALL.md` § 10.4, Proben in `bridge-rs/README.md`, `## Windows` |
| 2 Dieselbe Abnahme | **erfüllt, Wortlaut überholt** | `npm test` ⇒ 522 Fälle, `# fail 0`, `# cancelled 0`, `# skipped 0`; `npm run check` ⇒ 0; Secret-grep ohne Ausgabe; `git status --porcelain extension/manifest.json` leer; dazu `cargo test` 283/0 failed und Parität 7/7. Die Zahl `# tests N` beider Läufe gegeneinander zu halten hat kein Subjekt mehr — die Bridge steht nicht mehr in der Node-Suite |
| 3 Übersprungen wird gezählt | **überholt** | `test/bridge.test.js` existiert nicht mehr; die zwölf `skip:`-Zeilen von damals sind mit den Dateien verschwunden. Die zwölf heutigen Treffer in `test/` sind `bundle_`/`package_`-Fälle, die ohne gebaute Zips übersprungen werden (`test/bundle/bundle.test.js:228`); lokal `# skipped 0` |
| 4 `port-owner` erfindet nichts | **erfüllt, auf Rust gezogen** | `platform::find_port_owner` gibt `Option<PortOwner>` (`platform/mod.rs:42`), `main.rs:339` schreibt ohne Fund „Besitzer nicht ermittelbar" und keinen PID; Paritätsvergleich 5 pinnt die gemischtsprachige Zeile mit Besitzer |
| 5 Der MCP-Pfad antwortet auf Windows | **gilt; Code belegt, Lauf = Betreiber** | `tools/list` **ohne** `initialize`: `tests/http.rs:398` (`http_startHttpTransport_withToolsListAndValidToken_shouldAnswer200WithApplicationJson`) und Paritätsvergleich 1; der Windows-Aufruf steht in `INSTALL.md` § 10.6 |
| 6 Die Linux-Anleitung bleibt gültig | **überholt** | `INSTALL.md` ist mit `docs/41` neu geschrieben; „Nicht dauerhaft" und „(empfohlen)" gibt es nicht mehr (`grep` leer), ein Diff-Zähler hat kein Subjekt. An ihre Stelle tritt § 10 |
| 7 Die Konsole schweigt | **lokal erfüllt; Windows-Hälfte = Betreiber** | Entscheidung `stdio.rs:186` + `main.rs:129`; der Client-Pfad bleibt offen — `tests/bridge.rs:749` (`mcp_whenStdinEnds_shouldExitZeroAfterASingleShutdownLine`, Pipe) und 114 Fälle in `tests/mcp.rs`; Parität 1–3. Windows: `INSTALL.md` § 10.4 („stdout stays empty") |
| 8 Der Dienst bleibt eine Betriebsart | **erfüllt** | `test/deploy.test.js:27` pinnt `ExecStart=%h/.local/bin/browser-control-bridge --http`; `tests/bridge.rs:840` (`mcp_withAnIgnoredStdin_shouldKeepRunningAndListeningAfterTheEof`) beweist `/dev/null` ⇒ die Bridge läuft weiter. Die Unit wurde nicht angefasst |

## Non-goals

- **Kein Dienst-Ersatz in dieser Spec.** Autostart war hier ausdrücklich Teil 2;
  **erledigt durch `docs/38`** (Stufe 3): `deploy/windows/browser-control-bridge.xml`
  startet die Bridge als Task-Scheduler-Aufgabe (`AtLogOn`, `InteractiveToken`,
  `LeastPrivilege`) — ohne NSSM, ohne WinSW, ohne Adminrechte.
- **Keine Endpunkt-Entscheidung.** Ob die Extension auf demselben Rechner
  `ws://127.0.0.1:8110` (ohne TLS) oder `wss://` über einen lokalen Caddy spricht,
  ist Teil 2 und eine Sicherheitsfrage.
- **Keine Änderung an der Extension** — kein `extension/*`, kein `manifest.json`.
- **~~Keine Windows-Implementierung von `port-owner`~~ — erledigt durch `docs/38`.**
  `bridge-rs/src/platform/windows.rs` liest den Besitzer über `GetExtendedTcpTable`
  und `QueryFullProcessImageNameW`, also ohne Unterprozess (der Grund, aus dem diese
  Zeile `netstat` ausgeschlossen hatte, gilt weiter: kein `netstat`-Parser, kein
  `Get-NetTCPConnection`). Der Lauf auf Windows ist eine Betreiber-Messung
  (`bridge-rs/README.md`, `## Bekannte Lücken`).
- **Kein WSL, kein Container, keine zweite Betriebsart.** Windows ist ein
  zusätzlicher Wirt für denselben Prozess, kein neuer Pfad im Code.
- **Kein Abschaffen des stdio-Rückfallwegs.** Wer die Bridge als Kind von pi startet
  (`INSTALL.md`, „Rückfallweg: stdio"), soll das weiter können; geändert wird nur,
  **wann** stdio im Vordergrund anspringt.
- **Kein Umbau von `test/mcp.test.js`** und keine Änderung an der Testfrist (offene
  Frage 2).
- **Der Server läuft nicht in der Firefox-Erweiterung.** Das wurde am 2026-11-06
  geprüft und verworfen: WebExtensions haben keine API, um auf einem TCP-Port zu
  lauschen (die Extension wählt sich deshalb seit dem ersten Inkrement raus), und
  pis MCP-Client lädt einen Server nur als Prozeß (`command`) oder als URL (`url`) —
  eine Browser-Erweiterung ist keins von beidem. Drei Module bleiben getrennt.
- **Kein Zusammenlegen in pi hinein.** Zwei Wege wurden am 2026-11-06 abgewogen und
  vom Betreiber zugunsten der getrennten Module verworfen: **A** — pi spawnt die
  Bridge über `mcp.json` mit `command`/stdio (kein neuer Code, aber der
  Portbesitz-Zustand von vor Spec 18 kehrt zurück: zwei pi-Sitzungen, verwaiste
  Bridge nach einem Absturz); **B** — eine pi-Extension hält den Hub in-process und
  registriert die Werkzeuge über `pi.registerTool` (kein MCP, kein Kindprozeß, aber
  neue Spec, und die Leader-Frage bei zwei Sitzungen bleibt). Die Begründung steht
  in `docs/ROADMAP.md`, Zeile 31.

## Wo die Änderung sitzt

**Überholt (2026-11-18).** Die Tabelle beschreibt die Node-Dateien, gegen die diese Spec
am 2026-11-06 geschrieben wurde; sie sind mit `docs/38` Stufe 4b gelöscht. Was tatsächlich
eingebaut wurde, steht in `## Was gebaut wurde`.

| Datei | Heute | Danach |
|---|---|---|
| `bridge/bridge.mjs` | `installShutdownHandlers` hört auf `SIGTERM` und `SIGINT` (`:161`–`:162`); `stdinIsClientChannel` fragt `isFIFO()`/`isSocket()` (`:183`); `startMcpServer` läuft unbedingt (`:245`); `main()` läuft beim Import (`:286`), es gibt **keinen** Export; die Port-Zeile entsteht privat in `logBindFailure`/`describePortOwner` (`:87`–`:99`) | Signalliste statt zwei fester Zeilen (`SIGBREAK` auf `win32`); stdio nur, wenn `process.stdin.isTTY` falsch ist; `portInUseLine` exportiert und mit injizierbarer Besitzersuche; ein Wächter macht die Datei importierbar |
| `test/bridge.test.js` | 4 `skip:`-Zeilen (`:592`, `:624` und zwei `/proc`-Fälle), 6 `SIGTERM`-Fälle (`:368`, `:404`, `:432`, `:463`, `:500`, `:529`) | die 6 Signal-Fälle tragen `{ skip: SKIP_ON_WINDOWS }`, dazu ein `SIGINT`-Fall und drei Unit-Fälle (`mcpStdioEnabled`, `portInUseLine`) |
| `test/http-mcp.test.js` | ein `SIGTERM`-Fall (`:356`) | derselbe Skip; sonst unverändert |
| `CONTRIBUTING.md`, `## Acceptance` | eine Liste ohne Plattformhinweis | ein Absatz darunter, welche Zeile plattformabhängig ist; keine bestehende Zeile geändert |
| `INSTALL.md` | `## 3` sagt „Nicht dauerhaft", `## 5` heißt „(empfohlen)" | zwei Empfehlungszeilen gedreht, ein Abschnitt am Ende; **keine Befehlszeile** in `## 1`–`## 6` geändert |
| `docs/18-dienst-und-http-mcp.md` | `:351`–`:354`: „`startMcpServer` läuft unbedingt weiter" | die Amendments unten; `docs/README.md` verlangt die Nachziehung in der Stufe, die das Verhalten umsetzt |

## Was gebaut wurde (2026-11-18)

Zwei Änderungen, beide dort, wo das Verhalten entschieden wird — nicht in einem neuen
Modul:

- **`bridge-rs/src/main.rs:129`** startet den stdio-Dienst nur noch, wenn stdin **keine
  Konsole** ist. `join_stdio` (`:274`) hält den `select!`-Zweig für den Fall still, dass es
  ihn nicht gibt — dieselbe Form wie `join_transport`. Grund: in der Konsole ist stdin die
  Tastatur des Betreibers, und die Vorlage antwortete dem ersten Tastendruck auf dem
  JSON-RPC-Kanal mit einem Parse-Fehler.
- **`bridge-rs/src/main.rs:422`–`:423`** beendet bei `Strg+C` **und** `Strg+Untbr`:
  `ctrl_c` und `windows::ctrl_break` in einem `tokio::select!`; beide schreiben dieselbe
  Zeile (`received SIGINT, shutting down` bzw. `received SIGBREAK, shutting down`) und
  laufen in denselben Exit-0-Pfad (`:187`).
- **`bridge-rs/src/stdio.rs:186`** liefert die Entscheidung als Funktion
  (`stdin_is_a_console`, `std::io::IsTerminal`, ohne `cfg`). Sie steht neben der anderen
  stdin-Frage (`stdin_is_client_channel`, `:204`/`:241`/`:263`), weil beide dasselbe
  betreffen: was Deskriptor 0 gerade ist.

Nicht angefasst: die Unix-Signalarme (`main.rs:344`–`:376`), die Portbesitzer-Suche beider
Plattformen, `Cargo.toml` (die `signal`-Feature trägt `ctrl_break` schon), jede Datei unter
`extension/` und die Unit.

## Testing

**Was heute gilt (2026-11-18).** Geprüft wird im Rust-Port und gegen den Paritätsmaßstab;
die Node-Fälle der ursprünglichen Fassung sind mit ihren Dateien verschwunden.

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/bridge.rs:749` | `mcp_whenStdinEnds_shouldExitZeroAfterASingleShutdownLine` | Ein Client, der stdin schließt (Pipe), bekommt Exit 0 und **genau eine** Zeile `stdin closed, shutting down` — das Gate schließt den Client-Pfad nicht mit |
| `bridge-rs/tests/bridge.rs:799` | `mcp_whenStdinEndsWithAConnectedExtension_shouldAlsoExitZeroWithOneShutdownLine` | dasselbe mit verbundener Extension |
| `bridge-rs/tests/bridge.rs:840` | `mcp_withAnIgnoredStdin_shouldKeepRunningAndListeningAfterTheEof` | `/dev/null` auf stdin (systemd) beendet nichts — Kriterium 8 |
| `bridge-rs/tests/http.rs:398` | `http_startHttpTransport_withToolsListAndValidToken_shouldAnswer200WithApplicationJson` | `tools/list` **ohne** `initialize` — Kriterium 5 |
| `test/deploy.test.js:27` | `REQUIRED_LINES` | der Dienstweg bleibt `ExecStart=%h/.local/bin/browser-control-bridge --http` |
| `cargo build`/`cargo clippy` mit `--target x86_64-pc-windows-gnu` | Bau und Lint | die Windows-Zweige (`ctrl_break`, `GetExtendedTcpTable`, `GetFileType`) übersetzen und sind lint-frei |
| `scripts/parity.sh --impl rust --check` | sieben Vergleiche | Startzeilen, Besitzerzeile, Exit-Codes und Logzeilen zeichengleich |

**Nicht lokal prüfbar**, deshalb Betreiber-Messung: dass `Strg+C` und `Strg+Untbr` in einem
echten Konsolenfenster ankommen und dass stdout dort 0 Byte bleibt. Ein PTY ist kein
Werkzeug, das diese Spec voraussetzen darf — der Fehler „stdio startet *immer*" würde von
keinem lokalen Fall gefangen.

**Die Tabelle der Node-Fassung (überholt, nur als Geschichte):**

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/bridge.test.js` | `mcpStdioEnabled` mit `{ isTTY: true }` ⇒ falsch, mit `{}` und mit Pipe-stdin ⇒ wahr | die Entscheidung „stdio im Terminal aus" ist gepinnt; ein echtes PTY gibt es ohne Fremdprogramm nicht (siehe `## Bekannte Lücken`) |
| `test/bridge.test.js` | `portInUseLine` mit `lookup: () => null` ⇒ `port 127.0.0.1:8110 in use, Besitzer nicht ermittelbar` ohne `pid=`; mit `lookup: () => ({ pid: 42, name: "node" })` ⇒ `… owner pid=42 name=node` | Kriterium 4 ist ohne `/proc` prüfbar |
| `test/bridge.test.js` | `shutdownSignalNames` nennt auf `win32` zusätzlich `SIGBREAK`, auf POSIX nicht | die Signalliste ist Daten, nicht Branch-Logik |
| `test/bridge.test.js` | `bridge_withSIGINT_shouldExitZeroAndLogTheShuttingDownLine` — Exit 0 und `received SIGINT, shutting down`; **auf Windows übersprungen**, Grund im `skip`-Text | das geordnete Ende ist auf POSIX belegt und auf Windows eine Betreiber-Messung |
| `test/deploy.test.js` | `REQUIRED_LINES` pinnt `ExecStart=%h/.local/bin/browser-control-bridge --http`; unverändert grün | der Dienstweg bleibt intakt, während die Konsole der Normalfall wird |
| `test/mcp.test.js` | der Pipe-stdin-Weg bleibt grün (139 Fälle, inklusive `initialize`) | der stdio-Rückfallweg für pi ist unberührt |
| `npm test` | `# fail 0`, `# cancelled 0`, lokal `# skipped 0` | auf Linux versteckt sich nichts; auf Windows erscheint `# skipped N` mit N ≥ 12 (Betreiber) |

## Acceptance criteria

**Ausnahme mit Datum** (2026-11-06, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 1, 3b, 5 und
die Windows-Hälfte von 7 sind nur auf einem Windows-Rechner messbar und werden vom
Betreiber abgehakt — das ist der allgemeine Satz aus `## Acceptance` („wo ein Kriterium
nur im echten Profil entscheidbar ist, steht das dort"), **nicht** die Ausnahme vom
2026-10-23, die Messungen nach dem Commit erlaubt. Kriterium 2 braucht beide Läufe.
**Diese Liste gilt überall in dieser Spec**, auch in `## Bekannte Lücken` und Stufe 4.

**Alle Kriterien laufen in Git Bash**, nicht in `cmd.exe` — außer den zwei
Halbsätzen, die ein echtes Konsolenfenster brauchen und es dort sagen (`Strg+Untbr`
in Kriterium 1, der Tastendruck in Kriterium 7). Pfade werden mit
Vorwärtsschrägstrichen geschrieben.

**Stand 2026-11-18:** Kriterium 4, 7 (lokal) und 8 sind erfüllt, Kriterium 2 ist in der
Rust-Form erfüllt, die Betreiber-Hälften von 1, 5 und 7 bleiben offen, und **Kriterium 3
und 6 sind überholt** (kein Subjekt mehr). Die Belege je Kriterium stehen in
`## Prüfung gegen den Rust-Stand`; der Text darunter bleibt das, was am 2026-11-06
verlangt wurde.

1. **Start und Ende auf Windows** (Windows, Betreiber). **Vorbedingung: die
   Token-Datei existiert.** Default-Pfad `%USERPROFILE%\.config\browser-control\token`
   (`bridge/config.mjs:107`–`:111`), Inhalt hex, mindestens 32 Zeichen
   (`:133`–`:134`); ohne sie endet der Prozess mit `token file missing or too short`
   und **Exit 2** (nachgeprüft am 2026-11-06). Anlegen ohne `openssl` und ohne `>`
   (PowerShell schreibt sonst UTF-16 mit BOM):

   ```powershell
   node -e "const f=require('fs'),p=require('path'),d=path.join(process.env.USERPROFILE,'.config','browser-control');f.mkdirSync(d,{recursive:true});f.writeFileSync(path.join(d,'token'),require('crypto').randomBytes(32).toString('hex'))"
   ```

   Dann, mit sichtbarem Exit-Code: `%LOCALAPPDATA%\browser-control\browser-control-bridge.exe --http; echo "exit=$?"`.
   Der Prozess schreibt `listening on 127.0.0.1:8110 …` und
   `listening on 127.0.0.1:8111 for POST /mcp`; `Strg+C` beendet ihn mit
   `received SIGINT, shutting down` und `exit=0`, dasselbe mit `Strg+Untbr` in einem
   **echten Konsolenfenster** (Windows Terminal oder `cmd.exe`; in mintty kommt
   `SIGBREAK` nicht an) und `received SIGBREAK, shutting down`. Danach sind beide
   Ports frei: `netstat -ano | findstr LISTENING | findstr ":8110 :8111"` ⇒ keine
   Ausgabe.
2. **Dieselbe Abnahme** (lokal und Windows). `npm test` endet mit `# fail 0` und
   `# cancelled 0`; die Zahl `# tests N` beider Läufe wird **gegeneinander**
   verglichen (keine Konstante — sie wandert mit jedem Inkrement); `npm run check`
   gibt 0 zurück (Spec 29); der Secret-grep
   (`git grep --untracked -nE '[0-9a-f]{32,}' -- .`) bleibt ohne Ausgabe;
   `git status --porcelain extension/manifest.json` ist leer. Die Testzahl ist Teil
   des Kriteriums, weil `# fail 0` allein auch für einen Lauf gilt, der keine Datei
   gefunden hat.
3. **Übersprungen wird gezählt, nicht versteckt.** *(überholt, siehe `## Prüfung`)* (a) Lokal: `npm test` meldet
   `# skipped 0`, und `git grep -n "skip:" -- test/` nennt **zwölf Quellzeilen**
   (gezählt werden Zeilen, nicht Fälle — der Laufzeit-Skip in `bridge.test.js:534`
   erscheint dort nicht): vier mit `/proc`-Begründung, acht mit Signal-Begründung.
   (b) Windows, Betreiber: `# skipped N` mit **N ≥ 12** und `# fail 0` — nicht bloß
   N > 0, sonst bestünde ein Lauf, der alles überspringt.
4. **`port-owner` erfindet nichts** (lokal). Ein Bind auf einem belegten Port
   schreibt `port 127.0.0.1:<port> in use, Besitzer nicht ermittelbar` und keinen
   PID, wenn die Besitzersuche `null` liefert. Dafür wird die Zeilenbildung aus
   `bridge.mjs` exportiert und in einem Test mit einer ersetzten Suche aufgerufen.
   Die Mischung aus englischem Port-Satz und deutschem Besitzer-Satz ist **Bestand
   und Vertrag** — sie wird gepinnt, nicht übersetzt.
5. **Der MCP-Pfad antwortet auf Windows** (Windows, Betreiber). `tools/list`
   antwortet **ohne** vorheriges `initialize`: am 2026-11-06 gegen eine Bridge auf
   Port 18111 gemessen, und `test/http-mcp.test.js:363` schickt es ebenfalls ohne.

   ```bash
   curl -s -X POST \
     -H "Authorization: Bearer $(cat ~/.config/browser-control/token)" \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     http://127.0.0.1:8111/mcp | grep -o '"browser_[a-z_]*"' | sort -u | wc -l
   ```

   ⇒ `12`. Das beweist „läuft", nicht nur „startet" — und umgeht die Endpunkt-Frage
   aus Teil 2.
6. **Die Linux-Anleitung bleibt gültig** *(überholt, siehe `## Prüfung`)* (lokal). Keine **Befehlszeile** in `## 1`
   bis `## 6` ändert sich. Erlaubt sind genau **zwei** geänderte Textzeilen — die
   Empfehlung in `## 3` („Nicht dauerhaft") und die Überschrift von `## 5`
   („(empfohlen)") —, weil die Reihenfolge sich dreht. Prüfung:
   `git diff -U0 INSTALL.md | grep -E '^-[^-]' | wc -l` ⇒ **2** (nicht „höchstens
   zwei"), und in keiner der beiden steht ein Kommando. Alles Weitere ist neu.
7. **Die Konsole schweigt** (lokal die Entscheidung, Windows die Wirkung). Lokal:
   die zwei `mcpStdioEnabled`-Fälle (TTY ⇒ stdio aus, Pipe ⇒ stdio an) und
   `test/mcp.test.js` (139 Fälle über stdin) bleibt grün. Windows, Betreiber, **im
   Vordergrund und mit getrennten Strömen** — als Hintergrundauftrag hat der Prozess
   kein TTY und würde genau den stdio-Zweig starten, den dieses Inkrement
   ausschließt:

   ```
   :: in Windows Terminal oder cmd.exe, Vordergrund, zwei Fenster oder Umleitung:
   %LOCALAPPDATA%\browser-control\browser-control-bridge.exe --http 1>out.log 2>err.log
   ```

   In `err.log` stehen die zwei `listening`-Zeilen, `out.log` bleibt **0 Byte**, und
   ein Tastendruck im Konsolenfenster ändert daran nichts. Der Unterschied ist real
   und belegt: mit einem PTY als stdin schreibt die Bridge heute bei der ersten
   Tastatureingabe `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse
   error"}}` auf stdout (vom Reviewer am 2026-11-06 gemessen).
8. **Der Dienst bleibt eine Betriebsart** (lokal, ohne Eingriff in diese Sitzung).
   Beleg sind die Fälle, die den Dienstweg wirklich pinnen: `test/deploy.test.js`
   (`REQUIRED_LINES` enthält `ExecStart=%h/.local/bin/browser-control-bridge --http`)
   und die stdin-Regel mit einem
   stdin, das kein TTY ist — der Dienst setzt `StandardInput=` nicht, bekommt also
   `/dev/null`, und dort muss der stdio-Server **weiter** starten. Die Unit wird
   **nicht** gestoppt: das kappte die Verbindung, über die pi in dieser Sitzung den
   Browser erreicht.

## Dev plan

**Überholt (2026-11-18).** Der Plan unten baut die Node-Bridge um (`bridge/bridge.mjs`,
`test/bridge.test.js`); diese Dateien sind mit `docs/38` gelöscht, und keine seiner fünf
Stufen wurde so ausgeführt. Gebaut wurde in zwei Schritten, beschrieben in
`## Was gebaut wurde`: (1) `SIGBREAK` und das stdio-Gate in `main.rs`/`stdio.rs`,
(2) diese Spec und die Register (`docs/README.md`, `docs/ROADMAP.md`,
`docs/PROJECT-STATE.md`, `CHANGELOG.md`). Die Stufen bleiben als Geschichte stehen — sie
zeigen, warum die Spec so geschnitten ist.

**Befund vor dem Bau** (in den Dateien gelesen, nicht geschätzt):

- `bridge.mjs` hat **null** Exporte (`grep -c "^export"` ⇒ `0`) und ruft `main()`
  beim Laden (`:286`) — ohne Wächter belegt ein Import Ports und beendet den
  Testprozess.
- `stopWithSigterm` hat 7 Aufrufstellen (`test/bridge.test.js:400,429,459,497,526,554`,
  `test/http-mcp.test.js:391`); die `killQuietly`-Aufräumer sind schon als `t.after`
  registriert.
- `test/bridge.test.js` startet in **10** Fällen einen Prozess, **6** davon warten
  auf eine `listening`-Zeile; `test/http-mcp.test.js` in **5**.
- Alle Spawns setzen `stdio` auf `["ignore","pipe","pipe"]` oder
  `["pipe","pipe","pipe"]` — `isTTY` ist dort überall falsch, die neue Regel ändert
  an diesen Dateien nichts.
- `skip:` steht heute 4× in `test/`; nach diesem Inkrement sind es 12 Quellzeilen.

1. **Die Naht: Wächter, TTY-Regel und die Amendments.** In `bridge/bridge.mjs`:
   - `import { fileURLToPath } from "node:url";` und am Dateiende ein Wächter
     `const INVOKED_AS_SCRIPT = …` (beide Seiten über `fs.realpathSync`, `false` im
     `catch`), `if (INVOKED_AS_SCRIPT) main().catch(…)`. Bricht er, werden die
     Kindprozess-Fälle rot — der Wächter ist damit selbst geprüft.
   - `export function mcpStdioEnabled(stdin) { return stdin?.isTTY !== true; }` und
     `if (mcpStdioEnabled(process.stdin)) startMcpServer({ … })`, unverändert mit
     `onInputClosed`/`stdinIsClientChannel`. Der Kommentar sagt, was ankommt:
     Terminal ⇒ `isTTY` wahr, kein Client; systemd (`/dev/null`) und pi (Pipe) ⇒
     falsch, stdio läuft weiter. Modulkopf anpassen („serve MCP on stdin/stdout
     **when stdin is not a terminal**").
   - **Zugleich die Amendments aus `docs/18:351`–`:354`** nachziehen („`startMcpServer`
     läuft unbedingt weiter") — `docs/README.md` verlangt das in der Stufe, die das
     Verhalten umsetzt.
   Neue Fälle in `test/bridge.test.js`: `mcpStdioEnabled_withATerminalStdin_shouldBeFalse`,
   `mcpStdioEnabled_withAPipeOrTheNullDevice_shouldBeTrue`.
   Proof: `node --test --test-reporter=tap --test-name-pattern="mcpStdioEnabled" test/bridge.test.js`
   ⇒ `# fail 0`, `# skipped 0`; `node --test --test-reporter=tap test/bridge.test.js`
   ⇒ `# fail 0`; `node --test --test-reporter=tap test/mcp.test.js` ⇒ `# fail 0`,
   `# cancelled 0`; `node --test --test-reporter=tap test/http-mcp.test.js` ⇒
   `# fail 0`; `git grep -n "läuft unbedingt" -- docs/` ⇒ keine Ausgabe.

2. **Die Port-Zeile wird exportiert.** `export function portInUseLine({ host, port,
   lookup = findPortOwner })` liefert die **ganze** Zeile; `logBindFailure` ruft sie,
   `describePortOwner` entfällt. Die Adresse kommt weiter aus `formatAddress` — die
   Ausgabe bleibt zeichengleich.
   Neue Fälle: `portInUseLine_withAnUnresolvableOwner_shouldNameNoPid`,
   `portInUseLine_withAResolvableOwner_shouldNamePidAndProcessName`.
   Proof: `--test-name-pattern="portInUseLine"` ⇒ `# fail 0`; `test/bridge.test.js`
   ⇒ `# fail 0` — der bestehende Fall `:590` pinnt die Ausgabe weiter zeichengenau.

3. **Signale und die Zählung.** `export function shutdownSignalNames(platform =
   process.platform)` → `["SIGTERM","SIGINT"]`, auf `win32` zusätzlich `"SIGBREAK"`;
   `installShutdownHandlers` schleift über die Liste. In den Testdateien:
   `const SKIP_ON_WINDOWS = process.platform === "win32" ? "child.kill() terminates
   unconditionally on Windows, so the exit code after a signal is not observable
   there; the console end is the operator's Ctrl+C (spec 30, criterion 1)" : false;`
   als zweites Argument an die 6 `SIGTERM`-Fälle (`:368,:404,:432,:463,:500,:529`)
   und den einen in `test/http-mcp.test.js` (`:356`); die `t.after`-Aufräumer bleiben.
   Neu: `bridge_withSIGINT_shouldExitZeroAndLogTheShuttingDownLine`
   (`{ skip: SKIP_ON_WINDOWS }`), `shutdownSignalNames_onWindows_shouldIncludeSigbreak`,
   `shutdownSignalNames_onPosix_shouldNotNameSigbreak`.
   Proof: `--test-name-pattern="shutdownSignalNames|SIGINT"` ⇒ `# fail 0`;
   `test/bridge.test.js test/http-mcp.test.js` ⇒ `# fail 0`, `# cancelled 0`,
   `# skipped 0`; `git grep -n "skip:" -- test/` ⇒ **12** Zeilen.

4. **`CONTRIBUTING.md`, `## Acceptance`.** Ein Absatz unter dem Block: `npm run check` hängt
   nicht mehr an Shell-Werkzeugen (Spec 29); auf Windows meldet `npm test`
   `# skipped N` mit N >= 12, `# fail 0` und `# cancelled 0` bleiben Pflicht; alles
   in Git Bash außer `Strg+Untbr` und dem Tastendruck aus Kriterium 7, die ein echtes
   Konsolenfenster brauchen; Betreiber-Messung: Kriterien 1, 3b, 5 und die
   Windows-Hälfte von 7. Keine bestehende Zeile wird geändert.
   Proof: `git diff CONTRIBUTING.md | grep -E '^-[^-]'` ⇒ keine Ausgabe;
   `npm test; echo $?` ⇒ `0` mit `# fail 0` und `# cancelled 0`.

5. **Abschluss** (Orchestrator). Kriterien einzeln am Diff prüfen, Prosa beschreibend
   machen, `status: active`, `## Open questions` auflösen (je Frage eine Zeile in
   `## Log`), `## Amendments` entfernen, `## Bekannte Lücken` fortschreiben,
   `docs/README.md`, `docs/ROADMAP.md`, `docs/PROJECT-STATE.md` pflegen, `INSTALL.md`
   um den Abschnitt am Ende ergänzen und die zwei Empfehlungszeilen aus Kriterium 6
   drehen.
   Proof: `grep -n '^status:' docs/30-prozess-und-konsole.md` ⇒ `status: active`;
   `git diff -U0 INSTALL.md | grep -E '^-[^-]' | wc -l` ⇒ `2`, keine Befehlszeile
   darunter.

### Wer die Schlussstufe macht

**Der Orchestrator.** Stufe 5 ändert Spec, `docs/README.md`, `docs/ROADMAP.md`,
`docs/PROJECT-STATE.md` und `INSTALL.md` — Dateien, die `ranger-1` nicht anfasst.
Stufen 1–4 sind Umsetzer-Arbeit. Die Betreiber-Kriterien führt der Umsetzer **nicht**
aus.

### What could go wrong

- **Der `main()`-Wächter ist die einzige neue Laufzeitgefahr.** Weichen
  `process.argv[1]` und `import.meta.url` ab (Symlink, `--preserve-symlinks`),
  startet die Bridge stumm nicht. `fs.realpathSync` fängt den Normalfall; der Preis
  des Restrisikos ist, dass er sofort auffällt (10 Kindprozess-Fälle, 6 davon mit
  `listening`-Wartezeit).
- **Der TTY-Zweig hat keinen End-to-End-Beleg.** „Tastendruck erzeugt keine Ausgabe"
  braucht ein PTY und damit ein Fremdprogramm; lokal ist nur die Entscheidung
  gepinnt. Eine *immer* startende `startMcpServer`-Zeile würde von keinem lokalen
  Test gefangen — nur vom Betreiber-Terminal.
- **`portInUseLine` darf die Ausgabe nicht verschieben.** `test/bridge.test.js:590`
  und `:622` pinnen die Zeile zeichengenau; wer `formatAddress` nicht benutzt, macht
  beide rot.
- **Skips sind auf Windows ein Verlust, nicht nur Buchhaltung.**
  `test/http-mcp.test.js` verliert dort seinen zentralen Vergleichsfall. Das ist die
  gewählte Form („übersprungen, mit Grund"), aber es ist ein Verlust.
- **`skip:`-Grep und Skip-Konstante müssen zusammenpassen.** Kriterium 3 zählt
  Zeilen mit `skip:`; ein ausgelagertes `const OPT = { skip: … }` oder ein
  `t.skip()` im Rumpf matcht nicht.
- **CRLF.** `git grep`/`git status` auf Windows setzen einen LF-Klon voraus;
  `test/bridge.test.js` vergleicht stderr zeichengenau. `core.autocrlf` gehört in
  `INSTALL.md`, nicht in den Code.

### Ordering and dependencies

1 → 2 → 3 → 4 → 5, jede Stufe für sich grün; keine Stufe braucht eine spätere.
Stufe 1 zuerst, weil sie die Datei überhaupt importierbar macht — Stufe 2 und 3
holen aus `bridge.mjs`, was erst der Wächter ermöglicht. Stufe 2 nach Stufe 1, weil
der Export sonst nicht ladbar ist; Stufe 3 nach Stufe 2, weil sie denselben
Testdateien zwei neue Fälle hinzufügt. Stufe 4 nach Stufe 3, weil der Absatz die Zahl
der übersprungenen Fälle beschreibt, die es erst dann gibt. Stufe 5 zuletzt, weil sie
den Ist-Zustand beschreibt.

### What the next increment inherits

- **Teil 2 fehlt:** Dienst-Ersatz (Task Scheduler/NSSM), vollständige
  Windows-Installationsanleitung in `INSTALL.md`, Endpunkt-Entscheidung.
- **`port-owner` bleibt auf Windows stumm** — kein `netstat`-Parser, kein
  Unterprozess. Ein Dienst-Ersatz, der einen PID will, braucht eine eigene Spec.
- **Der stdio-Rückfallweg bleibt unverändert**: er startet genau dann, wenn
  `process.stdin.isTTY` falsch ist. Ein Schalter `--stdio` kommt nicht.

## Windows von Hand (Entwurf für `INSTALL.md`, Stufe 5)

**Erledigt (2026-11-18).** Der Entwurf steht als `INSTALL.md` § 10 (Binary, Token,
Konsole, Task Scheduler, `curl`-Prüfung); § 10.4 nennt `Ctrl+C` und das leere stdout, und
mit dieser Spec kommt `Strg+Untbr` dazu. Der Text unten bleibt als Geschichte: er nennt
noch Node für die Token-Datei und behandelt den Endpunkt als offene Frage, die mit
`docs/36` entschieden ist (`ws://127.0.0.1:8110`, sichtbar vorbelegt).

1. Node >= 22 und Firefox installieren. Kein WSL, kein Caddy, kein Zusatzprogramm.
2. Token anlegen (der Default-Pfad kommt aus `os.homedir()`, `bridge/config.mjs:110`):

   ```powershell
   node -e "const f=require('fs'),p=require('path'),d=path.join(process.env.USERPROFILE,'.config','browser-control');f.mkdirSync(d,{recursive:true});f.writeFileSync(path.join(d,'token'),require('crypto').randomBytes(32).toString('hex'))"
   ```

   **Nicht** `> token` mit PowerShell: `>` schreibt UTF-16 mit BOM, und `readToken`
   verlangt reines Hex (`bridge/config.mjs:133`–`:134`). `openssl` gibt es auf
   Windows nicht vorausgesetzt.
3. Endpunkt der Extension: `ws://127.0.0.1:8110` — auf einem Rechner mit pi und
   Firefox ist kein TLS-Terminator nötig, und die Bridge bindet per Default nur
   Loopback (`bridge/config.mjs:14`). Die Entscheidung, ob hier ein lokaler Caddy
   mit `wss://` hingehört, ist Teil 2.
4. Bridge starten: `%LOCALAPPDATA%\browser-control\browser-control-bridge.exe --http`
   (Konsole, `Strg+C` beendet). Für den Autostart die Aufgabe aus
   `deploy/windows/browser-control-bridge.xml` registrieren:

   ```powershell
   schtasks /Create /XML "$env:USERPROFILE\browser-control\deploy\windows\browser-control-bridge.xml" /TN browser-control-bridge
   schtasks /Run /TN browser-control-bridge
   schtasks /Query /TN browser-control-bridge /FO LIST   # Status: Running
   ```

   Das XML erwartet das Binary unter `%LOCALAPPDATA%\browser-control\` — es dorthin
   kopieren (und nach jedem `cargo build` erneut).
   Die POSIX-Zeile aus `INSTALL.md` (`nohup … < /dev/null &`) braucht es nicht: an
   einer Windows-Konsole ist `stdinIsClientChannel()` falsch, also beendet kein
   stdin-EOF den Prozeß.
5. Extension laden wie auf Linux: `about:debugging#/runtime/this-firefox` →
   „Temporäre Erweiterung laden…" → `…\extension\manifest.json` (die Datei, nicht
   der Ordner). Endpunkt und Token eintragen, speichern, **einmal neu laden**.
6. pi verbinden. Die Header-Zeile `!echo Bearer $(cat …)` aus `INSTALL.md` braucht
   eine POSIX-Shell; auf Windows ist der Umweg über eine Umgebungsvariable portabel
   (`docs/mcp.md` nennt `${VAR}` ausdrücklich):

   ```json
   "browser-control": {
     "url": "http://127.0.0.1:8111/mcp",
     "headers": { "Authorization": "Bearer ${BC_TOKEN}" }
   }
   ```

   ```powershell
   setx BC_TOKEN (Get-Content "$env:USERPROFILE\.config\browser-control\token")
   ```

   Danach pi neu starten. Ungeprüft bleibt, ob pi den `!`-Befehl auf Windows durch
   `cmd.exe` oder PowerShell schickt — deshalb der Umgebungsvariablen-Weg.
7. Prüfen: `netstat -ano | findstr LISTENING | findstr ":8110 :8111"` und der
   `curl`-Aufruf aus Kriterium 5.
8. Autostart ist **erledigt durch `docs/38`**: `deploy/windows/browser-control-bridge.xml`
   (`AtLogOn`, `InteractiveToken`, `LeastPrivilege`) — Task Scheduler, **ohne** NSSM
   und ohne WinSW. "Kein Neustart bei Fehlschlag" ist dort die Einstellung, die auf
   Linux `RestartPreventExitStatus=2` entspricht: ein fehlendes Token heilt kein
   Neustart.

Konsole ist der Normalfall, der Dienst die Option: die Abschnitte 3 und 5 der
Linux-Anleitung behalten ihre Befehle, nur die zwei Empfehlungswörter drehen sich
(Kriterium 6).


## Open questions

**Keine (Stand 2026-11-18).** Beide Fragen von 2026-11-06 sind beantwortet oder überholt:

- **Windows-Rechner** — die Frage blockiert keinen Code mehr. Was fehlt, ist die Messung
  (Kriterien 1, 5 und die Windows-Hälfte von 7); sie steht als Betreiberarbeit in
  `INSTALL.md` § 10 und `bridge-rs/README.md`, `## Windows`, nicht als Designfrage.
- **Die 90-Sekunden-Frist** — überholt: `test/mcp.test.js` und seine 139 Fälle sind mit der
  Node-Bridge gelöscht. Die Frist in `CONTRIBUTING.md` (`--test-timeout=90000`) gilt für
  die Node-Suite der Erweiterung und der Skripte; die Bridge läuft in `cargo test`.

**Entschieden am 2026-11-06** (der Betreiber hat mit „los" die jeweilige Empfehlung
angenommen; ein Widerwort ändert eine Stufe, nicht den Zuschnitt):

| Frage | Entscheidung | Stufe |
|---|---|---|
| stdio im Terminal | startet nur, wenn `process.stdin.isTTY` falsch ist; kein `--stdio`-Schalter | 1 |
| `port-owner` auf Windows | bleibt stumm („Besitzer nicht ermittelbar"), kein `netstat`-Parser | 2 |
| Betreiber-Liste | Kriterien 1, 3b, 5 und die Windows-Hälfte von 7; Kriterium 2 braucht beide Läufe | 4 |
| geordnetes Ende | `SIGINT` (Strg+C) und `SIGBREAK` (Strg+Untbr); was ein Dienst-Wrapper schickt, entscheidet Teil 2 | 3 |

## Risiken

- **Ohne Windows-Maschine ist die Kernannahme nicht widerlegbar.** Bau und Lint der
  Windows-Zweige laufen hier (`--target x86_64-pc-windows-gnu`), der Lauf nicht; dass
  `Strg+C` und `Strg+Untbr` ankommen, ist eine Betreiber-Messung.
- **Signal-Semantik ist Dokumentation, kein Messwert.** Windows erzeugt `SIGTERM` nie;
  `SIGINT` kommt von `Strg+C`, `SIGBREAK` von `Strg+Untbr`. Beide Griffe sind jetzt
  verdrahtet (`main.rs:422`–`:423`); was ein Dienst-Stopp schickt, entscheidet der Wrapper
  in Teil 2.
- **Die 90-Sekunden-Frist** — *überholt (2026-11-18):* `test/mcp.test.js` ist mit der
  Node-Bridge gelöscht, die Frist betrifft die Bridge nicht mehr.
- **Konsolen-Encoding.** stderr trägt deutsche Sätze („Besitzer nicht ermittelbar"); unter
  `cmd.exe` kann die Codepage Umlaute zerlegen. Kein Protokoll betroffen (stdout bleibt
  JSON-RPC), aber Logzeilen können unleserlich werden. Wird gemessen, nicht vorab gelöst.
- **CRLF** — siehe „What could go wrong".

## Touch boundary

**Der Zuschnitt von 2026-11-06 ist überholt** — er nannte Node-Dateien. Die Grenze dieses
Inkrements (2026-11-18):

- **Angefasst:** `bridge-rs/src/main.rs` (Gate und `SIGBREAK`), `bridge-rs/src/stdio.rs`
  (`stdin_is_a_console`), diese Spec, `docs/README.md` (Statuszelle), `docs/ROADMAP.md`
  (Zeile 30), `docs/PROJECT-STATE.md`, `CHANGELOG.md`.
- **Nicht angefasst:** `extension/**`, `scripts/**`, `test/**`, `deploy/**`, `docs/38`,
  `docs/18`, `bridge-rs/Cargo.toml` (nichts nötig), `bridge-rs/tests/**` (kein neuer Fall
  nötig), die Unit `deploy/browser-control.service`.
- Keine neue Abhängigkeit, kein Token, kein Geheimnis. Der Dienst auf 8110/8111 wurde nicht
  angefasst, und kein Prozess wurde nach Muster beendet.

**Die ursprüngliche Grenze (überholt, als Geschichte):**

- `bridge/bridge.mjs`, `test/bridge.test.js`, `test/http-mcp.test.js`, `CONTRIBUTING.md`
  (`## Acceptance`), `INSTALL.md` (zwei Empfehlungszeilen plus ein Abschnitt am Ende),
  `docs/18-dienst-und-http-mcp.md` (nur die Amendments-Zeile), diese Spec,
  `docs/README.md`, `docs/ROADMAP.md`, `docs/PROJECT-STATE.md`.
- **Nicht anfassen:** `extension/*` (kein `manifest.json`, kein `background.js`),
  `deploy/browser-control.service`, `bridge/hub.mjs`, `bridge/mcp.mjs`,
  `bridge/http-transport.mjs`, `bridge/websocket.mjs`, `bridge/port-owner.mjs`,
  `test/mcp.test.js`, `test/deploy.test.js`, `test/port-owner.test.js`,
  `package.json`, `scripts/check.mjs` (Spec 29).
- Keine neue Abhängigkeit, kein Token, kein Geheimnis.

## Bekannte Lücken

Stand 2026-11-18, nach der Umsetzung:

- **Die Konsole ist nicht end-to-end gemessen.** Lokal ist nur die Entscheidung gebaut
  (`stdin_is_a_console`, `stdio.rs:186`); dass in einem echten Terminal nichts auf stdout
  landet und `Strg+Untbr` ankommt, hakt der Betreiber ab (Kriterium 7, `INSTALL.md`
  § 10.4). Der Fehler „stdio startet *immer*" würde von keinem lokalen Fall gefangen — der
  Gegenfall (Pipe) ist gepinnt, der Konsolefall nicht.
- **Die Windows-Messung steht aus** (Kriterien 1, 5, Windows-Hälfte von 7): `main.rs` ist
  für `x86_64-pc-windows-gnu` gebaut und lint-frei, aber nicht gelaufen.
- **Der Dienstweg wird nicht live gegen die Konsole gemessen** (Kriterium 8): die Unit zu
  stoppen kappte die Verbindung, über die pi in dieser Sitzung den Browser erreicht.
- **`docs/38` Stufe 3 und `bridge-rs/README.md` widersprechen jetzt dem Code.** Beide sagen,
  `Ctrl+Break` sei bewusst **nicht** verdrahtet (begründet mit der Vorlage, die den Signal
  nicht kannte). Mit dieser Spec ist er es — `docs/38` liegt außerhalb der Boundary dieses
  Inkrements, `bridge-rs/README.md:259` ebenfalls; der Satz gehört dort nachgezogen.
- **`docs/18:365`–`:370` sagt weiter „`startMcpServer` läuft unbedingt weiter".** Die
  Amendment-Zeile dieser Spec ist **nicht** nachgezogen: der Absatz beschreibt
  `bridge/bridge.mjs`, eine mit `docs/38` gelöschte Datei. Der heute gültige Vertrag steht
  in `main.rs:129` und `stdio.rs:186`; eine Änderung an `docs/18` wäre eine Aussage über
  eine Datei, die es nicht mehr gibt.
- **Die Besitzerzeile ohne Fund hat keinen eigenen Fall.** Dass `null` zu „Besitzer nicht
  ermittelbar" ohne PID wird (`main.rs:339`), ist Code und nicht gepinnt; Paritätsvergleich
  5 pinnt nur die Zeile **mit** Besitzer (der `mask` ersetzt PID und Name). Die Zeilenbildung
  liegt in `main.rs`, also außerhalb der Bibliothek, die `cargo test` messen kann.
- **Teil 2 fehlt weiterhin nicht mehr:** Dienst-Ersatz (`docs/38` Stufe 3),
  Windows-Anleitung (`INSTALL.md` § 10) und Endpunkt (`docs/36`) sind da. Offen ist allein
  die Betreiber-Messung.

## Review

### Runden 1–3 der Vorgängerfassung, 2026-11-06

Die gemeinsame Fassung („der Prozess und die Abnahme") wurde dreimal blockiert:
Runde 1 `🔧` mit L1–L6, Runde 2 `🔧` mit M1–M5, Runde 3 `🔧` mit N1 und N2. Nach
`CONTRIBUTING.md`, Schritt 4, ist die Spec damit zu groß und wird geteilt; je Befund
steht eine Zeile in `## Log`, und jeder Teil geht als eigene Spec durch das Gate.

Die beiden Blocker der dritten Runde stehen **hier**: N1 (Amendments an `docs/18`
waren keiner Stufe und keiner Boundary zugeordnet — jetzt Stufe 1 und
Touch boundary) und N2 (Kriterium 9 war als Hintergrundauftrag nicht meßbar — jetzt
Kriterium 7, Vordergrund, echtes Konsolenfenster, getrennte Ströme).

### Runde 1 dieser Spec

Keine eigene Review-Runde: die Spec ging am 2026-11-06 als neue Spec ins Gate, und die
Umsetzung fiel mit dem Rust-Port zusammen (`docs/38`). Geprüft wurde stattdessen gegen den
Code — `## Prüfung gegen den Rust-Stand`, `## Log`, P1–P5.

## Log

Je Befund eine Zeile (aus `CONTRIBUTING.md`, Schritt 4).

- **L1–L16 (Runde 1) und M1–M16 (Runde 2): übernommen** — der größte Teil in dieser
  Spec: curl-Kommando, Token-Vorbedingung, ehrliche Skip-Zeile im Testing,
  gestrichene `port-owner`-Zeile, Kriterium 8 mit `deploy.test.js`, 139 statt 138,
  90-Sekunden-Risiko, `findstr LISTENING`, Zeilennummern 183/86, gemischtsprachige
  Logzeile als Vertrag, zwei Tippfehler, Stufen 1/2 geteilt, `# skipped 0`.
  Drei dieser Befunde betrafen Text, der mit der Teilung nach
  `docs/29-windows-betrieb.md` gewandert ist (Git-Bash-Regel, Zahl als Messwert,
  Soll-Zeile für den Prozessstart) — sie stehen dort im `## Log` dieses Teils.
- **N1: übernommen.** `docs/18` steht jetzt in der Touch boundary, die Nachziehung
  ist Teil von Stufe 1, und `docs/README.md` verlangt genau diese Zuordnung.
- **N2: übernommen.** Kriterium 7 ist Vordergrund, echtes Konsolenfenster, getrennte
  Ströme (`1>out.log 2>err.log`), mit der Begründung, dass ein Hintergrundauftrag
  kein TTY hat.
- **N3: übernommen.** Kriterium 6 verlangt `wc -l` ⇒ **2** (nicht „höchstens zwei");
  Non-Goal, Dateitabelle, Stufe 5 und Touch boundary sagen jetzt dasselbe.
- **N4: übernommen.** Ein Name: `SKIP_ON_WINDOWS`, überall.
- **N5: übernommen.** Der Skip-Text begründet nur noch, was stimmt: `child.kill()`
  beendet auf Windows unbedingt, ein Exit-Code nach einem Signal ist dort nicht
  beobachtbar.
- **N6: übernommen.** Eine Betreiber-Liste, im Kopf der Kriterien definiert und in
  Stufe 4 und `## Bekannte Lücken` zitiert.
- **N7: übernommen.** Der falsche Testverweis ist weg; Kriterium 5 nennt die eigene
  Messung und `test/http-mcp.test.js:363`.
- **N8: übernommen.** „die Zeile, die den Portbesitzer nennt — oder sagt, dass er
  nicht ermittelbar ist".
- **N9: übernommen.** Die 90-Sekunden-Frist ist offene Frage 2, nicht nur ein
  Risiko.
- **N10: übernommen.** Datum 2026-11-06 statt 2026-11-07.
- **N11: übernommen.** Amendments-Verweis `docs/18:351`–`:354`.
- **N12: übernommen.** Der Node-Einzeiler für die Token-Datei steht ausgeschrieben.
- **Nicht übernommen: nichts.** Eine Grenze bleibt: der PTY-Messwert ist im Text von
  Kriterium 7 als Stützung zitiert, aber kein eigenes Kriterium — er braucht `script`
  aus util-linux, ein Werkzeug, das diese Spec nicht voraussetzen darf.

### Prüfung und Umsetzung, 2026-11-18

- **P1: die Spec war gegen eine gelöschte Datei geschrieben.** Jeder Ziel-Punkt und jedes
  Kriterium wurde gegen den Rust-Stand geprüft; das Ergebnis steht in
  `## Prüfung gegen den Rust-Stand`. Kriterium 3 und 6 sind überholt (kein Subjekt mehr),
  Kriterium 4 ist auf Rust gezogen, die Node-Dateitabelle und der Node-Dev-Plan sind
  markiert statt gelöscht. `## Ziel` trägt sechs Punkte, nicht sieben.
- **P2: `SIGBREAK` fehlte wirklich.** `docs/38` Stufe 3 hatte ihn bewusst ausgelassen (die
  Vorlage kannte den Signal nicht; der Paritätsmaßstab läuft auf Linux und sieht keinen
  Griff). Eingebaut in `main.rs:422`–`:423`: `ctrl_break` neben `ctrl_c`, dieselbe Zeile,
  derselbe Exit-0-Pfad. `Cargo.toml` braucht nichts — die `signal`-Feature trägt
  `tokio::signal::windows` schon.
- **P3: das stdio-Gate fehlte auch.** `main.rs:129` startet stdio nur bei
  `!stdio::stdin_is_a_console()` (`stdio.rs:186`, `std::io::IsTerminal`); vorher lief
  `stdio::serve` unbedingt, und der Betreiber hätte den ersten Tastendruck als Parse-Fehler
  auf stdout gesehen. Das ist eine Verhaltensänderung auch für Linux — aber nur für den
  Fall „stdin ist ein Terminal": Pipe, Socketpair und `/dev/null` (pi, Paritäts-Treiber,
  systemd) sind unverändert.
- **P4: die Amendments an `docs/18` sind fallengelassen.** Der Abschnitt ist nach
  `docs/README.md` zu entfernen, wenn die Spec umgesetzt ist; die Zusage, die er drehen
  sollte, beschreibt `bridge/bridge.mjs` — eine Datei, die es nicht mehr gibt. Der Grund
  steht in `## Bekannte Lücken`.
- **P5: `docs/38` Stufe 3 und `bridge-rs/README.md:259` sind jetzt ungenau** („Ctrl+Break
  ist nicht verdrahtet"). Beide liegen außerhalb der Boundary; der Nachtrag gehört in eine
  Folgeänderung.
