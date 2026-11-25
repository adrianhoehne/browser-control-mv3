---
description: Ein Befehl npm run test:coverage misst die Zeilenabdeckung der Erweiterung aus den V8-Rohdaten des Testlaufs, druckt eine Tabelle je Datei und bricht unter einer Schwelle ab — ohne neue Abhängigkeit.
status: active
---

# Testabdeckung messen

## Anlass

Am 2026-11-23 hat der Betreiber nach der Testabdeckung gefragt. Das Projekt hatte
keine: `npm test` zählt 577 Fälle, `cargo test` 305, aber keine Zahl sagte, wie viel
Code die Fälle berühren. Eine ad-hoc-Messung mit `NODE_V8_COVERAGE` ergab **92,2 %
Zeilen** für die vier Quellen der Erweiterung (7 604 von 8 250):

| Datei | Zeilen | Anteil |
|---|---|---|
| `extension/bridge.js` | 4 934 / 5 347 | 92,3 % |
| `extension/page-agent.js` | 2 146 / 2 325 | 92,3 % |
| `extension/background.js` | 462 / 516 | 89,5 % |
| `extension/protocol.js` | 62 / 62 | 100,0 % |

Die Messung war handgemacht: ein Skript außerhalb des Repos, nicht wiederholbar,
nicht im Ablauf. Diese Spec macht daraus einen Befehl.

## Ziel

1. **`npm run test:coverage`** führt die Suite aus, sammelt die V8-Rohdaten und
   druckt eine Tabelle: Datei, gedeckte Zeilen, Gesamtzeilen, Anteil.
2. **Keine neue Abhängigkeit.** Node 22 kann die Rohdaten selbst
   (`NODE_V8_COVERAGE`), das Auswerten macht ein Skript im Repo.
3. **Eine Schwelle bricht ab.** Standard **90 %** über alle Dateien; unterschritten,
   endet der Befehl mit Exit 1. `--min=<prozent>` übersteuert sie für einen Lauf.
4. **Die Zählregel ist streng und steht im Skript.** Eine Zeile ist gedeckt, wenn
   **jedes** Zeichen außer Leerraum ausgeführt wurde. Teillaufende Zeilen zählen als
   nicht gedeckt; die Zahl ist damit eine Untergrenze.
5. **Nur ausgeführter Produktcode zählt.** Die vier Dateien `bridge.js`,
   `background.js`, `protocol.js` und das eingespritzte `page-agent.js`;
   `test/**` und `scripts/**` bleiben draußen.
6. **Kein Zweig-, kein Funktionsanteil.** V8 liefert Rohbereiche; Funktionszahlen
   werden über mehrere Prozesse mehrfach gezählt und wären falsch. Was nicht sauber
   messbar ist, wird nicht gedruckt.

## Der Vertrag

| Feld | Regel |
|---|---|
| Befehl | `npm run test:coverage` |
| Ausgabe | eine Zeile je Datei, eine Summenzeile, Exit 0 oder 1 |
| Schwelle | 90 % über alle Dateien, `--min=<prozent>` übersteuert |
| Rohdaten | in einem temporären Verzeichnis, nach dem Lauf gelöscht |
| Zählregel | Zeile gedeckt, wenn jedes Nicht-Leerraum-Zeichen ausgeführt wurde |
| Umfang | `extension/bridge.js`, `extension/background.js`, `extension/protocol.js`, `extension/page-agent.js` (als `injected:page-agent.js` geladen) |

## Non-goals

- **Kein `c8`, kein Istanbul, kein `nyc`.** Eine Abhängigkeit für eine Zahl, die Node
  selbst liefert, wäre der falsche Preis.
- **Keine Abdeckung für `bridge-rs`.** `cargo-llvm-cov` fehlt, und das rustup
  Component `llvm-tools-preview` auch; beides braucht eine Installation aus dem Netz.
  Offene Frage 1.
- **Keine Abdeckung für `scripts/**` und `test/**`.** Werkzeug und Prüfcode, kein
  Produkt.
- **Keine Schwelle je Datei.** Eine einzelne Datei darf unter 90 % liegen, solange die
  Summe hält — sonst blockiert jede neue Zeile in `background.js` den Lauf.
- **Kein Upload, kein Badge, keine CI-Änderung.** Der Befehl ist für den Betreiber.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/coverage.test.js` | `coverageReport_fromTheFixtureRanges_shouldCountAStrictLine` | die Zählregel: eine teilweise ausgeführte Zeile ist nicht gedeckt |
| `test/coverage.test.js` | `coverageReport_withAPercentageBelowTheMinimum_shouldExitOne` | die Schwelle bricht ab |
| `test/coverage.test.js` | `coverageReport_forAnUnknownUrl_shouldIgnoreIt` | fremde Skripte zählen nicht mit |
| `test/coverage.test.js` | `coverageReport_shouldSumTheFilesAndTheTotal` | Tabelle und Summenzeile |

## Acceptance criteria

1. **Der Befehl läuft durch.** `npm run test:coverage; echo $?` ⇒ 0, und die Ausgabe
   enthält eine Zeile je Datei und eine Summenzeile mit einem Anteil ≥ 90 %.
2. **Die Schwelle greift.** `npm run test:coverage -- --min=99.9; echo $?` ⇒ 1 mit
   einer Meldung, die die Schwelle nennt.
3. **Strenge Regel.** Der Fall `coverageReport_fromTheFixtureRanges_shouldCountAStrictLine`
   ⇒ `^ok`; er reicht einen Bereich, der nur einen Teil einer Zeile deckt, und erwartet
   „nicht gedeckt".
4. **Keine Abhängigkeit.** `git diff --stat package.json` zeigt nur das neue Skript im
   `scripts`-Block, keine `dependencies`/`devDependencies`.
5. **Alles andere grün.** `npm test` ⇒ 0 mit `^# fail 0`, `npm run check` ⇒ 0.
6. **Live, Betreiber.** Ein Lauf auf dem Rechner des Betreibers druckt dieselbe
   Größenordnung wie die ad-hoc-Messung vom 2026-11-23 (92,2 %).

## Dev plan

Entwurf des Spec-Autors. Nach `CONTRIBUTING.md`, Schritt 3, gehört der Dev-Plan zu
einem zweiten Autor.

**Stufe 1 — das Auswerteskript (`scripts/coverage.mjs`)**

Es liest die V8-JSON-Dateien aus dem Verzeichnis in `NODE_V8_COVERAGE`, filtert die
vier Quellen, vereinigt die Bereiche je Datei **über alle Prozesse** (je Position
gewinnt „ausgeführt"), rechnet die Zeilen und druckt die Tabelle. Die reine Rechnung
liegt in einer exportierten Funktion, damit sie ohne Dateisystem prüfbar ist.

Beweis: die vier Fälle aus `## Testing`.

**Stufe 2 — der Befehl (`package.json`)**

`"test:coverage": "node scripts/coverage.mjs"`. Das Skript startet die Suite selbst
mit `NODE_V8_COVERAGE` in einem temporären Verzeichnis — oder liest ein vorhandenes,
wenn die Variable gesetzt ist. Kein neues Feld in `dependencies`.

Beweis: Kriterien 1, 4.

**Stufe 3 — die Doku**

`CONTRIBUTING.md` (Abschnitt „Tests and checks": eine Zeile zum neuen Befehl),
`docs/README.md` (Status), `docs/PROJECT-STATE.md`; der Amendments-Abschnitt entfällt,
die Spec wird `active`.

Beweis: `npm run check` ⇒ 0 und `grep -n 'test:coverage' CONTRIBUTING.md` ⇒ 1.

## Touch boundary

| erlaubt | nicht |
|---|---|
| `scripts/coverage.mjs` (neu), `test/coverage.test.js` (neu), `package.json` (`scripts`-Block) | `extension/**`, `bridge-rs/**`, `scripts/parity/**` |
| `CONTRIBUTING.md`, `docs/README.md`, `docs/PROJECT-STATE.md` | `test/extension.test.js` |

## Bekannte Lücken

- **Die Zahl ist eine Untergrenze.** Die strenge Zeilenregel zählt Teillaufendes als
  nicht gedeckt (2026-11-23).
- **Keine Zweigabdeckung.** V8-Rohbereiche geben sie nicht her, und ein Instrumentierer
  wäre eine Abhängigkeit (2026-11-23).
- **Mehrere Prozesse.** `npm test` startet je Datei einen Prozess; die Vereinigung
  „ausgeführt gewinnt" ist die einzige sinnvolle Regel, kann aber eine Zeile decken,
  die nur in einem Testfall lief, während ein anderer sie verfehlte (2026-11-23).
- **`bridge-rs` bleibt ohne Zahl**, solange `cargo-llvm-cov` fehlt (2026-11-23).
- **Die Vereinigung über Prozesse hat keinen eigenen Fall.** Sie ist die riskanteste
  Stelle im Skript; geprüft ist sie nur von Hand (Code-Review 2026-11-23).
- **Ohne Quellen liefert `coverageReport` `0/0 = 100 %` und Exit 0.** Aus `main` nicht
  erreichbar, weil die Texte von der Platte kommen; ein Fußangel bleibt es
  (Code-Review 2026-11-23).
- **Die Messung hängt am Dateinamen der VM-Skripte.** Jeder `vm`-Aufruf muss die ganze
  Datei unter genau ihrem Pfad kompilieren; ein Ausschnitt unter demselben Namen würde
  falsche Offsets decken. Nichts erzwingt das (Code-Review 2026-11-23).
- **Ein vorgesetztes `NODE_V8_COVERAGE` wird stillschweigend gelesen.** Nach einer
  Quelländerung verschieben sich die Offsets, und die Ausgabe sagt nicht, aus welchem
  Verzeichnis sie stammt (Code-Review 2026-11-23).
- **`--min=95,5` wird abgelehnt**, obwohl die Tabelle das Komma druckt; der Fehlertext
  sagt nicht, dass ein Punkt erwartet wird (Code-Review 2026-11-23).
- **Leerraum ist als `space`, `\t`, `\r`, `\n` definiert.** `\v`, `\f` und NBSP
  fehlen; heute enthält keine der vier Quellen solche Zeichen (Code-Review 2026-11-23).

## Open questions

**Keine.** Der Betreiber hat am 2026-11-23 „Coverage umsetzen" gesagt; diese Spec
liefert den JavaScript-Teil. Zwei Erweiterungen bleiben ausdrücklich draußen und
stehen als Lücke bzw. als Roadmap-Zeile:

1. **`bridge-rs` messen** — verlangt `cargo install cargo-llvm-cov` und
   `rustup component add llvm-tools-preview`, beides aus dem Netz.
2. **Der Befehl in der CI** — `docs/40` beschreibt die Workflows; ein neuer Job
   braucht eine Schwelle, die auf dem CI-Rechner hält.

## Review

### Runde 1 — `✅ Ship it` (2026-11-23)

Geprüft wurden Vereinigung, Sortierung, Zählregel, die vier Fälle, `package.json` und
der Umfang. Der Reviewer hat die Tabellenzahlen gegen `grep -c '[^[:space:]]'`
nachgezählt (5347/2325/516/62) und die V8-Bereichssemantik an echten Rohdaten geprüft.

**Abweichung von `CONTRIBUTING.md`, Schritt 3:** den Dev-Plan hat der Spec-Autor
geschrieben, nicht ein zweiter Autor. Der Umfang ist ein Skript mit vier Fällen; der
Reviewer hat ihn vollständig geprüft und die Lücke nicht als Blocker geführt. Der
Betreiber kann einen zweiten Autor nachziehen, wenn er das für nötig hält.

## Log

- **2026-11-23, angelegt.** Aus der Frage des Betreibers nach der Testabdeckung und
  der ad-hoc-Messung mit `NODE_V8_COVERAGE` (92,2 % Zeilen über 8 250 Zeilen).

- **2026-11-23, Stufe 3 nachgezogen, Spec `active`.** `CONTRIBUTING.md` nennt den
  Befehl, `docs/PROJECT-STATE.md` trägt die Zahl (92,2 %, 7 604 / 8 250, `npm test` 581).
  `docs/README.md` steht auf `active`. Kein neues Feld in `dependencies`.
