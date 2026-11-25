---
description: Neun Fälle heben die Zeilenabdeckung von bridge-rs/src/main.rs von 55,97 auf 88,05 Prozent und die Gesamtabdeckung auf 94,53 — Start-, Signal- und Fehlerpfade werden als Prozess geprüft.
status: active
---

# Abdeckung für `main.rs`

## Anlass

`docs/66` hat `npm run test:coverage:rust` gebaut. Die erste Messung zeigte
`main.rs` bei **55,97 % Zeilen** — 70 von 159 Zeilen nie ausgeführt. Der Grund steht
in `docs/66`, `## Bekannte Lücken`: „Einstiegspunkt, Argumente, Signale — die Fälle
starten die Bridge als Prozess, statt `main` zu rufen."

Am 2026-11-23 hat ein Implementer neun Fälle ergänzt. Gemessen:

| Messung | vorher | nachher |
|---|---|---|
| `main.rs` Zeilen | 55,97 % (159, 70 fehlen) | **88,05 %** (159, 19 fehlen) |
| `main.rs` Funktionen | 69,23 % | 88,46 % |
| `TOTAL` Zeilen | 92,92 % | **94,53 %** |

## Ziel

1. **Die neun Pfade sind geprüft:** fehlender Token, unlesbare Token-Datei, belegter
   Erweiterungs-Port, `SIGTERM`, `SIGINT`, `--http` mit echtem `POST /mcp`, `--http`
   mit belegtem Port, Socket-Ende hält den Dienst am Leben, unlesbares stdin.
2. **Jeder Fall prüft Exit-Code und Logzeile**, nicht nur „Prozess ist weg".
3. **Der `POST /mcp`-Fall prüft die Antwort**, nicht nur ihre Hülle: `result` ist
   vorhanden, `error` fehlt.
4. **Kein Leck:** jeder gestartete Prozess wird beendet, jedes Verzeichnis
   aufgeräumt, auch nach einem Fehlschlag.
5. **Keine festen Ports** und kein `kill` per Muster — die PID kommt aus dem eigenen
   Kindprozess.

## Der Vertrag

| Feld | Regel |
|---|---|
| Datei | `bridge-rs/tests/bridge.rs` (die Helfer dort werden geteilt) |
| Start | als Prozess über `Launch`, mit `BC_BIND` (als `127.0.0.1:<port>`) und `BC_HTTP_PORT`, eigenem Token (`config.rs`) |
| Signale | `kill <pid>` mit der PID aus dem Kindprozess |
| Ports | `free_ports()` für zwei gleichzeitig gehaltene; beim Belegen `occupied_port()` mit gehaltenem Listener |
| Aufräumen | `Drop` beendet den Prozess und entfernt das Verzeichnis, auch nach Panic |
| Messung | `npm run test:coverage:rust`, Schwelle 90 % (`docs/66`) |

## Non-goals

- **Keine Änderung an `main.rs`.** Die Tests kommen ohne eine einzige Zeile
  Produktcode aus.
- **Keine erzwungene Abdeckung für Unerreichbares.** Neun Zeilen bleiben offen, mit
  Begründung in `## Bekannte Lücken`.
- **Kein Windows-Lauf.** Die Signal-Fälle sind `#[cfg(unix)]`; `SIGBREAK` braucht
  eine echte Konsole (`docs/30`).
- **Keine neuen Abhängigkeiten.** Der HTTP-Aufruf geht von Hand über `TcpStream`.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/bridge.rs` | `bridge_withoutATokenFile_shouldExitWithTheConfigurationCode` | Exit 2, `token file missing or too short: <pfad>`, **kein** `listening on` |
| `bridge-rs/tests/bridge.rs` | `bridge_withAnUnreadableTokenFile_shouldExitWithTheFailureCode` | Exit 1, `bridge failed:`, nicht die „missing"-Zeile |
| `bridge-rs/tests/bridge.rs` | `bridge_onATakenPort_shouldExitWithTheFailureCodeAndNameTheOwner` | Exit 1, `listener failed on …EADDRINUSE`, Besitzerzeile |
| `bridge-rs/tests/bridge.rs` | `bridge_onSigterm_shouldExitZeroWithTheTerminationLine` | Exit 0, genau eine Zeile `received SIGTERM, shutting down`, stdout leer |
| `bridge-rs/tests/bridge.rs` | `bridge_onSigint_shouldExitZeroWithTheInterruptLine` | dito für `SIGINT` |
| `bridge-rs/tests/bridge.rs` | `bridge_withTheHttpFlag_shouldServeMcpUntilASigterm` | `/mcp`-Zeile, `POST /mcp` mit Bearer-Token ⇒ `200`, `id`, `result` vorhanden, `error` fehlt; Ende per `SIGTERM` mit 0 |
| `bridge-rs/tests/bridge.rs` | `bridge_withTheHttpFlagOnATakenPort_shouldExitWithTheFailureCode` | Exit 1, `http listener failed …EADDRINUSE`, Erweiterungs-Port danach zu |
| `bridge-rs/tests/bridge.rs` | `bridge_whenTheExtensionSocketCloses_shouldKeepListening` | ein Sitzungsende beendet den Prozess nicht; neuer Handshake gelingt |
| `bridge-rs/tests/bridge.rs` | `bridge_withAnUnreadableStdin_shouldKeepServingAndLogTheFailure` | `mcp stdin failed:`, Dienst läuft weiter, Ende per `SIGTERM` |

## Acceptance criteria

1. **Die neun Fälle laufen.** `cargo test --manifest-path bridge-rs/Cargo.toml --test
   bridge -- --test-threads=1` ⇒ `test result: ok` mit `0 failed` und 12 Fällen in
   der Datei.
2. **`main.rs` über 80 %.** `npm run test:coverage:rust` ⇒ die `main.rs`-Zeile zeigt
   mindestens 80 % Zeilen (gemessen 88,05 %). Warum 80 und nicht 90: `main.rs` ist der
   Einstiegspunkt, fünf Pfade sind nicht auslösbar (siehe `## Bekannte Lücken`); die 90
   aus `docs/66` gilt für die Summe, nicht für die Datei.
3. **Gesamt über 90 %.** Dieselbe Ausgabe, `TOTAL`-Zeile ⇒ mindestens 90 % (gemessen
   94,53 %).
4. **Der `POST /mcp`-Fall prüft die Antwort.** Beleg: der Fall enthält eine Zusicherung
   auf `result` und auf das Fehlen von `error` (`grep -n 'result' bridge-rs/tests/bridge.rs`
   im Bereich des Falls).
5. **Kein Leck.** Nach `cargo test --test bridge` hat `/tmp` kein `bc-bridge-*`
   (`ls -d /tmp/bc-bridge-* 2>/dev/null | wc -l` ⇒ 0), und jeder gestartete Prozess ist
   beendet — belegt durch `Drop` im Harness, der `self.process.id()` killt und wartet.
   **Kein `pgrep browser-control-bridge`:** der Name ist länger als 15 Zeichen, `pgrep`
   kürzt und findet nie etwas; mit `-f` fände es den Dienst des Betreibers.
6. **Alles andere grün.** `npm run check` ⇒ 0, `cargo clippy --all-targets -- -D
   warnings` ⇒ 0, `cargo test` ⇒ alle Blöcke ok.

## Dev plan

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — die zwei Nachzieher (`bridge-rs/tests/bridge.rs`)**

- Der `POST /mcp`-Fall prüft `result` und das Fehlen von `error`.
- Der `--http`-Fall hält beide Ports gleichzeitig (`free_ports()`, beide Adressen
  lesen, dann beide fallen lassen), damit sie nicht kollidieren.

Beweis: Kriterien 1, 4.

**Stufe 2 — zwei Kleinigkeiten in derselben Datei**

- `without_token_file()` entfernt den Token-Pfad zusätzlich, damit kein Rest aus einem
  früheren Lauf den Fall blockiert.
- Der Dateikopf sagt zwölf Fälle statt drei.

Beweis: Kriterien 1, 5.

**Stufe 3 — die Doku**

`docs/66` (die Lücke „`main.rs` liegt bei 55,97 %" auf den neuen Stand ziehen und die
neun offenen Zeilen mit Begründung auflisten), `docs/README.md`, `docs/PROJECT-STATE.md`;
die Spec wird `active`.

Beweis: `npm run check` ⇒ 0 und `grep -n '88,05' docs/66-rust-abdeckung.md` ⇒ 1.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `bridge-rs/tests/bridge.rs` | `bridge-rs/src/main.rs`, `bridge-rs/src/**`, `extension/**`, `scripts/parity/**` |
| `docs/66-rust-abdeckung.md`, `docs/README.md`, `docs/PROJECT-STATE.md` | `.github/workflows/**`, `scripts/coverage*.mjs`, `package.json` |

## Bekannte Lücken

**19 Zeilen** in `main.rs` bleiben offen (159 × 88,05 % ⇒ 140 gedeckt). Die Tabelle
benennt **14** davon; die übrigen fünf sind Anweisungsenden innerhalb der genannten
Blöcke, die dieselben Gründe tragen. Jede benannte Zeile hat einen Grund, der am Code
trägt:

| Zeilen | Pfad | Warum nicht prüfbar |
|---|---|---|
| 87-88 | `Signals::register()` scheitert | `signal(2)` scheitert nur an `EMFILE`/`ENOMEM` |
| 173 | `ConnectionAborted`-Arm | verlangt ein SYN-Abort zwischen Kernel und `accept` — ein Race |
| 179-183 | `accept()`-Fehler ⇒ Exit 1 | nur mit erschöpftem Dateideskriptor-Limit; das vergiftet die übrige Suite |
| 201 | `http_result` `Ok(())` | `joined()` liefert `Ok(())` nur nach `Transport::close()`, das `main` nie ruft |
| 202 | `http_result` `Err` | derselbe Dateideskriptor-Fall wie 179 |
| 220 | `mcp task failed` | die stdio-Aufgabe müsste panicken; niemand provoziert das |
| 265 | `join_transport` → `pending()` | wird gepollt, aber nie verlassen — die schließende Klammer bleibt offen |
| 279 | `join_stdio` → `pending()` | nur wenn stdin ein Terminal ist; ohne PTY nicht startbar |
| 339 | `Besitzer nicht ermittelbar` | nur per Race (Halter zwischen Bind und `/proc`-Scan fallen lassen) |

- **`with_a_directory_as_token_file()` räumt nicht auf** wie sein Nachbar
  `without_token_file()`. Ein Restverzeichnis aus einem abgebrochenen Lauf plus eine
  wiederverwendete PID lässt `create_dir` panicken — gleiche Fehlerklasse, eine Variante
  weiter (Code-Review 2026-11-23).
- **`Launch::new()` bindet einen Port und wirft ihn weg**, wenn `.on_port()` gleich
  danach einen anderen setzt. Harmlos (der Listener fällt vor `spawn`), aber ein Bind,
  den niemand braucht (Code-Review 2026-11-23).

## Open questions

**Keine.** Der Betreiber hat am 2026-11-23 „erhöhe die Testabdeckung in main.rs"
gesagt; die Schwelle folgt `docs/66`.

## Review

### Runde 1 — `🔧 Fix these` (2026-11-23)

Zwei Blocker: der Testlauf hatte keine Spec (dieses Dokument), und der
`POST /mcp`-Fall prüfte nur `id`/`jsonrpc` — ein `-32601` wäre grün gewesen. Dazu
drei Kleinigkeiten im selben Zug: die zwei `free_port()`-Aufrufe konnten kollidieren,
`without_token_file()` räumte nicht auf, und der Dateikopf zählte drei statt zwölf
Fälle.

### Runde 2 — steht aus

## Log

- **2026-11-23, angelegt.** Nach dem Testlauf des Implementers: `main.rs` 55,97 →
  88,05 %, `TOTAL` 92,92 → 94,53 %, neun neue Fälle.

- **2026-11-23, Runde 2 und Stufe 3.** Der Reviewer hat die vier Code-Punkte
  abgenommen (Antwort über `Content-Length`, `result` fehlt im Fehlerrahmen ⇒ rot,
  `free_ports()`, Aufräumen per `remove_file`/`remove_dir_all`) und drei Blocker in
  dieser Spec gefunden: die Umgebungsvariablen heißen `BC_BIND` und `BC_HTTP_PORT`,
  der `pgrep`-Beleg war vakuum-grün (Name länger als 15 Zeichen), und „neun Zeilen"
  widersprach der Tabelle mit 14 Nummern. Alle drei sind eingearbeitet; die zwei
  Nachläufe stehen oben unter `## Bekannte Lücken`. Messung zur Abnahme: `main.rs`
  88,05 %, `TOTAL` 94,53 %, 12 Fälle in `bridge.rs`.
