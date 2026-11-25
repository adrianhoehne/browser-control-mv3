---
description: Ein Befehl npm run test:coverage:rust misst die Zeilenabdeckung der Bridge über cargo-llvm-cov, druckt die Übersicht je Modul und bricht unter 90 Prozent ab — dieselbe Schwelle wie die Erweiterung.
status: active
---

# Abdeckung für die Bridge

## Anlass

`docs/64` hat die Abdeckung der Erweiterung gemessen: 92,2 % Zeilen aus den
V8-Rohdaten, ein Befehl, Schwelle 90 %. Die Bridge (`bridge-rs`, 305 Fälle) hatte
keine Zahl. `docs/64` führte das als Lücke: `cargo-llvm-cov` und das rustup
Component `llvm-tools-preview` fehlten.

Am 2026-11-23 hat der Betreiber beides installiert (`cargo-llvm-cov 0.9.2`,
Component `llvm-tools`). Der erste Lauf misst:

| Region | Wert |
|---|---|
| Zeilen | 3 658, davon 259 nicht gedeckt = **92,92 %** |
| Funktionen | 502, davon 27 nicht gedeckt = 94,62 % |
| Regionen | 4 213, davon 337 nicht gedeckt = 92,00 % |

Die schwächsten Module sind `main.rs` (55,97 % Zeilen, Einstiegspunkt mit Argumenten
und Signalen) und `link.rs` (82,02 %).

## Ziel

1. **`npm run test:coverage:rust`** fährt `cargo llvm-cov` über `bridge-rs`, druckt
   die Übersicht je Modul und bricht unter **90 % Zeilen** ab — dieselbe Schwelle
   wie `docs/64`.
2. **Kein PATH-Zwang.** Der Befehl findet `cargo` selbst (auch unter
   `~/.cargo/bin/cargo`), damit er in einer Shell ohne Rust-Umgebung läuft.
3. **Fehlendes Werkzeug ist ein Satz, kein Stacktrace.** Fehlt `cargo-llvm-cov` oder
   das Component, nennt der Befehl beide Installationsbefehle und endet mit Exit 1.
4. **Eine Zeile im Bericht**, die zählt: `TOTAL … 92,92 %` aus der `cargo`-Ausgabe
   wird durchgereicht, nicht neu gerechnet.

## Der Vertrag

| Feld | Regel |
|---|---|
| Befehl | `npm run test:coverage:rust` |
| Werkzeug | `cargo llvm-cov --summary-only --fail-under-lines 90`, `--manifest-path bridge-rs/Cargo.toml`, `-- --test-threads=1` |
| Ausgabe | die Übersicht von `cargo llvm-cov`, unverändert |
| Schwelle | 90 % Zeilen; `--min=<prozent>` des Wrappers setzt sie für einen Lauf |
| Rückgabewert | Exit von `cargo llvm-cov` (0 oder 1), bei fehlendem Werkzeug 1 |
| Umfang | `bridge-rs/src/**`; `bridge-rs/tests/**` bleibt draußen (das ist Prüfcode) |

## Non-goals

- **Kein CI-Job.** Der GitHub-Runner hat die Werkzeuge nicht; ein Job bräuchte
  `rustup component add llvm-tools-preview` und `cargo install cargo-llvm-cov` bei
  jedem Lauf. Eigene Entscheidung.
- **Keine Zusammenführung mit der JS-Zahl.** Zwei Sprachen, zwei Werkzeuge, zwei
  Tabellen. Eine Summe über beide wäre eine Zahl ohne Bedeutung.
- **Keine HTML-Ausgabe, kein Upload.** Die Übersicht im Terminal genügt.
- **Keine Änderung an `docs/64`.** Der JS-Befehl bleibt, wie er ist.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/coverage-rust.test.js` | `rustCoverageCommand_shouldPassTheThresholdAndTheSerialFlag` | die Argumentliste: `--summary-only`, `--fail-under-lines <min>`, `--manifest-path`, `--test-threads=1` |
| `test/coverage-rust.test.js` | `rustCoverageCommand_withoutAMinimum_shouldUseNinety` | die Standardschwelle ist 90 |
| `test/coverage-rust.test.js` | `missingToolchainMessage_shouldNameBothInstallCommands` | der Satz nennt `rustup component add llvm-tools-preview` und `cargo install cargo-llvm-cov` |

## Acceptance criteria

1. **Der Befehl läuft durch.** `npm run test:coverage:rust; echo $?` ⇒ 0, und die
   Ausgabe enthält eine `TOTAL`-Zeile mit einem Zeilenanteil über 90 %.
2. **Die Schwelle greift.** `npm run test:coverage:rust -- --min=99.9; echo $?` ⇒ 1.
3. **Fehlendes Werkzeug.** Mit `PATH` ohne `~/.cargo/bin` und ohne
   `cargo-llvm-cov` nennt der Befehl die zwei Installationsbefehle und endet mit 1.
   Beleg: der Fall `missingToolchainMessage_shouldNameBothInstallCommands`.
4. **Keine Abhängigkeit.** `git diff --stat package.json` ⇒ eine Zeile im
   `scripts`-Block, keine `dependencies`.
5. **Alles andere grün.** `npm test` ⇒ 0 mit `^# fail 0`, `npm run check` ⇒ 0.

## Dev plan

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — der Wrapper (`scripts/coverage-rust.mjs`, neu)**

Eine reine Funktion `rustCoverageCommand({ minimum, manifestPath })` baut die
Argumentliste; eine Funktion `findCargo()` sucht `cargo` in `PATH` und dann in
`~/.cargo/bin`. Fehlt das Werkzeug, druckt `missingToolchainMessage()` die zwei
Befehle. Der Wrapper startet `cargo` mit `spawnSync`, reicht die Ausgabe durch und
gibt dessen Exit-Code zurück.

Beweis: die drei Fälle aus `## Testing`.

**Stufe 2 — der Befehl (`package.json`)**

`"test:coverage:rust": "node scripts/coverage-rust.mjs"`. Keine Abhängigkeit.

Beweis: Kriterien 1, 2, 4.

**Stufe 3 — die Doku**

`CONTRIBUTING.md` (eine Zeile neben `test:coverage`), `docs/64` (die Lücke
„`bridge-rs` bleibt ohne Zahl" auf „gemessen in `docs/66`" ziehen), `docs/README.md`
(Status), `docs/PROJECT-STATE.md`; der Amendments-Abschnitt entfällt, die Spec wird
`active`.

Beweis: `npm run check` ⇒ 0 und `grep -n 'test:coverage:rust' CONTRIBUTING.md` ⇒ 1.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `scripts/coverage-rust.mjs` (neu), `test/coverage-rust.test.js` (neu), `package.json` (`scripts`-Block) | `scripts/coverage.mjs`, `test/coverage.test.js`, `.github/workflows/**` |
| `CONTRIBUTING.md`, `docs/64`, `docs/README.md`, `docs/PROJECT-STATE.md` | `extension/**`, `bridge-rs/**`, `scripts/parity/**` |

## Bekannte Lücken

- **`main.rs` lag bei 55,97 % Zeilen** und steht seit `docs/67` bei **88,05 %** (19 von
  159 Zeilen offen, mit Begründung dort). Einstiegspunkt, Argumente, Signale — die
  Startpfade werden jetzt als Prozess geprüft (2026-11-23).
- **Die Werkzeuge sind eine Installation außerhalb des Repos.** Ein frischer Rechner
  braucht `rustup component add llvm-tools-preview` und `cargo install
  cargo-llvm-cov`; der Wrapper nennt beide, installiert sie aber nicht (2026-11-23).
- **Die erste Messung dauerte einige Minuten**, weil `llvm-cov` die Crates neu baut.
  Folgeläufe sind schneller, aber nicht so schnell wie der JS-Befehl (2026-11-23).
- **Kein CI-Job.** Siehe `## Non-goals` (2026-11-23).

## Open questions

**Keine.** Der Betreiber hat am 2026-11-23 „nachziehen" gesagt und die Werkzeuge
installiert; die Schwelle folgt `docs/64`.

## Review

### Runde 1 — `✅ Ship it` (2026-11-23)

Der Reviewer hat die Zahlen selbst gemessen (`TOTAL … 92.92 %`, `main.rs` 55.97 %,
`link.rs` 82.02 %), `findCargo()` mit leerem `PATH` geprüft und die Fehlerfälle
angefasst (fehlendes Werkzeug, `--min=99,9`, `--bogus`). Kein Blocker.

**Abweichung von `CONTRIBUTING.md`, Schritt 3:** den Dev-Plan hat der Spec-Autor
geschrieben, nicht ein zweiter Autor. Der Umfang ist ein Wrapper mit drei Fällen; der
Reviewer hat ihn vollständig geprüft.

## Log

- **2026-11-23, angelegt.** Nach der Installation von `cargo-llvm-cov 0.9.2` und
  `llvm-tools`; die erste Messung ergab 92,92 % Zeilen, 94,62 % Funktionen,
  92,00 % Regionen über 3 658 Zeilen.

- **2026-11-23, Nachläufe aus dem Code-Review.** `percentageFrom` ist die einzige
  Funktion ohne Fall (Kommawert, unbekanntes Argument); relative `PATH`-Einträge
  würden gegen das aufrufende Arbeitsverzeichnis aufgelöst statt gegen das Repo; der
  Feldname `minimum` weicht vom Schwester-Skript (`minPercent`) ab.

- **2026-11-23, Stufe 3 nachgezogen, Spec `active`.** `CONTRIBUTING.md` nennt den
  zweiten Abdeckungsbefehl, `docs/64` schließt seine Lücke („war ohne Zahl, bis
  `docs/66` sie nachzog"), `docs/PROJECT-STATE.md` trägt 92,92 % Zeilen und
  `npm test` 584. Kein CI-Job: der Runner müsste beide Werkzeuge erst installieren.
